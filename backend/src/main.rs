mod auth;
mod config;
mod db;
mod error;
mod ids;
mod routes;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::DefaultBodyLimit;
use axum::http::header;
use sqlx::MySqlPool;
use tokio::sync::Mutex;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub pool: MySqlPool,
    pub jwks: Arc<auth::JwksCache>,
    pub rate: Arc<Mutex<HashMap<String, Instant>>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,sqlx=warn")),
        )
        .init();

    let config = Arc::new(Config::from_env()?);
    let pool = db::connect_with_retry(&config.database_url).await?;
    db::migrate(&pool).await?;

    let jwks = Arc::new(
        auth::JwksCache::new(&config.oidc_issuer, config.oidc_jwks_url.clone()).await?,
    );
    if let Err(err) = jwks.warm_up().await {
        tracing::warn!(error = ?err, "JWKS preload failed; will retry on first request");
    }

    let body_limit = config
        .max_payload_bytes
        .saturating_mul(4)
        .saturating_add(64 * 1024);

    let state = AppState {
        config: config.clone(),
        pool: pool.clone(),
        jwks,
        rate: Arc::new(Mutex::new(HashMap::new())),
    };

    let origins = config
        .allowed_origins
        .iter()
        .filter_map(|origin| origin.parse::<header::HeaderValue>().ok())
        .collect::<Vec<_>>();

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ACCEPT,
        ])
        .expose_headers([header::RETRY_AFTER])
        .max_age(Duration::from_secs(600));

    let app = routes::router(state)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .layer(DefaultBodyLimit::max(body_limit));

    let listener = tokio::net::TcpListener::bind(&config.bind_addr).await?;
    tracing::info!(
        addr = %config.bind_addr,
        issuer = %config.oidc_issuer,
        client_id = %config.oidc_client_id,
        "ip-please sync backend listening"
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    pool.close().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
