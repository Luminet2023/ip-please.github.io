//! IP, PLEASE 后端：云同步、会话鉴权（OIDC + 自有 AT/RT）、公告、服务器权威的无尽模式。

pub mod announcements;
pub mod auth;
pub mod config;
pub mod db;
pub mod endless;
pub mod error;
pub mod extract;
pub mod ids;
pub mod maintenance;
pub mod profile;
pub mod ratelimit;
pub mod routes;
pub mod util;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderMap};
use axum::Router;
use sqlx::MySqlPool;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::auth::jwks::JwksCache;
use crate::auth::oidc::JtiCache;
use crate::auth::tokens::TokenSigner;
use crate::config::Config;
use crate::ratelimit::RateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub pool: MySqlPool,
    pub jwks: Arc<JwksCache>,
    pub tokens: Arc<TokenSigner>,
    pub limiter: Arc<RateLimiter>,
    pub jti: Arc<JtiCache>,
}

impl AppState {
    pub fn new(config: Arc<Config>, pool: MySqlPool, jwks: Arc<JwksCache>) -> Self {
        Self {
            tokens: Arc::new(TokenSigner::new(&config)),
            config,
            pool,
            jwks,
            limiter: Arc::new(RateLimiter::new()),
            jti: Arc::new(JtiCache::new()),
        }
    }
}

/// 完整的 HTTP 应用（路由 + 日志 + CORS + 请求体上限）。
pub fn build_app(state: AppState) -> Router {
    let config = state.config.clone();
    let body_limit = config
        .max_payload_bytes
        .saturating_mul(4)
        .saturating_add(64 * 1024);

    let origins = config
        .allowed_origins
        .iter()
        .filter_map(|origin| origin.parse::<header::HeaderValue>().ok())
        .collect::<Vec<_>>();

    // 反向通道注销是 IdP 服务器直接调用（无 Origin），不受 CORS 影响。
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT])
        .expose_headers([header::RETRY_AFTER])
        .max_age(Duration::from_secs(600));

    routes::router(state)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .layer(DefaultBodyLimit::max(body_limit))
}

/// 限流用的客户端标识：反向代理写入的真实 IP；直连时退化为一个公共桶。
pub fn client_ip(state: &AppState, headers: &HeaderMap) -> String {
    headers
        .get(state.config.client_ip_header.as_str())
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(',').next().unwrap_or("").trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "direct".to_string())
}
