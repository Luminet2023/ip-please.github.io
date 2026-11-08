//! Local acceptance only. Never used by the production binary or miniapp ZIP.
//! Runs the real router, migrations and MySQL store with a fixed test JWKS.
use std::sync::Arc;

use axum::{extract::Query, routing::get, Json};
use ip_please_sync::{auth::jwks::JwksCache, config::Config, mapp::auth::Verifier, AppState};
use serde_json::json;
use std::collections::HashMap;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let database = std::env::var("TEST_DATABASE_URL")?;
    // Deliberately accept only the explicitly disposable test schema.
    anyhow::ensure!(
        database.ends_with("/ip_please_test"),
        "disposable test database required"
    );
    let jwks = std::env::var("FIXTURE_JWKS_URL")?;
    anyhow::ensure!(
        jwks.starts_with("http://127.0.0.1:"),
        "loopback JWKS required"
    );
    let pool = sqlx::MySqlPool::connect(&database).await?;
    ip_please_sync::db::migrate(&pool).await?;
    let mut config = Config::for_tests(&database, "https://idp.test");
    config.mapp_app_id = "01a1baa6-abbf-7ed6-afac-bfa495a47dd3".into();
    let mut state = AppState::new(
        Arc::new(config),
        pool.clone(),
        Arc::new(JwksCache::new("https://idp.test", None)?),
    );
    state.mapp = Arc::new(Verifier::new(&jwks));
    // Keep game timing validation; omit request burst throttling in this local harness.
    state.limiter = Arc::new(ip_please_sync::ratelimit::RateLimiter::disabled());
    let audit = move |Query(query): Query<HashMap<String, String>>| {
        let pool = pool.clone();
        async move {
            let subject = query.get("subject").expect("fixture subject");
            let receipts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ip_please_mapp_receipts r JOIN ip_please_mapp_users u ON u.user_id=r.user_id WHERE u.linuxdo_id=?").bind(subject).fetch_one(&pool).await.unwrap();
            let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ip_please_endless_events e JOIN ip_please_endless_runs r ON r.run_id=e.run_id JOIN ip_please_mapp_users u ON u.user_id=r.user_id WHERE u.linuxdo_id=?").bind(subject).fetch_one(&pool).await.unwrap();
            let web_scores: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ip_please_leaderboard b JOIN ip_please_mapp_users u ON u.user_id=b.user_id WHERE u.linuxdo_id=?").bind(subject).fetch_one(&pool).await.unwrap();
            Json(json!({"receipts":receipts,"events":events,"web_scores":web_scores}))
        }
    };
    let app = ip_please_sync::build_app(state).route("/anthropic/v1/fixture/audit", get(audit));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    println!("FIXTURE_BACKEND=http://{}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}
