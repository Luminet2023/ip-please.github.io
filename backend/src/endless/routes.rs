//! `/anthropic/v1/endless/*`：开局、发下一位、指认、测谎、判定、波次结算、放弃、每日挑战、排行榜。

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{json, Value};

use super::model::Decision;
use super::rng;
use super::state::{Claim, Mode, RunState, StepError};
use super::store::{self, RunRow};
use crate::auth::{AuthUser, OptionalAuthUser};
use crate::error::{private_json, AppError, DetailCode};
use crate::extract::{JsonBody, PathId, PathIds, QueryParams};
use crate::ids;
use crate::ratelimit;
use crate::util::now_ms;
use crate::{client_ip, AppState};

async fn with_final(state: &AppState, mut body: Value, run: &RunRow) -> Result<Value, AppError> {
    body["run"] = store::run_view(run);
    body["final"] = if run.state.ended() {
        store::final_view(&state.pool, run).await?
    } else {
        Value::Null
    };
    Ok(body)
}

fn check_run_id(run_id: &str) -> Result<(), AppError> {
    ids::require(run_id, ids::PREFIX_RUN)
}

// ———————————————————— 开局 / 当前对局 ————————————————————

#[derive(Debug, Deserialize)]
pub struct StartRequest {
    mode: String,
}

pub async fn start(
    State(state): State<AppState>,
    user: AuthUser,
    JsonBody(request): JsonBody<StartRequest>,
) -> Result<Response, AppError> {
    let mode = match request.mode.as_str() {
        "endless" => Mode::Endless,
        "daily" => Mode::Daily,
        _ => return Err(AppError::Detail(DetailCode::ValidationError)),
    };
    state
        .limiter
        .check(ratelimit::ENDLESS_START, &user.user_id)?;
    let now = now_ms();
    let (seed, date) = match mode {
        Mode::Endless => (rng::random_seed(), None),
        Mode::Daily => {
            let date = store::daily_date(now);
            (
                rng::daily_seed(&state.config.endless_seed_secret, &date),
                Some(date),
            )
        }
    };
    let run_state = RunState::new(mode, &seed, date);
    let run_id = store::create(&state.pool, &user.user_id, &run_state, now).await?;
    let run = store::load(&state.pool, &run_id)
        .await?
        .ok_or(AppError::Detail(DetailCode::NotFound))?;
    tracing::info!(user_id = %user.user_id, run_id = %run_id, mode = mode.as_str(), "endless run started");
    Ok(private_json(
        StatusCode::CREATED,
        json!({ "run": store::run_view(&run), "item": null }),
    ))
}

/// 刷新页面后接着玩：返回进行中的对局与待处理的旅客 / 波次。
pub async fn current(State(state): State<AppState>, user: AuthUser) -> Result<Response, AppError> {
    let run_id = store::active_run_id(&state.pool, &user.user_id)
        .await?
        .ok_or(AppError::Detail(DetailCode::NotFound))?;
    let run = store::load(&state.pool, &run_id)
        .await?
        .ok_or(AppError::Detail(DetailCode::NotFound))?;
    let now = now_ms();
    if run
        .state
        .expiry(run.started_at_ms, run.last_action_at_ms, now)
        .is_some()
    {
        // 已经闲置 / 超时：结算掉，当作没有进行中的对局
        let _ = store::mutate(&state.pool, &run_id, &user.user_id, now, "noop", |_| {
            Err::<((), Value), _>(StepError::Conflict)
        })
        .await;
        return Err(AppError::Detail(DetailCode::NotFound));
    }
    Ok(private_json(
        StatusCode::OK,
        json!({ "run": store::run_view(&run), "item": run.state.view_item() }),
    ))
}

pub async fn get_run(
    State(state): State<AppState>,
    user: AuthUser,
    PathId(run_id): PathId,
) -> Result<Response, AppError> {
    check_run_id(&run_id)?;
    let run = store::load(&state.pool, &run_id)
        .await?
        .filter(|run| run.user_id == user.user_id || user.is_admin)
        .ok_or(AppError::Detail(DetailCode::NotFound))?;
    let body = with_final(&state, json!({}), &run).await?;
    Ok(private_json(StatusCode::OK, body))
}

// ———————————————————— 对局内操作 ————————————————————

async fn act(
    state: &AppState,
    user: &AuthUser,
    run_id: &str,
    kind: &str,
    step: impl FnOnce(&mut RunState, i64) -> Result<(Value, Value), StepError>,
) -> Result<(Value, RunRow), AppError> {
    check_run_id(run_id)?;
    state
        .limiter
        .check(ratelimit::ENDLESS_ACTION, &user.user_id)?;
    let now = now_ms();
    store::mutate(&state.pool, run_id, &user.user_id, now, kind, |run| {
        step(run, now)
    })
    .await
}

pub async fn next(
    State(state): State<AppState>,
    user: AuthUser,
    PathId(run_id): PathId,
) -> Result<Response, AppError> {
    let (item, run) = act(&state, &user, &run_id, "next", |run, now| {
        let mut new_id = |prefix: &str| ids::generate(prefix);
        let item = run.next(now, &mut new_id)?;
        let log = json!({ "slot": run.slot });
        Ok((item, log))
    })
    .await?;
    Ok(private_json(
        StatusCode::OK,
        json!({ "run": store::run_view(&run), "item": item }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct InspectRequest {
    entrant_id: String,
    #[serde(default)]
    fields: Option<Vec<String>>,
    #[serde(default)]
    say: Option<usize>,
}

pub async fn inspect(
    State(state): State<AppState>,
    user: AuthUser,
    PathId(run_id): PathId,
    JsonBody(request): JsonBody<InspectRequest>,
) -> Result<Response, AppError> {
    ids::require(&request.entrant_id, ids::PREFIX_ENTRANT)?;
    let claim = match (request.fields, request.say) {
        (Some(fields), None) => Claim::Fields(fields),
        (None, Some(say)) => Claim::Say(say),
        _ => return Err(AppError::Detail(DetailCode::ValidationError)),
    };
    let entrant_id = request.entrant_id;
    let (result, _run) = act(&state, &user, &run_id, "inspect", move |run, _now| {
        let result = run.inspect(&entrant_id, claim)?;
        let log = json!({ "entrant_id": entrant_id, "match": result["match"] });
        Ok((result, log))
    })
    .await?;
    Ok(private_json(StatusCode::OK, result))
}

#[derive(Debug, Deserialize)]
pub struct EntrantRequest {
    entrant_id: String,
}

pub async fn quiz(
    State(state): State<AppState>,
    user: AuthUser,
    PathId(run_id): PathId,
    JsonBody(request): JsonBody<EntrantRequest>,
) -> Result<Response, AppError> {
    ids::require(&request.entrant_id, ids::PREFIX_ENTRANT)?;
    let entrant_id = request.entrant_id;
    let (result, _run) = act(&state, &user, &run_id, "quiz", move |run, _now| {
        let result = run.quiz(&entrant_id)?;
        let log = json!({ "entrant_id": entrant_id, "exposed": result["exposed"] });
        Ok((result, log))
    })
    .await?;
    Ok(private_json(StatusCode::OK, result))
}

#[derive(Debug, Deserialize)]
pub struct DecisionRequest {
    entrant_id: String,
    decision: String,
}

pub async fn decide(
    State(state): State<AppState>,
    user: AuthUser,
    PathId(run_id): PathId,
    JsonBody(request): JsonBody<DecisionRequest>,
) -> Result<Response, AppError> {
    ids::require(&request.entrant_id, ids::PREFIX_ENTRANT)?;
    let decision =
        Decision::parse(&request.decision).ok_or(AppError::Detail(DetailCode::ValidationError))?;
    let entrant_id = request.entrant_id;
    let (result, run) = act(&state, &user, &run_id, "decision", move |run, now| {
        let result = run.decide(&entrant_id, decision, now)?;
        let log = json!({
            "entrant_id": entrant_id,
            "decision": decision,
            "correct": result["correct"],
            "points": result["points"],
        });
        Ok((result, log))
    })
    .await?;
    let body = with_final(&state, result, &run).await?;
    Ok(private_json(StatusCode::OK, body))
}

pub async fn wave_result(
    State(state): State<AppState>,
    user: AuthUser,
    PathIds(run_id, wave_id): PathIds,
    JsonBody(payload): JsonBody<Value>,
) -> Result<Response, AppError> {
    ids::require(&wave_id, ids::PREFIX_WAVE)?;
    let (result, run) = act(&state, &user, &run_id, "wave", move |run, now| {
        let result = run.wave_result(&wave_id, &payload, now)?;
        let log = json!({ "wave_id": wave_id, "hits": result["hits"], "points": result["points"] });
        Ok((result, log))
    })
    .await?;
    let body = with_final(&state, result, &run).await?;
    Ok(private_json(StatusCode::OK, body))
}

pub async fn abandon(
    State(state): State<AppState>,
    user: AuthUser,
    PathId(run_id): PathId,
) -> Result<Response, AppError> {
    let (_, run) = act(&state, &user, &run_id, "abandon", |run, _now| {
        if run.ended() {
            return Err(StepError::Conflict);
        }
        run.end("abandon");
        Ok((Value::Null, json!({})))
    })
    .await?;
    let body = with_final(&state, json!({}), &run).await?;
    Ok(private_json(StatusCode::OK, body))
}

// ———————————————————— 每日挑战 / 排行榜（公开） ————————————————————

pub async fn daily(
    State(state): State<AppState>,
    headers: HeaderMap,
    OptionalAuthUser(user): OptionalAuthUser,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(ratelimit::PUBLIC_READ, &client_ip(&state, &headers))?;
    let now = now_ms();
    let date = store::daily_date(now);
    let mine = match &user {
        Some(user) => store::daily_run(&state.pool, &user.user_id, &date).await?,
        None => None,
    };
    Ok(private_json(
        StatusCode::OK,
        json!({
            "date": date,
            "played": mine.is_some(),
            "in_progress": mine.as_ref().is_some_and(|(_, active)| *active),
            "run_id": mine.map(|(run_id, _)| run_id),
            "travelers": super::generator::DAILY_TRAVELERS,
            "resets_at": store::next_reset_secs(now),
        }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct LeaderboardQuery {
    #[serde(default)]
    board: Option<String>,
    #[serde(default)]
    period: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

fn valid_period(board: &str, period: &str) -> bool {
    let bytes = period.as_bytes();
    match board {
        "endless" => period == "all",
        // 2026-W43
        "weekly" => {
            bytes.len() == 8
                && bytes[..4].iter().all(u8::is_ascii_digit)
                && &period[4..6] == "-W"
                && bytes[6..].iter().all(u8::is_ascii_digit)
        }
        // 2026-10-24
        "daily" => {
            bytes.len() == 10
                && bytes.iter().enumerate().all(|(i, b)| {
                    if i == 4 || i == 7 {
                        *b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                })
        }
        _ => false,
    }
}

pub async fn leaderboard(
    State(state): State<AppState>,
    headers: HeaderMap,
    OptionalAuthUser(user): OptionalAuthUser,
    QueryParams(query): QueryParams<LeaderboardQuery>,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(ratelimit::PUBLIC_READ, &client_ip(&state, &headers))?;
    let now = now_ms();
    let board = query.board.unwrap_or_else(|| "endless".to_string());
    let period = query.period.unwrap_or_else(|| match board.as_str() {
        "weekly" => store::iso_week(now),
        "daily" => store::daily_date(now),
        _ => "all".to_string(),
    });
    if !valid_period(&board, &period) {
        return Err(AppError::Detail(DetailCode::ValidationError));
    }
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let viewer = user.as_ref().map(|u| (u.user_id.as_str(), u.is_admin));
    let body = store::leaderboard(&state.pool, &board, &period, limit, viewer).await?;
    Ok(private_json(StatusCode::OK, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn periods() {
        assert!(valid_period("endless", "all"));
        assert!(!valid_period("endless", "2026"));
        assert!(valid_period("weekly", "2026-W43"));
        assert!(!valid_period("weekly", "2026-43"));
        assert!(valid_period("daily", "2026-10-24"));
        assert!(!valid_period("daily", "2026/10/24"));
        assert!(!valid_period("monthly", "2026-10"));
    }
}
