//! 需要 MySQL 的集成测试（`#[ignore]`）：
//!
//! ```bash
//! TEST_DATABASE_URL=mysql://root:root@127.0.0.1:33306/ip_please_test cargo test -- --ignored
//! ```

mod common;

use std::collections::HashMap;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::*;
use ip_please_sync::util::{random_b64url, sha256_b64url};
use ip_please_sync::AppState;

const CLIENT_ID: &str = "app_test_client_0001";

struct Login {
    access_token: String,
    refresh_token: String,
    body: Value,
}

/// 走一遍完整登录：/auth/login → 模拟 IdP 发码 → /auth/callback。
async fn login(state: &AppState, idp: &MockIdp, subject: &str, sid: &str, roles: &[&str]) -> Login {
    let verifier = random_b64url(32);
    let reply = call(
        state,
        "POST",
        "/anthropic/v1/auth/login",
        None,
        Some(json!({"login_challenge": sha256_b64url(verifier.as_bytes())})),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    let url = reqwest::Url::parse(reply.body["authorize_url"].as_str().unwrap()).unwrap();
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(params["state"], reply.body["state"].as_str().unwrap());

    let code = format!("code-{}", random_b64url(6));
    idp.codes.lock().unwrap().insert(
        code.clone(),
        PendingCode {
            nonce: params["nonce"].clone(),
            code_challenge: params["code_challenge"].clone(),
            subject: subject.into(),
            sid: sid.into(),
            roles: roles.iter().map(|r| r.to_string()).collect(),
        },
    );
    let issuer = idp.issuer.lock().unwrap().clone();
    let reply = call(
        state,
        "POST",
        "/anthropic/v1/auth/callback",
        None,
        Some(json!({
            "code": code, "state": params["state"], "login_verifier": verifier, "iss": issuer,
        })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    Login {
        access_token: reply.body["access_token"].as_str().unwrap().to_string(),
        refresh_token: reply.body["refresh_token"].as_str().unwrap().to_string(),
        body: reply.body,
    }
}

fn unique(label: &str) -> String {
    format!("{label}-{}", random_b64url(6))
}

#[tokio::test]
#[ignore]
async fn migrations_are_idempotent() {
    let (issuer, _idp) = start_mock_idp(CLIENT_ID).await;
    let (_state, pool) = db_state(&issuer).await;
    ip_please_sync::db::migrate(&pool)
        .await
        .expect("second run");
    ip_please_sync::db::migrate(&pool).await.expect("third run");
}

#[tokio::test]
#[ignore]
async fn login_refresh_reuse_and_logout() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, pool) = db_state(&issuer).await;
    let subject = unique("kc-user");
    let first = login(&state, &idp, &subject, &unique("kc-sid"), &[]).await;

    let body = &first.body;
    assert_eq!(body["token_type"], "Bearer");
    assert_eq!(body["expires_in"], 600);
    assert!(body["session_id"].as_str().unwrap().starts_with("sess_"));
    assert!(body["user"]["nickname"]
        .as_str()
        .unwrap()
        .starts_with("审查员-"));
    assert_eq!(body["user"]["is_admin"], false);
    assert_eq!(body["refresh_token"].as_str().unwrap().len(), 43);

    // 同一 IdP 用户再次登录 → 同一个 user_id、不同会话
    let second = login(&state, &idp, &subject, &unique("kc-sid"), &[]).await;
    assert_eq!(
        second.body["user"]["user_id"],
        first.body["user"]["user_id"]
    );
    assert_ne!(second.body["session_id"], first.body["session_id"]);

    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&first.access_token),
        None,
    )
    .await;
    assert_eq!(me.status, StatusCode::OK, "{}", me.text);
    assert_eq!(me.body["session"]["session_id"], first.body["session_id"]);
    assert_eq!(
        me.headers.get("cache-control").unwrap(),
        "private, no-store"
    );

    // 日终同步用新的 AT
    let save = call(
        &state,
        "POST",
        "/anthropic/v1/sync/save",
        Some(&first.access_token),
        Some(json!({"day": 2, "payload": {"day": 2, "plot": {}}, "base_version": 0})),
    )
    .await;
    assert!(
        save.status == StatusCode::OK || save.status == StatusCode::CONFLICT,
        "{}",
        save.text
    );

    // 刷新：拿到新 RT
    let refreshed = call(
        &state,
        "POST",
        "/anthropic/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": first.refresh_token})),
    )
    .await;
    assert_eq!(refreshed.status, StatusCode::OK, "{}", refreshed.text);
    let rotated = refreshed.body["refresh_token"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(rotated, first.refresh_token);

    // 宽限期内重放旧 RT → invalid_token（会话不吊销）
    let stale = call(
        &state,
        "POST",
        "/anthropic/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": first.refresh_token})),
    )
    .await;
    assert_auth_error(&stale, StatusCode::UNAUTHORIZED, "invalid_token");
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&first.access_token),
        None,
    )
    .await;
    assert_eq!(me.status, StatusCode::OK);

    // 把旧 RT 的使用时间改到宽限期之前 → 重放即泄露，吊销整个会话
    sqlx::query(
        "UPDATE ip_please_refresh_tokens SET used_at_ms = used_at_ms - 60000 WHERE token_hash = ?",
    )
    .bind(ip_please_sync::auth::tokens::refresh_token_hash(
        &first.refresh_token,
    ))
    .execute(&pool)
    .await
    .unwrap();
    let reuse = call(
        &state,
        "POST",
        "/anthropic/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": first.refresh_token})),
    )
    .await;
    assert_auth_error(&reuse, StatusCode::UNAUTHORIZED, "token_revoked");
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&first.access_token),
        None,
    )
    .await;
    assert_auth_error(&me, StatusCode::UNAUTHORIZED, "token_revoked");
    let after = call(
        &state,
        "POST",
        "/anthropic/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": rotated})),
    )
    .await;
    assert_auth_error(&after, StatusCode::UNAUTHORIZED, "token_revoked");

    // 另一个会话不受影响；登出后失效
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&second.access_token),
        None,
    )
    .await;
    assert_eq!(me.status, StatusCode::OK);
    let out = call(
        &state,
        "POST",
        "/anthropic/v1/auth/logout",
        None,
        Some(json!({"refresh_token": second.refresh_token})),
    )
    .await;
    assert_eq!(out.status, StatusCode::OK);
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&second.access_token),
        None,
    )
    .await;
    assert_auth_error(&me, StatusCode::UNAUTHORIZED, "token_revoked");
}

#[tokio::test]
#[ignore]
async fn callback_rejects_wrong_verifier_and_replayed_state() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, _pool) = db_state(&issuer).await;
    let verifier = random_b64url(32);
    let reply = call(
        &state,
        "POST",
        "/anthropic/v1/auth/login",
        None,
        Some(json!({"login_challenge": sha256_b64url(verifier.as_bytes())})),
    )
    .await;
    let url = reqwest::Url::parse(reply.body["authorize_url"].as_str().unwrap()).unwrap();
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    idp.codes.lock().unwrap().insert(
        "code-x".into(),
        PendingCode {
            nonce: params["nonce"].clone(),
            code_challenge: params["code_challenge"].clone(),
            subject: unique("kc"),
            sid: unique("sid"),
            roles: vec![],
        },
    );
    // 拿到 code+state 但没有浏览器的 verifier → 拒绝，且 state 已作废
    let stolen = call(
        &state,
        "POST",
        "/anthropic/v1/auth/callback",
        None,
        Some(json!({"code": "code-x", "state": params["state"], "login_verifier": random_b64url(32)})),
    )
    .await;
    assert_detail(
        &stolen,
        StatusCode::BAD_REQUEST,
        "The login attempt is invalid or has expired.",
    );
    let replay = call(
        &state,
        "POST",
        "/anthropic/v1/auth/callback",
        None,
        Some(json!({"code": "code-x", "state": params["state"], "login_verifier": verifier})),
    )
    .await;
    assert_detail(
        &replay,
        StatusCode::BAD_REQUEST,
        "The login attempt is invalid or has expired.",
    );
}

#[tokio::test]
#[ignore]
async fn backchannel_logout_revokes_matching_idp_session() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, _pool) = db_state(&issuer).await;
    let subject = unique("kc-user");
    let sid_a = unique("kc-sid");
    let a = login(&state, &idp, &subject, &sid_a, &[]).await;
    let b = login(&state, &idp, &subject, &unique("kc-sid"), &[]).await;

    let token = sign(&json!({
        "iss": issuer, "aud": CLIENT_ID, "iat": now_secs(), "jti": unique("jti"),
        "sub": subject, "sid": sid_a,
        "events": { "http://schemas.openid.net/event/backchannel-logout": {} },
    }));
    let reply = call_raw(
        &state,
        "POST",
        "/anthropic/v1/auth/backchannel-logout",
        "application/x-www-form-urlencoded",
        format!("logout_token={token}").into_bytes(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    assert_eq!(
        reply.headers.get("cache-control").unwrap(),
        "private, no-store"
    );

    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&a.access_token),
        None,
    )
    .await;
    assert_auth_error(&me, StatusCode::UNAUTHORIZED, "token_revoked");
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&b.access_token),
        None,
    )
    .await;
    assert_eq!(
        me.status,
        StatusCode::OK,
        "other IdP session stays logged in"
    );

    // 只有 sub：吊销该用户全部会话
    let token = sign(&json!({
        "iss": issuer, "aud": CLIENT_ID, "iat": now_secs(), "jti": unique("jti"),
        "sub": subject,
        "events": { "http://schemas.openid.net/event/backchannel-logout": {} },
    }));
    let reply = call_raw(
        &state,
        "POST",
        "/anthropic/v1/auth/backchannel-logout",
        "application/x-www-form-urlencoded",
        format!("logout_token={token}").into_bytes(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&b.access_token),
        None,
    )
    .await;
    assert_auth_error(&me, StatusCode::UNAUTHORIZED, "token_revoked");
}

#[tokio::test]
#[ignore]
async fn admin_role_and_profile() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, _pool) = db_state(&issuer).await;
    let admin = login(
        &state,
        &idp,
        &unique("kc-admin"),
        &unique("sid"),
        &["ip-please-admin"],
    )
    .await;
    assert_eq!(admin.body["user"]["is_admin"], true);
    let player = login(
        &state,
        &idp,
        &unique("kc-player"),
        &unique("sid"),
        &["other"],
    )
    .await;
    assert_eq!(player.body["user"]["is_admin"], false);

    // 非管理员不能强制下线
    let target = player.body["user"]["user_id"].as_str().unwrap().to_string();
    let denied = call(
        &state,
        "POST",
        "/anthropic/v1/admin/sessions/revoke",
        Some(&player.access_token),
        Some(json!({"user_id": target})),
    )
    .await;
    assert_auth_error(&denied, StatusCode::FORBIDDEN, "insufficient_scope");

    // 改昵称
    let bad = call(
        &state,
        "POST",
        "/anthropic/v1/me/profile",
        Some(&player.access_token),
        Some(json!({"nickname": "官方客服"})),
    )
    .await;
    assert_detail(
        &bad,
        StatusCode::BAD_REQUEST,
        "The nickname is not allowed.",
    );
    let ok = call(
        &state,
        "POST",
        "/anthropic/v1/me/profile",
        Some(&player.access_token),
        Some(json!({"nickname": " 小鱼干 "})),
    )
    .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text);
    assert_eq!(ok.body["nickname"], "小鱼干");
    assert_eq!(ok.body["nickname_set"], true);

    // 管理员强制下线
    let revoked = call(
        &state,
        "POST",
        "/anthropic/v1/admin/sessions/revoke",
        Some(&admin.access_token),
        Some(json!({"user_id": target})),
    )
    .await;
    assert_eq!(revoked.status, StatusCode::OK, "{}", revoked.text);
    assert_eq!(revoked.body["revoked"], 1);
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&player.access_token),
        None,
    )
    .await;
    assert_auth_error(&me, StatusCode::UNAUTHORIZED, "token_revoked");
}

#[tokio::test]
#[ignore]
async fn announcements_lifecycle() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, _pool) = db_state(&issuer).await;
    let admin = login(
        &state,
        &idp,
        &unique("kc-admin"),
        &unique("sid"),
        &["ip-please-admin"],
    )
    .await;
    let player = login(&state, &idp, &unique("kc-player"), &unique("sid"), &[]).await;
    let title = format!("<b>维护</b> {}", random_b64url(4));

    let denied = call(
        &state,
        "POST",
        "/anthropic/v1/admin/announcements",
        Some(&player.access_token),
        Some(json!({"title": title, "body": "x"})),
    )
    .await;
    assert_auth_error(&denied, StatusCode::FORBIDDEN, "insufficient_scope");

    let created = call(
        &state,
        "POST",
        "/anthropic/v1/admin/announcements",
        Some(&admin.access_token),
        Some(json!({"title": title, "body": "今晚 22:00\n停机维护", "level": "maintenance"})),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let id = created.body["announcement_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(id.starts_with("ann_"));
    assert_eq!(
        created.body["title"], title,
        "stored verbatim; the client renders text"
    );

    let public = call(&state, "GET", "/anthropic/v1/announcements", None, None).await;
    assert_eq!(public.status, StatusCode::OK);
    assert_eq!(
        public.headers.get("cache-control").unwrap(),
        "private, no-store"
    );
    let listed = public.body["announcements"].as_array().unwrap();
    let found = listed
        .iter()
        .find(|item| item["announcement_id"] == id.as_str())
        .expect("listed");
    assert!(
        found.get("created_by").is_none(),
        "public view hides admin fields"
    );

    let bad = call(
        &state,
        "POST",
        "/anthropic/v1/admin/announcements",
        Some(&admin.access_token),
        Some(json!({"title": "t", "body": "b", "level": "urgent"})),
    )
    .await;
    assert_detail(&bad, StatusCode::BAD_REQUEST, "The request is invalid.");

    let retired = call(
        &state,
        "POST",
        &format!("/anthropic/v1/admin/announcements/{id}/retire"),
        Some(&admin.access_token),
        None,
    )
    .await;
    assert_eq!(retired.status, StatusCode::OK, "{}", retired.text);
    assert!(retired.body["retired_at"].is_string());

    let public = call(&state, "GET", "/anthropic/v1/announcements", None, None).await;
    assert!(!public.body["announcements"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["announcement_id"] == id.as_str()));

    let admin_list = call(
        &state,
        "GET",
        "/anthropic/v1/admin/announcements?include_retired=1",
        Some(&admin.access_token),
        None,
    )
    .await;
    assert!(admin_list.body["announcements"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["announcement_id"] == id.as_str()));

    let missing = call(
        &state,
        "POST",
        "/anthropic/v1/admin/announcements/ann_doesnotexist0000000000/retire",
        Some(&admin.access_token),
        None,
    )
    .await;
    assert_detail(
        &missing,
        StatusCode::NOT_FOUND,
        "The requested resource was not found.",
    );
    let malformed = call(
        &state,
        "POST",
        "/anthropic/v1/admin/announcements/12345/retire",
        Some(&admin.access_token),
        None,
    )
    .await;
    assert_detail(
        &malformed,
        StatusCode::NOT_FOUND,
        "The requested resource was not found.",
    );
}
