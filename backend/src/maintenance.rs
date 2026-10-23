//! 后台定时清理：过期的登录尝试、Refresh Token 与早已结束的会话。

use std::time::Duration;

use sqlx::MySqlPool;

use crate::util::now_ms;

const INTERVAL: Duration = Duration::from_secs(300);
const DAY_MS: i64 = 86_400_000;

pub fn spawn(pool: MySqlPool) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(err) = run_once(&pool, now_ms()).await {
                tracing::warn!(error = ?err, "maintenance pass failed");
            }
        }
    });
}

pub async fn run_once(pool: &MySqlPool, now: i64) -> Result<(), sqlx::Error> {
    let attempts = sqlx::query("DELETE FROM ip_please_login_attempts WHERE expires_at_ms < ?")
        .bind(now)
        .execute(pool)
        .await?
        .rows_affected();
    let tokens = sqlx::query("DELETE FROM ip_please_refresh_tokens WHERE expires_at_ms < ?")
        .bind(now - DAY_MS)
        .execute(pool)
        .await?
        .rows_affected();
    let sessions = sqlx::query(
        "DELETE FROM ip_please_sessions
         WHERE expires_at_ms < ? OR revoked_at_ms < ? OR idle_expires_at_ms < ?",
    )
    .bind(now - 30 * DAY_MS)
    .bind(now - 30 * DAY_MS)
    .bind(now - 30 * DAY_MS)
    .execute(pool)
    .await?
    .rows_affected();
    if attempts + tokens + sessions > 0 {
        tracing::info!(attempts, tokens, sessions, "maintenance cleanup");
    }
    Ok(())
}
