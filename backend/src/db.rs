//! MySQL 连接、建表与用户身份映射。
//!
//! 表全部以 `ip_please_` 前缀命名，复用服务器已有数据库时不会与其他业务冲突。

use std::time::Duration;

use chrono::Utc;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};

use crate::error::{AppError, DetailCode};
use crate::ids;

/// 按顺序执行的建表脚本。只新增表、不 ALTER 已有表（没有版本表，每次启动全部重跑）；
/// 注释里不能出现分号（按分号切分语句）。
const MIGRATIONS: &[(&str, &str)] = &[
    ("001_init", include_str!("../migrations/001_init.sql")),
    ("002_auth", include_str!("../migrations/002_auth.sql")),
    (
        "003_announcements",
        include_str!("../migrations/003_announcements.sql"),
    ),
    ("004_endless", include_str!("../migrations/004_endless.sql")),
];

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

/// 把一个 SQL 文件拆成语句：先剥离整行注释，再按分号切分。
fn statements(sql: &str) -> Vec<String> {
    let cleaned = sql
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    cleaned
        .split(';')
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
        .map(ToString::to_string)
        .collect()
}

/// 幂等建表（`CREATE TABLE IF NOT EXISTS`），每次启动执行。
pub async fn migrate(pool: &MySqlPool) -> anyhow::Result<()> {
    for (name, sql) in MIGRATIONS {
        for statement in statements(sql) {
            sqlx::query(&statement).execute(pool).await.map_err(|err| {
                anyhow::Error::new(err).context(format!("migration {name} failed"))
            })?;
        }
    }
    tracing::info!("database schema is up to date");
    Ok(())
}

/// 把 IdP 的 `sub` 映射为稳定、随机、符合 Prefix Registry 的 `user_*`。
///
/// 首次登录时用安全随机源生成并落库；之后始终复用，删除后不复用。
pub async fn resolve_user_id(pool: &MySqlPool, subject: &str) -> Result<String, AppError> {
    if let Some(user_id) =
        sqlx::query_scalar::<_, String>("SELECT user_id FROM ip_please_users WHERE subject = ?")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_split_into_create_statements() {
        for (name, sql) in MIGRATIONS {
            let parts = statements(sql);
            assert!(!parts.is_empty(), "{name} is empty");
            for statement in parts {
                assert!(
                    statement.starts_with("CREATE TABLE IF NOT EXISTS"),
                    "{name}: only idempotent CREATE TABLE is allowed, got: {statement}"
                );
            }
        }
    }
}
