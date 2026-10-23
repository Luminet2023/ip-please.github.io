use std::sync::Arc;

use ip_please_sync::auth::jwks::JwksCache;
use ip_please_sync::config::Config;
use ip_please_sync::{build_app, db, maintenance, AppState};

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

    let jwks = Arc::new(JwksCache::new(
        &config.oidc_issuer,
        config.oidc_jwks_url.clone(),
    )?);
    if let Err(err) = jwks.warm_up().await {
        tracing::warn!(error = ?err, "JWKS preload failed; will retry on first request");
    }

    let state = AppState::new(config.clone(), pool.clone(), jwks);
    maintenance::spawn(pool.clone());
    let app = build_app(state);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr).await?;
    tracing::info!(
        addr = %config.bind_addr,
        issuer = %config.oidc_issuer,
        client_id = %config.oidc_client_id,
        confidential = config.oidc_client_secret.is_some(),
        "ip-please backend listening"
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
