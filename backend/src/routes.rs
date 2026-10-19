//! `/anthropic/v1/*` 路由。
//!
//! 规范差异说明：AGENT.md 模板要求所有后端路径以 `/backend-api/` 开头，本项目按部署
//! 约定改挂在 `/anthropic/v1/` 下（API BASE = https://api.luminet.cn/anthropic/v1）。

use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use chrono::{SecondsFormat, TimeZone, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::mysql::MySqlRow;
use sqlx::Row;

use crate::auth::AuthUser;
use crate::db;
use crate::error::{detail_error_response, no_store_json, private_json, AppError, DetailCode};
use crate::ids;
use crate::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/anthropic/v1/health", get(health))
        .route("/anthropic/v1/sync/save", get(get_save).post(put_save))
        .route("/anthropic/v1/sync/snapshots", get(list_snapshots))
        .route("/anthropic/v1/sync/snapshots/{save_id}", get(get_snapshot))
        .fallback(fallback_not_found)
        .method_not_allowed_fallback(fallback_method_not_allowed)
        .with_state(state)
}

// ———————————————————— 健康检查 ————————————————————

async fn health(State(state): State<AppState>) -> Response {
    let check = tokio::time::timeout(
        Duration::from_secs(2),
        sqlx::query("SELECT 1").execute(&state.pool),
    )
    .await;
    if matches!(check, Ok(Ok(_))) {
        no_store_json(StatusCode::OK, json!({ "status": "ok", "db": "ok" }))
    } else {
        let mut response = detail_error_response(DetailCode::BackendUnavailable);
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

async fn fallback_not_found() -> Response {
    detail_error_response(DetailCode::NotFound)
}

async fn fallback_method_not_allowed() -> Response {
    detail_error_response(DetailCode::MethodNotAllowed)
}

// ———————————————————— 读取当前云存档 ————————————————————

struct SaveRow {
    save_id: String,
    version: i64,
    day: i64,
    payload: Value,
    updated_at_ms: i64,
}

fn row_to_save(row: &MySqlRow) -> Result<SaveRow, AppError> {
    let payload_text: String = row
        .try_get("payload")
        .map_err(|err| AppError::Internal(err.into()))?;
    let payload: Value = serde_json::from_str(&payload_text).map_err(|err| {
        AppError::Internal(anyhow::Error::new(err).context("stored payload is not valid JSON"))
    })?;
    Ok(SaveRow {
        save_id: row.try_get("save_id").map_err(|err| AppError::Internal(err.into()))?,
        version: row.try_get("version").map_err(|err| AppError::Internal(err.into()))?,
        day: row.try_get("day").map_err(|err| AppError::Internal(err.into()))?,
        payload,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|err| AppError::Internal(err.into()))?,
    })
}

fn iso_from_ms(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|moment| moment.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}

async fn get_save(State(state): State<AppState>, user: AuthUser) -> Result<Response, AppError> {
    let user_id = db::resolve_user_id(&state.pool, &user.subject).await?;
    let row = sqlx::query(
        "SELECT save_id, version, day, payload, updated_at_ms
         FROM ip_please_save_slots WHERE user_id = ?",
    )
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(AppError::db)?;

    let Some(row) = row else {
        // 该用户还没有云存档：按规范用 404 DetailErrorResponse。
        return Err(AppError::Detail(DetailCode::NotFound));
    };
    let save = row_to_save(&row)?;
    Ok(private_json(
        StatusCode::OK,
        json!({
            "user_id": user_id,
            "save_id": save.save_id,
            "version": save.version,
            "day": save.day,
            "updated_at": iso_from_ms(save.updated_at_ms),
            "payload": save.payload,
        }),
    ))
}

// ———————————————————— 日终上传 ————————————————————

#[derive(Debug, Deserialize)]
struct SaveUpload {
    day: i64,
    payload: Value,
    #[serde(default)]
    base_version: i64,
}

async fn put_save(
    State(state): State<AppState>,
    user: AuthUser,
    body: Bytes,
) -> Result<Response, AppError> {
    if body.len() > state.config.max_payload_bytes.saturating_mul(4) {
        return Err(AppError::Detail(DetailCode::RequestTooLarge));
    }
    let upload: SaveUpload = serde_json::from_slice(&body)
        .map_err(|_| AppError::Detail(DetailCode::ValidationError))?;

    validate_upload(&upload, state.config.max_payload_bytes)?;

    let user_id = db::resolve_user_id(&state.pool, &user.subject).await?;
    check_rate_limit(&state, &user_id).await?;

    let payload_text = serde_json::to_string(&upload.payload)?;
    let now_ms = Utc::now().timestamp_millis();

    let mut tx = state.pool.begin().await.map_err(AppError::db)?;
    let current: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM ip_please_save_slots WHERE user_id = ? FOR UPDATE",
    )
    .bind(&user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::db)?;

    let current_version = current.unwrap_or(0);
    if upload.base_version != current_version {
        let _ = tx.rollback().await;
        return Err(AppError::Detail(DetailCode::SyncConflict));
    }

    let version = current_version + 1;
    let save_id = ids::generate(ids::PREFIX_SAVE);

    sqlx::query(
        "INSERT INTO ip_please_save_snapshots
            (save_id, user_id, version, day, payload, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&save_id)
    .bind(&user_id)
    .bind(version)
    .bind(upload.day)
    .bind(&payload_text)
    .bind(now_ms)
    .execute(&mut *tx)
    .await
    .map_err(AppError::db)?;

    if current.is_some() {
        sqlx::query(
            "UPDATE ip_please_save_slots
             SET save_id = ?, version = ?, day = ?, payload = ?, updated_at_ms = ?
             WHERE user_id = ?",
        )
        .bind(&save_id)
        .bind(version)
        .bind(upload.day)
        .bind(&payload_text)
        .bind(now_ms)
        .bind(&user_id)
        .execute(&mut *tx)
        .await
        .map_err(AppError::db)?;
    } else {
        sqlx::query(
            "INSERT INTO ip_please_save_slots
                (user_id, save_id, version, day, payload, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&user_id)
        .bind(&save_id)
        .bind(version)
        .bind(upload.day)
        .bind(&payload_text)
        .bind(now_ms)
        .execute(&mut *tx)
        .await
        .map_err(AppError::db)?;
    }

    tx.commit().await.map_err(AppError::db)?;
    tracing::info!(
        user_id = %user_id,
        actor = user.display_name().unwrap_or(&user.subject),
        day = upload.day,
        version,
        "cloud save stored"
    );

    Ok(private_json(
        StatusCode::OK,
        json!({
            "user_id": user_id,
            "save_id": save_id,
            "version": version,
            "day": upload.day,
            "updated_at": iso_from_ms(now_ms),
        }),
    ))
}

fn validate_upload(upload: &SaveUpload, max_payload_bytes: usize) -> Result<(), AppError> {
    if !(1..=64).contains(&upload.day) {
        return Err(AppError::Detail(DetailCode::ValidationError));
    }
    if upload.base_version < 0 {
        return Err(AppError::Detail(DetailCode::ValidationError));
    }
    if !upload.payload.is_object() {
        return Err(AppError::Detail(DetailCode::ValidationError));
    }
    let size = serde_json::to_vec(&upload.payload)
        .map_err(|_| AppError::Detail(DetailCode::ValidationError))?
        .len();
    if size > max_payload_bytes {
        return Err(db::payload_too_large());
    }
    Ok(())
}

async fn check_rate_limit(state: &AppState, user_id: &str) -> Result<(), AppError> {
    let limit = state.config.rate_limit_seconds;
    if limit == 0 {
        return Ok(());
    }
    let mut guard = state.rate.lock().await;
    let now = Instant::now();
    guard.retain(|_, at| now.duration_since(*at) < Duration::from_secs(3600));
    if let Some(at) = guard.get(user_id) {
        let elapsed = now.duration_since(*at).as_secs();
        if elapsed < limit {
            return Err(AppError::DetailRetryAfter(
                DetailCode::SyncRateLimited,
                limit - elapsed,
            ));
        }
    }
    guard.insert(user_id.to_string(), now);
    Ok(())
}

// ———————————————————— 快照列表 / 详情 ————————————————————

#[derive(Debug, Deserialize)]
struct SnapshotQuery {
    #[serde(default)]
    limit: Option<i64>,
}

async fn list_snapshots(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<SnapshotQuery>,
) -> Result<Response, AppError> {
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let user_id = db::resolve_user_id(&state.pool, &user.subject).await?;

    let rows = sqlx::query(
        "SELECT save_id, version, day, created_at_ms
         FROM ip_please_save_snapshots
         WHERE user_id = ?
         ORDER BY version DESC
         LIMIT ?",
    )
    .bind(&user_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::db)?;

    let mut snapshots = Vec::with_capacity(rows.len());
    for row in &rows {
        let save_id: String = row.try_get("save_id").map_err(|err| AppError::Internal(err.into()))?;
        let version: i64 = row.try_get("version").map_err(|err| AppError::Internal(err.into()))?;
        let day: i64 = row.try_get("day").map_err(|err| AppError::Internal(err.into()))?;
        let created_at_ms: i64 = row
            .try_get("created_at_ms")
            .map_err(|err| AppError::Internal(err.into()))?;
        snapshots.push(json!({
            "save_id": save_id,
            "version": version,
            "day": day,
            "created_at": iso_from_ms(created_at_ms),
        }));
    }

    Ok(private_json(
        StatusCode::OK,
        json!({ "user_id": user_id, "snapshots": snapshots }),
    ))
}

async fn get_snapshot(
    State(state): State<AppState>,
    user: AuthUser,
    Path(save_id): Path<String>,
) -> Result<Response, AppError> {
    ids::require(&save_id, ids::PREFIX_SAVE)?;
    let user_id = db::resolve_user_id(&state.pool, &user.subject).await?;

    let row = sqlx::query(
        "SELECT save_id, version, day, payload, created_at_ms AS updated_at_ms
         FROM ip_please_save_snapshots
         WHERE save_id = ? AND user_id = ?",
    )
    .bind(&save_id)
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(AppError::db)?;

    let Some(row) = row else {
        return Err(AppError::Detail(DetailCode::SyncSnapshotExpired));
    };
    let save = row_to_save(&row)?;
    Ok(private_json(
        StatusCode::OK,
        json!({
            "user_id": user_id,
            "save_id": save.save_id,
            "version": save.version,
            "day": save.day,
            "created_at": iso_from_ms(save.updated_at_ms),
            "payload": save.payload,
        }),
    ))
}
