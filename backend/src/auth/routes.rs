//! `/anthropic/v1/auth/*` 与管理员会话接口。
//!
//! 登录流程（浏览器不再直接向 IdP 换 Token）：
//! 1. 前端生成 `login_verifier`，`POST /auth/login {login_challenge = b64url(SHA256(verifier))}`；
//!    后端保存 state / nonce / PKCE verifier，返回 IdP 授权地址。
//! 2. IdP 回跳游戏页面，前端 `POST /auth/callback {code, state, login_verifier, iss}`；
//!    后端校验浏览器持有 verifier（防止 code+state 泄露后被他人兑换），
//!    在服务器端换码、校验 ID Token，建立 `sess_*` 会话，返回本服务的 AT/RT。

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use subtle::ConstantTimeEq;

use crate::auth::oidc::{self, ExchangeError};
use crate::auth::session::{self, Issued, NewSession};
use crate::auth::tokens::is_refresh_token_shape;
use crate::auth::AdminUser;
use crate::db;
use crate::error::{private_json, AppError, AuthErrorCode, DetailCode};
use crate::extract::{FormBody, JsonBody};
use crate::ids;
use crate::profile;
use crate::ratelimit;
use crate::util::{is_b64url, now_ms, random_b64url, sha256_b64url, sha256_hex, unix_secs};
use crate::{client_ip, AppState};

const LOGIN_ATTEMPT_TTL_MS: i64 = 10 * 60 * 1000;

/// 签发 AT 并组装 TokenResponse。
async fn token_response(state: &AppState, issued: &Issued) -> Result<Response, AppError> {
    let now_secs = unix_secs(now_ms());
    let (access_token, expires_at) =
        state
            .tokens
            .issue(&issued.user_id, &issued.session_id, now_secs);
    let profile = profile::load(&state.pool, &issued.user_id).await?;
    Ok(private_json(
        StatusCode::OK,
        json!({
            "token_type": "Bearer",
            "access_token": access_token,
            "expires_in": state.tokens.ttl_secs(),
            "expires_at": expires_at,
            "refresh_token": issued.refresh_token,
            "refresh_expires_at": unix_secs(issued.refresh_expires_at_ms),
            "session_id": issued.session_id,
            "session_expires_at": unix_secs(issued.session_expires_at_ms),
            "user": profile::user_json(&issued.user_id, &profile, issued.is_admin),
        }),
    ))
}

// ———————————————————— 发起登录 ————————————————————

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    login_challenge: String,
    #[serde(default)]
    redirect_uri: Option<String>,
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    JsonBody(request): JsonBody<LoginRequest>,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(ratelimit::AUTH_LOGIN, &client_ip(&state, &headers))?;
    if !is_b64url(&request.login_challenge, 43, 43) {
        return Err(AppError::Detail(DetailCode::ValidationError));
    }
    let redirect_uri = match request.redirect_uri {
        Some(uri) if state.config.oidc_redirect_uris.contains(&uri) => uri,
        Some(_) => return Err(AppError::Detail(DetailCode::ValidationError)),
        None => state.config.oidc_redirect_uris[0].clone(),
    };
    let endpoints = state.jwks.endpoints().await.map_err(|err| {
        tracing::error!(error = ?err, "OIDC discovery failed");
        AppError::Auth(AuthErrorCode::SessionValidationFailed)
    })?;

    let login_state = random_b64url(32);
    let nonce = random_b64url(32);
    let code_verifier = random_b64url(48);
    let now = now_ms();
    let expires_at = now + LOGIN_ATTEMPT_TTL_MS;
    sqlx::query(
        "INSERT INTO ip_please_login_attempts
            (state_hash, login_challenge, code_verifier, nonce, redirect_uri, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(sha256_hex(login_state.as_bytes()))
    .bind(&request.login_challenge)
    .bind(&code_verifier)
    .bind(&nonce)
    .bind(&redirect_uri)
    .bind(now)
    .bind(expires_at)
    .execute(&state.pool)
    .await
    .map_err(AppError::db)?;

    let authorize_url = oidc::authorize_url(
        &endpoints.authorization_endpoint,
        &state.config,
        &redirect_uri,
        &login_state,
        &nonce,
        &sha256_b64url(code_verifier.as_bytes()),
    )
    .map_err(AppError::Internal)?;

    Ok(private_json(
        StatusCode::OK,
        json!({
            "authorize_url": authorize_url,
            "state": login_state,
            "expires_at": unix_secs(expires_at),
        }),
    ))
}

// ———————————————————— 回调换码 ————————————————————

#[derive(Debug, Deserialize)]
pub struct CallbackRequest {
    code: String,
    state: String,
    login_verifier: String,
    #[serde(default)]
    iss: Option<String>,
}

struct LoginAttempt {
    login_challenge: String,
    code_verifier: String,
    nonce: String,
    redirect_uri: String,
    expires_at_ms: i64,
}

/// 取出并删除登录尝试（单次使用）。
async fn take_login_attempt(
    state: &AppState,
    login_state: &str,
) -> Result<Option<LoginAttempt>, AppError> {
    let state_hash = sha256_hex(login_state.as_bytes());
    let mut tx = state.pool.begin().await.map_err(AppError::db)?;
    let row = sqlx::query(
        "SELECT login_challenge, code_verifier, nonce, redirect_uri, expires_at_ms
         FROM ip_please_login_attempts WHERE state_hash = ? FOR UPDATE",
    )
    .bind(&state_hash)
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::db)?;
    let Some(row) = row else {
        return Ok(None);
    };
    sqlx::query("DELETE FROM ip_please_login_attempts WHERE state_hash = ?")
        .bind(&state_hash)
        .execute(&mut *tx)
        .await
        .map_err(AppError::db)?;
    tx.commit().await.map_err(AppError::db)?;
    Ok(Some(LoginAttempt {
        login_challenge: row.try_get("login_challenge").map_err(AppError::db)?,
        code_verifier: row.try_get("code_verifier").map_err(AppError::db)?,
        nonce: row.try_get("nonce").map_err(AppError::db)?,
        redirect_uri: row.try_get("redirect_uri").map_err(AppError::db)?,
        expires_at_ms: row.try_get("expires_at_ms").map_err(AppError::db)?,
    }))
}

pub async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    JsonBody(request): JsonBody<CallbackRequest>,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(ratelimit::AUTH_LOGIN, &client_ip(&state, &headers))?;
    let invalid = || AppError::Detail(DetailCode::LoginAttemptInvalid);
    if request.code.is_empty()
        || request.code.len() > 4096
        || !is_b64url(&request.state, 43, 43)
        || !is_b64url(&request.login_verifier, 43, 128)
    {
        return Err(AppError::Detail(DetailCode::ValidationError));
    }

    let attempt = take_login_attempt(&state, &request.state)
        .await?
        .ok_or_else(invalid)?;
    let now = now_ms();
    if now >= attempt.expires_at_ms {
        return Err(invalid());
    }
    let presented = sha256_b64url(request.login_verifier.as_bytes());
    if !bool::from(
        presented
            .as_bytes()
            .ct_eq(attempt.login_challenge.as_bytes()),
    ) {
        return Err(invalid());
    }
    // RFC 9207：IdP 回跳带 iss 时必须是本服务配置的 issuer。
    if let Some(iss) = &request.iss {
        if iss.trim_end_matches('/') != state.config.oidc_issuer {
            return Err(invalid());
        }
    }

    let tokens = oidc::exchange_code(
        &state.jwks,
        &state.config,
        &request.code,
        &attempt.redirect_uri,
        &attempt.code_verifier,
    )
    .await
    .map_err(|err| match err {
        ExchangeError::Rejected(reason) => {
            tracing::warn!(reason = %reason, "IdP rejected authorization code");
            invalid()
        }
        ExchangeError::Unavailable(err) => {
            tracing::error!(error = ?err, "IdP token endpoint unavailable");
            AppError::Auth(AuthErrorCode::SessionValidationFailed)
        }
    })?;

    let mut identity =
        oidc::verify_id_token(&state.jwks, &state.config, &tokens.id_token, &attempt.nonce).await?;
    if let Some(access_token) = &tokens.access_token {
        identity
            .roles
            .extend(oidc::roles_from_access_token(&state.jwks, &state.config, access_token).await);
    }
    let is_admin = identity
        .roles
        .iter()
        .any(|role| role == &state.config.oidc_admin_role);

    let user_id = db::resolve_user_id(&state.pool, &identity.subject).await?;
    let issued = session::create(
        &state.pool,
        &state.config,
        NewSession {
            user_id: &user_id,
            subject: &identity.subject,
            idp_sid: identity.idp_sid.as_deref(),
            is_admin,
        },
        now,
    )
    .await?;
    tracing::info!(
        user_id = %user_id,
        session_id = %issued.session_id,
        is_admin,
        has_idp_sid = identity.idp_sid.is_some(),
        "session created"
    );
    token_response(&state, &issued).await
}

// ———————————————————— 刷新 / 登出 ————————————————————

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    refresh_token: String,
}

pub async fn refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    JsonBody(request): JsonBody<RefreshRequest>,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(ratelimit::AUTH_REFRESH, &client_ip(&state, &headers))?;
    if !is_refresh_token_shape(&request.refresh_token) {
        return Err(AppError::Auth(AuthErrorCode::TokenRevoked));
    }
    let issued =
        session::refresh(&state.pool, &state.config, &request.refresh_token, now_ms()).await?;
    token_response(&state, &issued).await
}

#[derive(Debug, Deserialize)]
pub struct LogoutRequest {
    refresh_token: String,
    #[serde(default)]
    all_sessions: bool,
}

/// 登出：吊销 RT 所属会话（或该用户全部会话）。未知 RT 也返回成功，避免探测。
pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    JsonBody(request): JsonBody<LogoutRequest>,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(ratelimit::AUTH_REFRESH, &client_ip(&state, &headers))?;
    if is_refresh_token_shape(&request.refresh_token) {
        if let Some((session_id, user_id)) =
            session::session_for_refresh_token(&state.pool, &request.refresh_token).await?
        {
            let now = now_ms();
            if request.all_sessions {
                session::revoke_user(&state.pool, &user_id, "logout_all", now).await?;
            } else {
                session::revoke(&state.pool, &session_id, "logout", now).await?;
            }
        }
    }
    Ok(private_json(StatusCode::OK, json!({ "status": "ok" })))
}

// ———————————————————— 反向通道注销 ————————————————————

#[derive(Debug, Deserialize)]
pub struct BackchannelForm {
    logout_token: String,
}

/// OIDC Back-Channel Logout：IdP（服务器对服务器）通知某个 IdP 会话已注销。
pub async fn backchannel_logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    FormBody(form): FormBody<BackchannelForm>,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(ratelimit::AUTH_BACKCHANNEL, &client_ip(&state, &headers))?;
    let request = oidc::verify_logout_token(
        &state.jwks,
        &state.config,
        &state.jti,
        &form.logout_token,
        unix_secs(now_ms()),
    )
    .await?;
    let revoked = session::revoke_for_idp(
        &state.pool,
        request.sid.as_deref(),
        request.subject.as_deref(),
        now_ms(),
    )
    .await
    .map_err(|err| {
        tracing::error!(error = ?err, "backchannel revoke failed");
        AppError::Detail(DetailCode::BackendUnavailable)
    })?;
    tracing::info!(
        revoked,
        by_sid = request.sid.is_some(),
        "backchannel logout processed"
    );
    Ok(private_json(StatusCode::OK, json!({ "status": "ok" })))
}

// ———————————————————— 管理员：强制下线 ————————————————————

#[derive(Debug, Deserialize)]
pub struct AdminRevokeRequest {
    user_id: String,
}

pub async fn admin_revoke_sessions(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    JsonBody(request): JsonBody<AdminRevokeRequest>,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(ratelimit::ADMIN_WRITE, &admin.user_id)?;
    ids::require(&request.user_id, ids::PREFIX_USER)?;
    let revoked = session::revoke_user(&state.pool, &request.user_id, "admin", now_ms()).await?;
    tracing::info!(admin = %admin.user_id, target = %request.user_id, revoked, "admin revoked sessions");
    Ok(private_json(StatusCode::OK, json!({ "revoked": revoked })))
}
