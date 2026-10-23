//! 对局的持久化：所有状态变更都在 `SELECT … FOR UPDATE` 的事务里完成，并写一条操作日志；
//! 对局结束时在同一事务里更新排行榜（分数只升不降，可疑对局不上榜）。

use chrono::{Datelike, FixedOffset, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::mysql::MySqlRow;
use sqlx::{MySql, MySqlPool, Row, Transaction};

use super::state::{Mode, RunState, StepError};
use crate::error::{AppError, DetailCode};
use crate::ids;
use crate::profile;
use crate::util::{iso_from_ms, unix_secs};

/// 游戏设定在东八区：每日挑战与周榜按 UTC+8 计。
fn east8() -> FixedOffset {
    FixedOffset::east_opt(8 * 3600).expect("valid offset")
}

pub fn daily_date(now_ms: i64) -> String {
    east8()
        .timestamp_millis_opt(now_ms)
        .single()
        .unwrap_or_else(|| Utc::now().with_timezone(&east8()))
        .format("%Y-%m-%d")
        .to_string()
}

pub fn iso_week(now_ms: i64) -> String {
    let moment = east8()
        .timestamp_millis_opt(now_ms)
        .single()
        .unwrap_or_else(|| Utc::now().with_timezone(&east8()));
    let week = moment.iso_week();
    format!("{}-W{:02}", week.year(), week.week())
}

/// 下一个 UTC+8 零点（每日挑战重置时间，Unix 秒）。
pub fn next_reset_secs(now_ms: i64) -> i64 {
    let day_ms = 86_400_000;
    let offset = 8 * 3_600_000;
    unix_secs(((now_ms + offset) / day_ms + 1) * day_ms - offset)
}

/// 排行榜：(榜, 周期)。
pub fn boards_for(mode: Mode, daily: Option<&str>, ended_ms: i64) -> Vec<(&'static str, String)> {
    match mode {
        Mode::Endless => vec![
            ("endless", "all".to_string()),
            ("weekly", iso_week(ended_ms)),
        ],
        Mode::Daily => vec![(
            "daily",
            daily
                .map(String::from)
                .unwrap_or_else(|| daily_date(ended_ms)),
        )],
    }
}

pub struct RunRow {
    pub run_id: String,
    pub user_id: String,
    pub started_at_ms: i64,
    pub last_action_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub state: RunState,
}

const RUN_COLUMNS: &str =
    "run_id, user_id, started_at_ms, last_action_at_ms, ended_at_ms, state_json";

fn row_to_run(row: &MySqlRow) -> Result<RunRow, AppError> {
    let text: String = row.try_get("state_json").map_err(AppError::db)?;
    let state: RunState = serde_json::from_str(&text).map_err(|err| {
        AppError::Internal(anyhow::Error::new(err).context("stored run state is not valid"))
    })?;
    Ok(RunRow {
        run_id: row.try_get("run_id").map_err(AppError::db)?,
        user_id: row.try_get("user_id").map_err(AppError::db)?,
        started_at_ms: row.try_get("started_at_ms").map_err(AppError::db)?,
        last_action_at_ms: row.try_get("last_action_at_ms").map_err(AppError::db)?,
        ended_at_ms: row.try_get("ended_at_ms").map_err(AppError::db)?,
        state,
    })
}

fn duplicate_key(err: &sqlx::Error, key: &str) -> bool {
    match err {
        sqlx::Error::Database(db) => {
            db.code().as_deref() == Some("23000") && db.message().contains(key)
        }
        _ => false,
    }
}

/// 开新局。已有进行中的对局 → 409 `endless_run_active`；今天的每日挑战已玩过 → 409 `daily_already_played`。
pub async fn create(
    pool: &MySqlPool,
    user_id: &str,
    state: &RunState,
    now: i64,
) -> Result<String, AppError> {
    let run_id = ids::generate(ids::PREFIX_RUN);
    let state_json = serde_json::to_string(state)?;
    let result = sqlx::query(
        "INSERT INTO ip_please_endless_runs
            (run_id, user_id, mode, daily_date, status, active_user_id, generator_version, state_json,
             started_at_ms, last_action_at_ms)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)",
    )
    .bind(&run_id)
    .bind(user_id)
    .bind(state.mode.as_str())
    .bind(&state.daily_date)
    .bind(user_id)
    .bind(state.generator_version)
    .bind(&state_json)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await;
    match result {
        Ok(_) => Ok(run_id),
        Err(err) if duplicate_key(&err, "uq_ip_please_runs_active") => {
            Err(AppError::Detail(DetailCode::EndlessRunActive))
        }
        Err(err) if duplicate_key(&err, "uq_ip_please_runs_daily") => {
            Err(AppError::Detail(DetailCode::DailyAlreadyPlayed))
        }
        Err(err) => Err(AppError::db(err)),
    }
}

pub async fn active_run_id(pool: &MySqlPool, user_id: &str) -> Result<Option<String>, AppError> {
    sqlx::query_scalar("SELECT run_id FROM ip_please_endless_runs WHERE active_user_id = ?")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(AppError::db)
}

pub async fn load(pool: &MySqlPool, run_id: &str) -> Result<Option<RunRow>, AppError> {
    let row = sqlx::query(&format!(
        "SELECT {RUN_COLUMNS} FROM ip_please_endless_runs WHERE run_id = ?"
    ))
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::db)?;
    row.as_ref().map(row_to_run).transpose()
}

pub async fn daily_run(
    pool: &MySqlPool,
    user_id: &str,
    date: &str,
) -> Result<Option<(String, bool)>, AppError> {
    let row = sqlx::query(
        "SELECT run_id, status FROM ip_please_endless_runs WHERE user_id = ? AND daily_date = ?",
    )
    .bind(user_id)
    .bind(date)
    .fetch_optional(pool)
    .await
    .map_err(AppError::db)?;
    row.map(|row| -> Result<(String, bool), AppError> {
        let status: String = row.try_get("status").map_err(AppError::db)?;
        Ok((
            row.try_get("run_id").map_err(AppError::db)?,
            status == "active",
        ))
    })
    .transpose()
}

pub fn step_error(err: StepError) -> AppError {
    match err {
        StepError::Conflict => AppError::Detail(DetailCode::EndlessStateConflict),
        StepError::TooEarly(secs) => AppError::DetailRetryAfter(DetailCode::RateLimited, secs),
        StepError::Invalid => AppError::Detail(DetailCode::ValidationError),
    }
}

async fn persist(
    tx: &mut Transaction<'_, MySql>,
    run: &RunRow,
    now: i64,
    event: (&str, &Value),
) -> Result<(), AppError> {
    let state = &run.state;
    let ended = state.ended();
    sqlx::query(
        "UPDATE ip_please_endless_runs SET
            state_json = ?, status = ?, end_reason = ?, active_user_id = ?, score = ?, travelers = ?,
            processed = ?, correct = ?, best_streak = ?, strikes = ?, flagged = ?, last_action_at_ms = ?,
            ended_at_ms = ?
         WHERE run_id = ?",
    )
    .bind(serde_json::to_string(state)?)
    .bind(if ended { "ended" } else { "active" })
    .bind(&state.end_reason)
    .bind(if ended { None } else { Some(&run.user_id) })
    .bind(state.score)
    .bind(state.travelers)
    .bind(state.processed)
    .bind(state.correct)
    .bind(state.best_streak)
    .bind(state.strikes)
    .bind(state.flagged())
    .bind(now)
    .bind(run.ended_at_ms)
    .bind(&run.run_id)
    .execute(&mut **tx)
    .await
    .map_err(AppError::db)?;

    sqlx::query(
        "INSERT INTO ip_please_endless_events (run_id, event_no, kind, at_ms, data)
         SELECT ?, COALESCE(MAX(event_no), 0) + 1, ?, ?, ? FROM ip_please_endless_events WHERE run_id = ?",
    )
    .bind(&run.run_id)
    .bind(event.0)
    .bind(now)
    .bind(event.1.to_string())
    .bind(&run.run_id)
    .execute(&mut **tx)
    .await
    .map_err(AppError::db)?;
    Ok(())
}

/// 对局结束：写排行榜（同一榜同一周期只保留个人最高分；可疑对局不上榜）。
async fn finalize(tx: &mut Transaction<'_, MySql>, run: &RunRow, now: i64) -> Result<(), AppError> {
    let state = &run.state;
    if state.flagged() {
        tracing::warn!(run_id = %run.run_id, violations = state.timing_violations, "flagged run kept off the leaderboard");
        return Ok(());
    }
    for (board, period) in boards_for(state.mode, state.daily_date.as_deref(), now) {
        sqlx::query(
            "INSERT INTO ip_please_leaderboard
                (board, period, user_id, run_id, score, travelers, best_streak, achieved_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                run_id = IF(VALUES(score) > score, VALUES(run_id), run_id),
                travelers = IF(VALUES(score) > score, VALUES(travelers), travelers),
                best_streak = IF(VALUES(score) > score, VALUES(best_streak), best_streak),
                achieved_at_ms = IF(VALUES(score) > score, VALUES(achieved_at_ms), achieved_at_ms),
                score = GREATEST(score, VALUES(score))",
        )
        .bind(board)
        .bind(&period)
        .bind(&run.user_id)
        .bind(&run.run_id)
        .bind(state.score)
        .bind(state.travelers)
        .bind(state.best_streak)
        .bind(now)
        .execute(&mut **tx)
        .await
        .map_err(AppError::db)?;
    }
    Ok(())
}

/// 在锁内对一局做一次状态变更。闲置 / 超时的对局先结算（返回 409，提示前端重新同步）。
pub async fn mutate<T>(
    pool: &MySqlPool,
    run_id: &str,
    user_id: &str,
    now: i64,
    kind: &str,
    step: impl FnOnce(&mut RunState) -> Result<(T, Value), StepError>,
) -> Result<(T, RunRow), AppError> {
    let mut tx = pool.begin().await.map_err(AppError::db)?;
    let row = sqlx::query(&format!(
        "SELECT {RUN_COLUMNS} FROM ip_please_endless_runs WHERE run_id = ? AND user_id = ? FOR UPDATE"
    ))
    .bind(run_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::db)?
    .ok_or(AppError::Detail(DetailCode::NotFound))?;
    let mut run = row_to_run(&row)?;

    if let Some(reason) = run
        .state
        .expiry(run.started_at_ms, run.last_action_at_ms, now)
    {
        run.state.end(reason);
        run.ended_at_ms = Some(now);
        persist(&mut tx, &run, now, ("expire", &json!({ "reason": reason }))).await?;
        finalize(&mut tx, &run, now).await?;
        tx.commit().await.map_err(AppError::db)?;
        return Err(AppError::Detail(DetailCode::EndlessStateConflict));
    }

    let was_ended = run.state.ended();
    let (value, log) = step(&mut run.state).map_err(step_error)?;
    let ended_now = !was_ended && run.state.ended();
    if ended_now {
        run.ended_at_ms = Some(now);
    }
    persist(&mut tx, &run, now, (kind, &log)).await?;
    if ended_now {
        finalize(&mut tx, &run, now).await?;
    }
    tx.commit().await.map_err(AppError::db)?;
    Ok((value, run))
}

/// 后台任务：结算闲置 / 超时的对局。
pub async fn expire_stale(pool: &MySqlPool, now: i64) -> Result<u64, AppError> {
    let rows = sqlx::query(
        "SELECT run_id, user_id FROM ip_please_endless_runs
         WHERE status = 'active' AND (last_action_at_ms < ? OR started_at_ms < ?)",
    )
    .bind(now - super::state::IDLE_MS)
    .bind(now - super::state::DAILY_MAX_MS)
    .fetch_all(pool)
    .await
    .map_err(AppError::db)?;
    let mut expired = 0;
    for row in rows {
        let run_id: String = row.try_get("run_id").map_err(AppError::db)?;
        let user_id: String = row.try_get("user_id").map_err(AppError::db)?;
        // 无尽与每日的时长上限不同：先确认真的过期，再进锁结算（mutate 结算后返回 409）
        let Some(run) = load(pool, &run_id).await? else {
            continue;
        };
        if run
            .state
            .expiry(run.started_at_ms, run.last_action_at_ms, now)
            .is_none()
        {
            continue;
        }
        let _ = mutate(
            pool,
            &run_id,
            &user_id,
            now,
            "noop",
            |_| -> Result<((), Value), StepError> { Err(StepError::Conflict) },
        )
        .await;
        expired += 1;
    }
    Ok(expired)
}

// ———————————————————— 视图 ————————————————————

pub fn run_view(run: &RunRow) -> Value {
    let mut view = run.state.view_summary();
    view["run_id"] = json!(run.run_id);
    view["started_at"] = json!(iso_from_ms(run.started_at_ms));
    view["expires_at"] = json!(unix_secs(
        run.started_at_ms + run.state.mode.max_duration_ms()
    ));
    view["idle_expires_at"] = json!(unix_secs(run.last_action_at_ms + super::state::IDLE_MS));
    view["flagged"] = json!(run.state.flagged());
    view
}

/// 结束后的结算视图（含各榜名次）。
pub async fn final_view(pool: &MySqlPool, run: &RunRow) -> Result<Value, AppError> {
    let state = &run.state;
    let ended_ms = run.ended_at_ms.unwrap_or(run.last_action_at_ms);
    let mut ranks = serde_json::Map::new();
    let mut personal_best = Value::Null;
    for (board, period) in boards_for(state.mode, state.daily_date.as_deref(), ended_ms) {
        let mine = my_entry(pool, board, &period, &run.user_id).await?;
        if board != "weekly" {
            personal_best = mine.as_ref().map(|m| json!(m.1)).unwrap_or(Value::Null);
        }
        ranks.insert(
            board.to_string(),
            mine.map(|(rank, _)| json!(rank)).unwrap_or(Value::Null),
        );
    }
    Ok(json!({
        "run_id": run.run_id,
        "mode": state.mode,
        "daily_date": state.daily_date,
        "score": state.score,
        "travelers": state.travelers,
        "processed": state.processed,
        "correct": state.correct,
        "best_streak": state.best_streak,
        "end_reason": state.end_reason,
        "flagged": state.flagged(),
        "ranks": ranks,
        "personal_best": personal_best,
    }))
}

/// 自己在某榜的 (名次, 分数)。
async fn my_entry(
    pool: &MySqlPool,
    board: &str,
    period: &str,
    user_id: &str,
) -> Result<Option<(i64, i64)>, AppError> {
    let row = sqlx::query(
        "SELECT score, achieved_at_ms FROM ip_please_leaderboard WHERE board = ? AND period = ? AND user_id = ?",
    )
    .bind(board)
    .bind(period)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::db)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let score: i64 = row.try_get("score").map_err(AppError::db)?;
    let achieved: i64 = row.try_get("achieved_at_ms").map_err(AppError::db)?;
    let better: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ip_please_leaderboard
         WHERE board = ? AND period = ? AND (score > ? OR (score = ? AND achieved_at_ms < ?))",
    )
    .bind(board)
    .bind(period)
    .bind(score)
    .bind(score)
    .bind(achieved)
    .fetch_one(pool)
    .await
    .map_err(AppError::db)?;
    Ok(Some((better + 1, score)))
}

pub async fn leaderboard(
    pool: &MySqlPool,
    board: &str,
    period: &str,
    limit: i64,
    viewer: Option<(&str, bool)>,
) -> Result<Value, AppError> {
    let rows = sqlx::query(
        "SELECT l.user_id, l.score, l.travelers, l.best_streak, l.achieved_at_ms, p.nickname
         FROM ip_please_leaderboard l
         LEFT JOIN ip_please_profiles p ON p.user_id = l.user_id
         WHERE l.board = ? AND l.period = ?
         ORDER BY l.score DESC, l.achieved_at_ms ASC
         LIMIT ?",
    )
    .bind(board)
    .bind(period)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(AppError::db)?;
    let is_admin = viewer.is_some_and(|(_, admin)| admin);
    let mut entries = Vec::with_capacity(rows.len());
    for (i, row) in rows.iter().enumerate() {
        let user_id: String = row.try_get("user_id").map_err(AppError::db)?;
        let nickname: Option<String> = row.try_get("nickname").map_err(AppError::db)?;
        let mut entry = json!({
            "rank": i + 1,
            "nickname": nickname.unwrap_or_else(|| "审查员".to_string()),
            "tag": profile::display_tag(&user_id),
            "score": row.try_get::<i64, _>("score").map_err(AppError::db)?,
            "travelers": row.try_get::<i32, _>("travelers").map_err(AppError::db)?,
            "best_streak": row.try_get::<i32, _>("best_streak").map_err(AppError::db)?,
            "achieved_at": iso_from_ms(row.try_get("achieved_at_ms").map_err(AppError::db)?),
            "me": viewer.is_some_and(|(id, _)| id == user_id),
        });
        if is_admin {
            entry["user_id"] = json!(user_id);
        }
        entries.push(entry);
    }
    let me = match viewer {
        Some((user_id, _)) => my_entry(pool, board, period, user_id)
            .await?
            .map(|(rank, score)| json!({ "rank": rank, "score": score }))
            .unwrap_or(Value::Null),
        None => Value::Null,
    };
    Ok(json!({ "board": board, "period": period, "entries": entries, "me": me }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn east8_periods() {
        // 2026-10-23T16:30:00Z = 2026-10-24 00:30 东八区
        let ms = Utc
            .with_ymd_and_hms(2026, 10, 23, 16, 30, 0)
            .unwrap()
            .timestamp_millis();
        assert_eq!(daily_date(ms), "2026-10-24");
        assert_eq!(iso_week(ms), "2026-W43");
        let reset = next_reset_secs(ms);
        assert_eq!(
            reset,
            Utc.with_ymd_and_hms(2026, 10, 24, 16, 0, 0)
                .unwrap()
                .timestamp()
        );
        assert_eq!(
            boards_for(Mode::Endless, None, ms),
            vec![
                ("endless", "all".to_string()),
                ("weekly", "2026-W43".to_string())
            ]
        );
        assert_eq!(
            boards_for(Mode::Daily, Some("2026-10-24"), ms),
            vec![("daily", "2026-10-24".to_string())]
        );
    }
}
