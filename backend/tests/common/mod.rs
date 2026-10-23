//! 集成测试公用：测试配置、固定 RSA 密钥的「IdP」、请求工具。
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Form, Json, Router};
use jsonwebtoken::{encode, Algorithm, DecodingKey, EncodingKey, Header};
use serde_json::{json, Value};
use sqlx::mysql::MySqlPoolOptions;
use sqlx::MySqlPool;
use tower::ServiceExt;

use ip_please_sync::auth::jwks::{Endpoints, JwksCache};
use ip_please_sync::config::Config;
use ip_please_sync::util::{now_ms, sha256_b64url, unix_secs};
use ip_please_sync::{build_app, AppState};

pub const PRIVATE_PEM: &[u8] = include_bytes!("../fixtures/test_rsa_private.pem");
pub const PUBLIC_PEM: &[u8] = include_bytes!("../fixtures/test_rsa_public.pem");
pub const KID: &str = "test-key";

pub fn sign(claims: &Value) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(KID.into());
    encode(
        &header,
        claims,
        &EncodingKey::from_rsa_pem(PRIVATE_PEM).expect("private key"),
    )
    .expect("sign")
}

pub fn now_secs() -> i64 {
    unix_secs(now_ms())
}

/// 模拟 IdP 的授权码：换码时校验 PKCE 与 client secret，签发带 nonce 的 ID Token。
#[derive(Clone, Debug)]
pub struct PendingCode {
    pub nonce: String,
    pub code_challenge: String,
    pub subject: String,
    pub sid: String,
    pub roles: Vec<String>,
}

#[derive(Clone, Default)]
pub struct MockIdp {
    pub codes: Arc<Mutex<HashMap<String, PendingCode>>>,
    pub issuer: Arc<Mutex<String>>,
    pub client_id: Arc<Mutex<String>>,
}

async fn mock_token(
    State(idp): State<MockIdp>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> impl IntoResponse {
    let client_id = idp.client_id.lock().unwrap().clone();
    let expected_basic = format!(
        "Basic {}",
        base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            format!("{client_id}:test-client-secret")
        )
    );
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(expected_basic.as_str()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid_client"})),
        )
            .into_response();
    }
    let code = form.get("code").cloned().unwrap_or_default();
    let Some(pending) = idp.codes.lock().unwrap().remove(&code) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_grant"})),
        )
            .into_response();
    };
    let verifier = form.get("code_verifier").cloned().unwrap_or_default();
    if sha256_b64url(verifier.as_bytes()) != pending.code_challenge {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_grant"})),
        )
            .into_response();
    }
    let issuer = idp.issuer.lock().unwrap().clone();
    let id_token = sign(&json!({
        "iss": issuer, "aud": client_id, "azp": client_id,
        "sub": pending.subject, "sid": pending.sid, "nonce": pending.nonce,
        "iat": now_secs(), "exp": now_secs() + 300,
        "name": format!("玩家 {}", pending.subject),
        "picture": format!("https://avatars.test/{}.png", pending.subject),
    }));
    let access_token = sign(&json!({
        "iss": issuer, "aud": "account", "azp": client_id,
        "sub": pending.subject, "sid": pending.sid,
        "iat": now_secs(), "exp": now_secs() + 300,
        "resource_access": { client_id.clone(): { "roles": pending.roles } },
    }));
    Json(json!({
        "access_token": access_token, "id_token": id_token, "token_type": "Bearer",
        "expires_in": 300, "refresh_token": "idp-refresh-not-used",
    }))
    .into_response()
}

/// 启动模拟 IdP，返回 (issuer, 句柄)。
pub async fn start_mock_idp(client_id: &str) -> (String, MockIdp) {
    let idp = MockIdp::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let issuer = format!("http://{addr}/realms/test");
    *idp.issuer.lock().unwrap() = issuer.clone();
    *idp.client_id.lock().unwrap() = client_id.to_string();
    let app = Router::new()
        .route("/realms/test/token", post(mock_token))
        .with_state(idp.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (issuer, idp)
}

pub fn jwks_for(issuer: &str) -> JwksCache {
    let endpoints = Endpoints {
        issuer: issuer.to_string(),
        jwks_uri: format!("{issuer}/certs"),
        authorization_endpoint: format!("{issuer}/auth"),
        token_endpoint: format!("{issuer}/token"),
    };
    let mut keys = HashMap::new();
    keys.insert(
        KID.to_string(),
        DecodingKey::from_rsa_pem(PUBLIC_PEM).expect("public key"),
    );
    JwksCache::with_fixed_keys(issuer, endpoints, keys).expect("jwks")
}

/// 不连库的应用（只测数据库之前就会返回的路径）。
pub fn offline_state() -> AppState {
    let issuer = "https://idp.test/realms/t";
    let config = Config::for_tests("mysql://nobody:nothing@127.0.0.1:1/none", issuer);
    let pool = MySqlPoolOptions::new()
        .acquire_timeout(Duration::from_millis(300))
        .connect_lazy(&config.database_url)
        .expect("lazy pool");
    AppState::new(Arc::new(config), pool, Arc::new(jwks_for(issuer)))
}

/// 连真实 MySQL（`TEST_DATABASE_URL`）的应用，并跑一遍迁移。
pub async fn db_state(issuer: &str) -> (AppState, MySqlPool) {
    let url = std::env::var("TEST_DATABASE_URL")
        .expect("TEST_DATABASE_URL must point at a disposable MySQL database");
    let pool = MySqlPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("connect test database");
    ip_please_sync::db::migrate(&pool).await.expect("migrate");
    let config = Config::for_tests(&url, issuer);
    let mut state = AppState::new(Arc::new(config), pool.clone(), Arc::new(jwks_for(issuer)));
    // 集成测试一秒内会发很多请求；限流本身由 router.rs 覆盖
    state.limiter = Arc::new(ip_please_sync::ratelimit::RateLimiter::disabled());
    (state, pool)
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
    pub text: String,
}

pub async fn call(
    state: &AppState,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Reply {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("x-real-ip", "203.0.113.7");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let request = match body {
        Some(body) => builder
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    send(state, request).await
}

pub async fn call_raw(
    state: &AppState,
    method: &str,
    path: &str,
    content_type: &str,
    body: Vec<u8>,
) -> Reply {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("x-real-ip", "203.0.113.8")
        .header("content-type", content_type)
        .body(Body::from(body))
        .unwrap();
    send(state, request).await
}

async fn send(state: &AppState, request: Request<Body>) -> Reply {
    let response = build_app(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&bytes).to_string();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Reply {
        status,
        headers,
        body,
        text,
    }
}

/// 断言 Detail 信封。
pub fn assert_detail(reply: &Reply, status: StatusCode, message: &str) {
    assert_eq!(reply.status, status, "body: {}", reply.text);
    assert_eq!(
        reply.body,
        json!({ "detail": message }),
        "body: {}",
        reply.text
    );
    assert_eq!(
        reply.headers.get("cache-control").unwrap(),
        "private, no-store"
    );
}

/// 断言 Auth 信封。
pub fn assert_auth_error(reply: &Reply, status: StatusCode, code: &str) {
    assert_eq!(reply.status, status, "body: {}", reply.text);
    assert_eq!(reply.body["error"]["code"], code, "body: {}", reply.text);
    assert_eq!(reply.body["status"], status.as_u16());
}
