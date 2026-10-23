//! 请求解析提取器：所有失败都映射成双信封（AGENT.md），不暴露 axum 默认的纯文本拒绝。
//!
//! 新增接口一律用这里的 `JsonBody` / `FormBody` / `QueryParams` / `PathId` / `LimitedBytes`，
//! 不要直接用 `axum::Json`、`Form`、`Query`、`Path`、`Bytes`。

use axum::body::Bytes;
use axum::extract::{FromRequest, FromRequestParts, Path, Request};
use axum::http::request::Parts;
use axum::http::StatusCode;
use serde::de::DeserializeOwned;

use crate::error::{AppError, DetailCode};

/// 请求体原始字节；超过 `DefaultBodyLimit` 时返回 413 `request_too_large`。
pub struct LimitedBytes(pub Bytes);

impl<S: Send + Sync> FromRequest<S> for LimitedBytes {
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        Bytes::from_request(req, state)
            .await
            .map(LimitedBytes)
            .map_err(|rejection| {
                if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    AppError::Detail(DetailCode::RequestTooLarge)
                } else {
                    AppError::Detail(DetailCode::ValidationError)
                }
            })
    }
}

/// JSON 请求体。不检查 Content-Type（前端只发 JSON），解析失败 → 400 `invalid_request`。
pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for JsonBody<T> {
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let LimitedBytes(bytes) = LimitedBytes::from_request(req, state).await?;
        serde_json::from_slice(&bytes)
            .map(JsonBody)
            .map_err(|_| AppError::Detail(DetailCode::ValidationError))
    }
}

/// `application/x-www-form-urlencoded` 请求体（反向通道注销）。
pub struct FormBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for FormBody<T> {
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let LimitedBytes(bytes) = LimitedBytes::from_request(req, state).await?;
        serde_urlencoded::from_bytes(&bytes)
            .map(FormBody)
            .map_err(|_| AppError::Detail(DetailCode::ValidationError))
    }
}

/// 查询参数；解析失败 → 400 `invalid_request`。
pub struct QueryParams<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequestParts<S> for QueryParams<T> {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        serde_urlencoded::from_str(parts.uri.query().unwrap_or(""))
            .map(QueryParams)
            .map_err(|_| AppError::Detail(DetailCode::ValidationError))
    }
}

/// 单个路径参数（资源 ID）；解码失败按资源不存在处理 → 404。
/// 前缀与格式仍需调用方用 `ids::require` 校验。
pub struct PathId(pub String);

impl<S: Send + Sync> FromRequestParts<S> for PathId {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Path::<String>::from_request_parts(parts, state)
            .await
            .map(|Path(value)| PathId(value))
            .map_err(|_| AppError::Detail(DetailCode::NotFound))
    }
}

/// 两段路径参数（如 `/runs/{run_id}/waves/{wave_id}`）。
pub struct PathIds(pub String, pub String);

impl<S: Send + Sync> FromRequestParts<S> for PathIds {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Path::<(String, String)>::from_request_parts(parts, state)
            .await
            .map(|Path((a, b))| PathIds(a, b))
            .map_err(|_| AppError::Detail(DetailCode::NotFound))
    }
}
