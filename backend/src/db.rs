//! MySQL 连接、建表与用户身份映射。
//!
//! 表全部以 `ip_please_` 前缀命名，复用服务器已有数据库时不会与其他业务冲突。

use std::time::Duration;

use chrono::Utc;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};

use crate::error::{AppError, DetailCode};
use crate::ids;

const MIGRATION_SQL: &str = include_str!("../migrations/001_init.sql");

/// 启动时 MySQL 可能还没就绪（docker compose 拉起顺序不定），带重试连接。
pub async fn connect_with_retry(url: &str) -> anyhow::Result<MySqlPool> {
    let mut last_error: Option<sqlx::Error> = None;
    for attempt in 1..=30u32 {
        match MySqlPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(Duration::from_secs(5))
            .connect(url)
            .await
        {
            Ok(pool) => {
                tracing::info!(attempt, "connected to MySQL");
                return Ok(pool);
            }
            Err(err) => {
                tracing::warn!(attempt, error = %err, "MySQL connection failed, retrying in 2s");
                last_error = Some(err);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    let err = last_error.unwrap_or_else(|| sqlx::Error::PoolClosed);
    Err(anyhow::Error::new(err).context("could not connect to MySQL after retries"))
}

/// 幂等建表。SQL 文件按分号切分，行注释先剥离。
pub async fn migrate(pool: &MySqlPool) -> anyhow::Result<()> {
    let cleaned = MIGRATION_SQL
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    for statement in cleaned.split(';') {
        let statement = statement.trim();
        if statement.is_empty() {
            continue;
        }
        sqlx::query(statement).execute(pool).await?;
    }
    tracing::info!("database schema is up to date");
    Ok(())
}

/// 把 IdP 的 `sub` 映射为稳定、随机、符合 Prefix Registry 的 `user_*`。
///
/// 首次登录时用安全随机源生成并落库；之后始终复用，删除后不复用。
pub async fn resolve_user_id(pool: &MySqlPool, subject: &str) -> Result<String, AppError> {
    if let Some(user_id) = sqlx::query_scalar::<_, String>(
        "SELECT user_id FROM ip_please_users WHERE subject = ?",
    )
    .bind(subject)
    .fetch_optional(pool)
    .await
    .map_err(AppError::db)?
    {
        return Ok(user_id);
    }

    let candidate = ids::generate(ids::PREFIX_USER);
    sqlx::query(
        "INSERT INTO ip_please_users (subject, user_id, created_at_ms) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE user_id = user_id",
    )
    .bind(subject)
    .bind(&candidate)
    .bind(Utc::now().timestamp_millis())
    .execute(pool)
    .await
    .map_err(AppError::db)?;

    sqlx::query_scalar::<_, String>("SELECT user_id FROM ip_please_users WHERE subject = ?")
        .bind(subject)
        .fetch_one(pool)
        .await
        .map_err(AppError::db)
}

pub fn payload_too_large() -> AppError {
    AppError::Detail(DetailCode::SyncPayloadTooLarge)
}
