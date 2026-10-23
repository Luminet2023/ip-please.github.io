//! 双信封错误规范（AGENT.md「Backend API 响应与错误规范」）。
//!
//! - 业务/校验/资源状态错误：`DetailErrorResponse` → `{"detail": "<message>"}`
//! - 鉴权错误：`AuthErrorResponse` → `{"error": {...}, "status": 401}`
//!
//! 前端 `cloud.js` 的 `businessErrorCodeFromDetail()` 依赖这里登记的英文文案反查错误码，
//! 因此 `DetailCode::message()` 的字符串是对外契约，改动等同于破坏兼容。

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

/// Detail 错误码登记表。新增错误码时必须同时更新 AGENT.md 与 `cloud.js`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetailCode {
    NotFound,
    ValidationError,
    MethodNotAllowed,
    SyncConflict,
    SyncSnapshotExpired,
    SyncRateLimited,
    SyncUnavailable,
    BackendUnavailable,
    InternalError,
    RequestTooLarge,
    SyncPayloadTooLarge,
    Unauthorized,
    LoginAttemptInvalid,
    RateLimited,
    NicknameInvalid,
    EndlessRunActive,
    EndlessStateConflict,
    DailyAlreadyPlayed,
}

impl DetailCode {
    /// 全部已登记的错误码（测试与文档核对用）。
    pub const ALL: [DetailCode; 18] = [
        DetailCode::NotFound,
        DetailCode::ValidationError,
        DetailCode::MethodNotAllowed,
        DetailCode::SyncConflict,
        DetailCode::SyncSnapshotExpired,
        DetailCode::SyncRateLimited,
        DetailCode::SyncUnavailable,
        DetailCode::BackendUnavailable,
        DetailCode::InternalError,
        DetailCode::RequestTooLarge,
        DetailCode::SyncPayloadTooLarge,
        DetailCode::Unauthorized,
        DetailCode::LoginAttemptInvalid,
        DetailCode::RateLimited,
        DetailCode::NicknameInvalid,
        DetailCode::EndlessRunActive,
        DetailCode::EndlessStateConflict,
        DetailCode::DailyAlreadyPlayed,
    ];
}

impl DetailCode {
    pub fn status(self) -> StatusCode {
        match self {
            DetailCode::NotFound => StatusCode::NOT_FOUND,
            DetailCode::ValidationError
            | DetailCode::LoginAttemptInvalid
            | DetailCode::NicknameInvalid => StatusCode::BAD_REQUEST,
            DetailCode::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            DetailCode::SyncConflict
            | DetailCode::EndlessRunActive
            | DetailCode::EndlessStateConflict
            | DetailCode::DailyAlreadyPlayed => StatusCode::CONFLICT,
            DetailCode::SyncSnapshotExpired => StatusCode::GONE,
            DetailCode::SyncRateLimited | DetailCode::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            DetailCode::SyncUnavailable | DetailCode::BackendUnavailable => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            DetailCode::InternalError => StatusCode::INTERNAL_SERVER_ERROR,
            DetailCode::RequestTooLarge | DetailCode::SyncPayloadTooLarge => {
                StatusCode::PAYLOAD_TOO_LARGE
            }
            DetailCode::Unauthorized => StatusCode::UNAUTHORIZED,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            DetailCode::NotFound => "The requested resource was not found.",
            DetailCode::ValidationError => "The request is invalid.",
            DetailCode::MethodNotAllowed => "Method not allowed.",
            DetailCode::SyncConflict => {
                "The cloud save has a newer version than the client base version."
            }
            DetailCode::SyncSnapshotExpired => {
                "The requested save snapshot is no longer available."
            }
            DetailCode::SyncRateLimited => "Too many sync requests. Please retry later.",
            DetailCode::SyncUnavailable => "Cloud sync storage is temporarily unavailable.",
            DetailCode::BackendUnavailable => "The backend service is unavailable.",
            DetailCode::InternalError => "Internal server error.",
            DetailCode::RequestTooLarge => "The request body is too large.",
            DetailCode::SyncPayloadTooLarge => "The save payload exceeds the size limit.",
            DetailCode::Unauthorized => "Unauthorized",
            DetailCode::LoginAttemptInvalid => "The login attempt is invalid or has expired.",
            DetailCode::RateLimited => "Too many requests. Please retry later.",
            DetailCode::NicknameInvalid => "The nickname is not allowed.",
            DetailCode::EndlessRunActive => "An endless run is already in progress.",
            DetailCode::EndlessStateConflict => "The endless run state has changed. Please reload.",
            DetailCode::DailyAlreadyPlayed => "Today's daily challenge has already been played.",
        }
    }
}

/// Auth 错误码（`AuthErrorResponse.error.code`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthErrorCode {
    InvalidToken,
    TokenRevoked,
    InsufficientScope,
    SessionValidationFailed,
}

impl AuthErrorCode {
    pub fn code(self) -> &'static str {
        match self {
            AuthErrorCode::InvalidToken => "invalid_token",
            AuthErrorCode::TokenRevoked => "token_revoked",
            AuthErrorCode::InsufficientScope => "insufficient_scope",
            AuthErrorCode::SessionValidationFailed => "session_validation_failed",
        }
    }

    pub fn status(self) -> StatusCode {
        match self {
            AuthErrorCode::InsufficientScope => StatusCode::FORBIDDEN,
            AuthErrorCode::SessionValidationFailed => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::UNAUTHORIZED,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            AuthErrorCode::InvalidToken => "Invalid or expired authentication token",
            AuthErrorCode::TokenRevoked => "The session has been revoked or is no longer active",
            AuthErrorCode::InsufficientScope => "The access token is missing a required scope",
            AuthErrorCode::SessionValidationFailed => {
                "Session validation is temporarily unavailable"
            }
        }
    }
}

const CACHE_PRIVATE_NO_STORE: &str = "private, no-store";
const CACHE_NO_STORE: &str = "no-store";

fn with_cache_control(mut response: Response, value: &'static str) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

/// 业务数据/鉴权接口的 JSON 响应（`Cache-Control: private, no-store`）。
pub fn private_json(status: StatusCode, body: Value) -> Response {
    with_cache_control((status, Json(body)).into_response(), CACHE_PRIVATE_NO_STORE)
}

/// 健康检查等无状态监控接口（`Cache-Control: no-store`）。
pub fn no_store_json(status: StatusCode, body: Value) -> Response {
    with_cache_control((status, Json(body)).into_response(), CACHE_NO_STORE)
}

pub fn detail_error_response(code: DetailCode) -> Response {
    private_json(code.status(), json!({ "detail": code.message() }))
}

pub fn detail_error_response_with_retry(code: DetailCode, retry_after_secs: u64) -> Response {
    let mut response = detail_error_response(code);
    if let Ok(value) = HeaderValue::from_str(&retry_after_secs.max(1).to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

pub fn auth_error_response(status: StatusCode, code: AuthErrorCode, message: &str) -> Response {
    private_json(
        status,
        json!({
            "error": {
                "message": message,
                "type": null,
                "code": code.code(),
                "param": null,
            },
            "status": status.as_u16(),
        }),
    )
}

pub fn authorization_failure_response(code: AuthErrorCode) -> Response {
    auth_error_response(code.status(), code, code.message())
}

/// 统一的处理错误类型；`IntoResponse` 保证所有出口都是双信封格式。
#[derive(Debug)]
pub enum AppError {
    Detail(DetailCode),
    DetailRetryAfter(DetailCode, u64),
    Auth(AuthErrorCode),
    Internal(anyhow::Error),
}

impl AppError {
    /// 数据库故障映射：连接类故障按规范返回 503，其余返回 500。
    pub fn db(err: sqlx::Error) -> Self {
        match &err {
            sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed | sqlx::Error::Io(_) => {
                tracing::error!(error = ?err, "database connection failure");
                AppError::Detail(DetailCode::SyncUnavailable)
            }
            _ => {
                tracing::error!(error = ?err, "database error");
                AppError::Detail(DetailCode::InternalError)
            }
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        AppError::Internal(err)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        tracing::error!(error = ?err, "json error");
        AppError::Detail(DetailCode::ValidationError)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::Detail(code) => detail_error_response(code),
            AppError::DetailRetryAfter(code, secs) => detail_error_response_with_retry(code, secs),
            AppError::Auth(code) => authorization_failure_response(code),
            AppError::Internal(err) => {
                tracing::error!(error = ?err, "internal error");
                detail_error_response(DetailCode::InternalError)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detail_codes_have_stable_status_and_message() {
        assert_eq!(DetailCode::SyncConflict.status(), StatusCode::CONFLICT);
        assert_eq!(
            DetailCode::SyncRateLimited.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(DetailCode::Unauthorized.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(DetailCode::Unauthorized.message(), "Unauthorized");
        assert_eq!(
            DetailCode::SyncPayloadTooLarge.status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[test]
    fn detail_messages_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for code in DetailCode::ALL {
            assert!(
                seen.insert(code.message()),
                "duplicate message for {code:?}"
            );
        }
        assert_eq!(
            DetailCode::RateLimited.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            DetailCode::LoginAttemptInvalid.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(DetailCode::EndlessRunActive.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn auth_codes_map_to_expected_status() {
        assert_eq!(
            AuthErrorCode::InvalidToken.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            AuthErrorCode::InsufficientScope.status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            AuthErrorCode::SessionValidationFailed.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(AuthErrorCode::TokenRevoked.code(), "token_revoked");
    }
}
