//! 公告（`ann_*`）：管理员发布 / 下线，所有人可读当前生效的公告。
//!
//! 公告文本只在前端 DOM 里用 `textContent` 显示（canvas 字库没有任意文字的字形），
//! 这里只做长度与控制字符校验，不做 HTML 处理。

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use chrono::DateTime;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::mysql::MySqlRow;
use sqlx::Row;

use crate::auth::AdminUser;
use crate::error::{private_json, AppError, DetailCode};
use crate::extract::{JsonBody, PathId, QueryParams};
use crate::ids;
use crate::ratelimit;
use crate::util::{iso_from_ms, now_ms};
use crate::{client_ip, AppState};

pub const LEVELS: [&str; 3] = ["info", "warning", "maintenance"];
const TITLE_MAX: usize = 60;
const BODY_MAX: usize = 500;
const PUBLIC_LIMIT: i64 = 10;
const ADMIN_LIMIT: i64 = 50;

const COLUMNS: &str = "announcement_id, title, body, level, starts_at_ms, ends_at_ms, \
     retired_at_ms, created_by, created_at_ms";

fn row_json(row: &MySqlRow, admin: bool) -> Result<Value, AppError> {
    let get_i64 = |name: &str| row.try_get::<i64, _>(name).map_err(AppError::db);
    let get_opt = |name: &str| row.try_get::<Option<i64>, _>(name).map_err(AppError::db);
    let get_str = |name: &str| row.try_get::<String, _>(name).map_err(AppError::db);
    let mut body = json!({
        "announcement_id": get_str("announcement_id")?,
        "title": get_str("title")?,
        "body": get_str("body")?,
        "level": get_str("level")?,
        "starts_at": iso_from_ms(get_i64("starts_at_ms")?),
        "ends_at": get_opt("ends_at_ms")?.map(iso_from_ms),
        "created_at": iso_from_ms(get_i64("created_at_ms")?),
    });
    if admin {
        body["retired_at"] = json!(get_opt("retired_at_ms")?.map(iso_from_ms));
        body["created_by"] = json!(get_str("created_by")?);
    }
    Ok(body)
}

/// 所有人可读：已开始、未结束、未下线的公告（最新在前）。
pub async fn list_active(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(ratelimit::PUBLIC_READ, &client_ip(&state, &headers))?;
    let now = now_ms();
    let rows = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM ip_please_announcements
         WHERE retired_at_ms IS NULL AND starts_at_ms <= ? AND (ends_at_ms IS NULL OR ends_at_ms > ?)
         ORDER BY starts_at_ms DESC LIMIT ?"
    ))
    .bind(now)
    .bind(now)
    .bind(PUBLIC_LIMIT)
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::db)?;
    let items = rows
        .iter()
        .map(|row| row_json(row, false))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(private_json(
        StatusCode::OK,
        json!({ "announcements": items }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct AdminListQuery {
    #[serde(default)]
    include_retired: Option<String>,
}

pub async fn admin_list(
    State(state): State<AppState>,
    AdminUser(_admin): AdminUser,
    QueryParams(query): QueryParams<AdminListQuery>,
) -> Result<Response, AppError> {
    let include_retired = matches!(query.include_retired.as_deref(), Some("1" | "true"));
    let filter = if include_retired {
        ""
    } else {
        "WHERE retired_at_ms IS NULL"
    };
    let rows = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM ip_please_announcements {filter}
         ORDER BY created_at_ms DESC LIMIT ?"
    ))
    .bind(ADMIN_LIMIT)
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::db)?;
    let items = rows
        .iter()
        .map(|row| row_json(row, true))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(private_json(
        StatusCode::OK,
        json!({ "announcements": items }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct NewAnnouncement {
    title: String,
    body: String,
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    starts_at: Option<String>,
    #[serde(default)]
    ends_at: Option<String>,
}

/// 校验后的公告内容。
#[derive(Debug, PartialEq, Eq)]
pub struct ValidAnnouncement {
    pub title: String,
    pub body: String,
    pub level: String,
    pub starts_at_ms: i64,
    pub ends_at_ms: Option<i64>,
}

fn parse_iso(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|moment| moment.timestamp_millis())
}

fn clean_text(value: &str, max: usize, allow_newlines: bool) -> Option<String> {
    let text = value.trim();
    let count = text.chars().count();
    if count == 0 || count > max {
        return None;
    }
    if text
        .chars()
        .any(|c| c.is_control() && !(allow_newlines && c == '\n'))
    {
        return None;
    }
    Some(text.to_string())
}

pub fn validate(input: &NewAnnouncement, now: i64) -> Result<ValidAnnouncement, AppError> {
    let invalid = || AppError::Detail(DetailCode::ValidationError);
    let title = clean_text(&input.title, TITLE_MAX, false).ok_or_else(invalid)?;
    let body = clean_text(&input.body.replace("\r\n", "\n"), BODY_MAX, true).ok_or_else(invalid)?;
    let level = input.level.clone().unwrap_or_else(|| "info".to_string());
    if !LEVELS.contains(&level.as_str()) {
        return Err(invalid());
    }
    let starts_at_ms = match &input.starts_at {
        Some(value) => parse_iso(value).ok_or_else(invalid)?,
        None => now,
    };
    let ends_at_ms = match &input.ends_at {
        Some(value) => Some(parse_iso(value).ok_or_else(invalid)?),
        None => None,
    };
    if let Some(ends) = ends_at_ms {
        if ends <= starts_at_ms || ends <= now {
            return Err(invalid());
        }
    }
    Ok(ValidAnnouncement {
        title,
        body,
        level,
        starts_at_ms,
        ends_at_ms,
    })
}

async fn fetch_one(state: &AppState, announcement_id: &str) -> Result<Value, AppError> {
    let row = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM ip_please_announcements WHERE announcement_id = ?"
    ))
    .bind(announcement_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(AppError::db)?
    .ok_or(AppError::Detail(DetailCode::NotFound))?;
    row_json(&row, true)
}

pub async fn create(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    JsonBody(input): JsonBody<NewAnnouncement>,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(ratelimit::ADMIN_WRITE, &admin.user_id)?;
    let now = now_ms();
    let valid = validate(&input, now)?;
    let announcement_id = ids::generate(ids::PREFIX_ANNOUNCEMENT);
    sqlx::query(
        "INSERT INTO ip_please_announcements
            (announcement_id, title, body, level, starts_at_ms, ends_at_ms, created_by,
             created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&announcement_id)
    .bind(&valid.title)
    .bind(&valid.body)
    .bind(&valid.level)
    .bind(valid.starts_at_ms)
    .bind(valid.ends_at_ms)
    .bind(&admin.user_id)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await
    .map_err(AppError::db)?;
    tracing::info!(admin = %admin.user_id, announcement_id = %announcement_id, "announcement published");
    Ok(private_json(
        StatusCode::CREATED,
        fetch_one(&state, &announcement_id).await?,
    ))
}

pub async fn retire(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    PathId(announcement_id): PathId,
) -> Result<Response, AppError> {
    ids::require(&announcement_id, ids::PREFIX_ANNOUNCEMENT)?;
    state
        .limiter
        .check(ratelimit::ADMIN_WRITE, &admin.user_id)?;
    let now = now_ms();
    sqlx::query(
        "UPDATE ip_please_announcements SET retired_at_ms = ?, updated_at_ms = ?
         WHERE announcement_id = ? AND retired_at_ms IS NULL",
    )
    .bind(now)
    .bind(now)
    .bind(&announcement_id)
    .execute(&state.pool)
    .await
    .map_err(AppError::db)?;
    let body = fetch_one(&state, &announcement_id).await?;
    tracing::info!(admin = %admin.user_id, announcement_id = %announcement_id, "announcement retired");
    Ok(private_json(StatusCode::OK, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(title: &str, body: &str) -> NewAnnouncement {
        NewAnnouncement {
            title: title.into(),
            body: body.into(),
            level: None,
            starts_at: None,
            ends_at: None,
        }
    }

    #[test]
    fn defaults_and_trimming() {
        let now = 1_800_000_000_000;
        let valid = validate(&input("  维护通知 ", "今晚\r\n22:00 停机"), now).unwrap();
        assert_eq!(valid.title, "维护通知");
        assert_eq!(valid.body, "今晚\n22:00 停机");
        assert_eq!(valid.level, "info");
        assert_eq!(valid.starts_at_ms, now);
        assert_eq!(valid.ends_at_ms, None);
    }

    #[test]
    fn rejects_bad_input() {
        let now = 1_800_000_000_000;
        assert!(validate(&input("", "x"), now).is_err());
        assert!(validate(&input(&"长".repeat(61), "x"), now).is_err());
        assert!(validate(&input("t", &"x".repeat(501)), now).is_err());
        assert!(
            validate(&input("a\nb", "x"), now).is_err(),
            "newline in title"
        );
        assert!(validate(&input("t", "a\u{0000}b"), now).is_err());
        let mut level = input("t", "b");
        level.level = Some("urgent".into());
        assert!(validate(&level, now).is_err());
        let mut past = input("t", "b");
        past.ends_at = Some("2020-01-01T00:00:00Z".into());
        assert!(validate(&past, now).is_err());
        let mut garbage = input("t", "b");
        garbage.starts_at = Some("tomorrow".into());
        assert!(validate(&garbage, now).is_err());
    }

    #[test]
    fn accepts_window() {
        let now = 1_800_000_000_000;
        let mut windowed = input("t", "b");
        windowed.level = Some("maintenance".into());
        windowed.starts_at = Some(iso_from_ms(now + 1000));
        windowed.ends_at = Some(iso_from_ms(now + 86_400_000));
        let valid = validate(&windowed, now).unwrap();
        assert_eq!(valid.starts_at_ms, now + 1000);
        assert_eq!(valid.ends_at_ms, Some(now + 86_400_000));
    }
}
