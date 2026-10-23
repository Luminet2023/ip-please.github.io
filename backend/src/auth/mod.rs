//! 鉴权：本服务自己的会话（`sess_*`）、AT/RT，以及与 IdP 的 OIDC 交互。
//!
//! 鉴权失败必须走 `AuthErrorResponse`（见 `error.rs`），只有「缺少 Authorization 头」
//! 按规范返回 Detail 信封 `{"detail":"Unauthorized"}`。

pub mod jwks;
pub mod oidc;
pub mod routes;
pub mod session;
pub mod tokens;

use axum::extract::FromRequestParts;
use axum::http::header;
use axum::http::request::Parts;

use crate::error::{AppError, AuthErrorCode, DetailCode};
use crate::util::now_ms;
use crate::AppState;

/// 通过 `Authorization: Bearer <AT>` 确认的调用者。会话每次请求都查库，吊销即时生效。
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: String,
    pub session_id: String,
    pub is_admin: bool,
    pub session_created_at_ms: i64,
    pub session_expires_at_ms: i64,
}

fn bearer(parts: &Parts) -> Option<Option<&str>> {
    let raw = parts.headers.get(header::AUTHORIZATION)?;
    let token = raw.to_str().ok().and_then(|value| {
        value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .map(str::trim)
            .filter(|token| !token.is_empty())
    });
    Some(token)
}

async fn authenticate(token: &str, state: &AppState) -> Result<AuthUser, AppError> {
    let claims = state.tokens.verify(token)?;
    let record = session::find(&state.pool, &claims.sid)
        .await
        .map_err(|err| {
            tracing::error!(error = ?err, "session lookup failed");
            AppError::Auth(AuthErrorCode::SessionValidationFailed)
        })?
        .ok_or(AppError::Auth(AuthErrorCode::TokenRevoked))?;
    if record.user_id != claims.sub || !record.active_for_access(now_ms()) {
        return Err(AppError::Auth(AuthErrorCode::TokenRevoked));
    }
    Ok(AuthUser {
        user_id: record.user_id,
        session_id: record.session_id,
        is_admin: record.is_admin,
        session_created_at_ms: record.created_at_ms,
        session_expires_at_ms: record.expires_at_ms,
    })
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        match bearer(parts) {
            None | Some(None) => Err(AppError::Detail(DetailCode::Unauthorized)),
            Some(Some(token)) => authenticate(token, state).await,
        }
    }
}

/// 公开接口的可选身份：没带 Authorization 头 → `None`；带了就必须有效。
pub struct OptionalAuthUser(pub Option<AuthUser>);

impl FromRequestParts<AppState> for OptionalAuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        match bearer(parts) {
            None => Ok(OptionalAuthUser(None)),
            Some(None) => Err(AppError::Detail(DetailCode::Unauthorized)),
            Some(Some(token)) => authenticate(token, state)
                .await
                .map(|user| OptionalAuthUser(Some(user))),
        }
    }
}

/// 管理员（Keycloak 客户端角色，登录时写入会话）。非管理员 → 403 `insufficient_scope`。
pub struct AdminUser(pub AuthUser);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = AuthUser::from_request_parts(parts, state).await?;
        if !user.is_admin {
            return Err(AppError::Auth(AuthErrorCode::InsufficientScope));
        }
        Ok(AdminUser(user))
    }
}
