//! Fixed SDK endpoints. All mutations and their replay receipts share one transaction.
pub mod auth;
pub mod store;
use crate::{
    announcements,
    endless::{
        model::Decision,
        rng,
        routes::StartRequest,
        state::{Claim, Mode, RunState, StepError},
        store as runs,
    },
    error::{private_json, AppError, DetailCode},
    extract::{JsonBody, QueryParams},
    ids, profile as profiles, ratelimit, routes as saves,
    util::{now_ms, sha256_hex},
    AppState,
};
use auth::Principal;
use axum::{
    extract::State,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Acquire, MySql, Row, Transaction};
use store::Account;
fn invalid() -> AppError {
    AppError::Detail(DetailCode::ValidationError)
}
async fn daily(state: &AppState, a: &Account) -> Result<Value, AppError> {
    let now = now_ms();
    let date = runs::daily_date(now);
    let mine = runs::daily_run(&state.pool, &a.user_id, &date).await?;
    Ok(
        json!({"date":date,"played":mine.is_some(),"in_progress":mine.as_ref().is_some_and(|(_,active)|*active),"run_id":mine.map(|(id,_)|id),"travelers":crate::endless::generator::DAILY_TRAVELERS,"resets_at":runs::next_reset_secs(now)}),
    )
}
async fn current(state: &AppState, a: &Account) -> Result<Option<runs::RunRow>, AppError> {
    let Some(id) = runs::active_run_id(&state.pool, &a.user_id).await? else {
        return Ok(None);
    };
    let run = runs::load(&state.pool, &id)
        .await?
        .ok_or(AppError::Detail(DetailCode::NotFound))?;
    if run
        .state
        .expiry(run.started_at_ms, run.last_action_at_ms, now_ms())
        .is_some()
    {
        let result = runs::mutate(&state.pool, &id, &a.user_id, now_ms(), "noop", |_| {
            Err::<((), Value), _>(StepError::Conflict)
        })
        .await;
        match result {
            Err(AppError::Detail(DetailCode::EndlessStateConflict)) => {}
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        return Ok(None);
    }
    Ok(Some(run))
}
pub async fn bootstrap(State(state): State<AppState>, p: Principal) -> Result<Response, AppError> {
    let a = store::account(&state.pool, &p).await?;
    state.limiter.check(ratelimit::PUBLIC_READ, &a.user_id)?;
    let active = current(&state, &a).await?.map(|r| runs::run_view(&r));
    Ok(private_json(
        StatusCode::OK,
        json!({"channel":p.channel,"user":store::user(&state.pool,&a).await?,"announcements":announcements::active(&state.pool).await?["announcements"],"daily":daily(&state,&a).await?,"active_run":active}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileInput {
    id: String,
    username: String,
    name: Option<String>,
}
pub async fn profile(
    State(state): State<AppState>,
    p: Principal,
    JsonBody(input): JsonBody<ProfileInput>,
) -> Result<Response, AppError> {
    if input.id != p.sub {
        return Err(invalid());
    }
    let a = store::account(&state.pool, &p).await?;
    state.limiter.check(ratelimit::ENDLESS_ACTION, &a.user_id)?;
    let display_name = input
        .name
        .as_deref()
        .and_then(profiles::clean_name)
        .or_else(|| profiles::clean_name(&input.username))
        .unwrap_or_else(|| profiles::FALLBACK_NAME.into());
    profiles::save(
        &state.pool,
        &a.user_id,
        &profiles::Profile {
            display_name,
            avatar_url: None,
        },
        now_ms(),
    )
    .await
    .map_err(AppError::db)?;
    Ok(private_json(
        StatusCode::OK,
        store::user(&state.pool, &a).await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    op: String,
    save_id: Option<String>,
    run_id: Option<String>,
    board: Option<String>,
    period: Option<String>,
    limit: Option<i64>,
}
pub async fn query(
    State(state): State<AppState>,
    p: Principal,
    QueryParams(q): QueryParams<Query>,
) -> Result<Response, AppError> {
    let a = store::account(&state.pool, &p).await?;
    state.limiter.check(ratelimit::PUBLIC_READ, &a.user_id)?;
    let body = match q.op.as_str() {
        "save" => return saves::get_save_for(&state, &a.user_id).await,
        "snapshots" => {
            return saves::list_snapshots_for(&state, &a.user_id, q.limit.unwrap_or(50)).await
        }
        "snapshot" => {
            return saves::get_snapshot_for(
                &state,
                &a.user_id,
                q.save_id.as_deref().ok_or_else(invalid)?,
            )
            .await
        }
        "run_current" => {
            let r = current(&state, &a)
                .await?
                .ok_or(AppError::Detail(DetailCode::NotFound))?;
            json!({"run":runs::run_view(&r),"item":r.state.view_item()})
        }
        "run" => {
            let id = q.run_id.as_deref().ok_or_else(invalid)?;
            ids::require(id, ids::PREFIX_RUN)?;
            let r = runs::load(&state.pool, id)
                .await?
                .filter(|r| r.user_id == a.user_id)
                .ok_or(AppError::Detail(DetailCode::NotFound))?;
            json!({"run":runs::run_view(&r),"final":if r.state.ended(){runs::final_view(&state.pool,&r).await?}else{Value::Null}})
        }
        "daily" => {
            current(&state, &a).await?;
            daily(&state, &a).await?
        }
        "announcements" => announcements::active(&state.pool).await?,
        "leaderboard" => {
            let board = q.board.as_deref().unwrap_or("endless");
            let period = q.period.unwrap_or_else(|| match board {
                "weekly" => runs::iso_week(now_ms()),
                "daily" => runs::daily_date(now_ms()),
                _ => "all".into(),
            });
            if !crate::endless::routes::valid_period(board, &period) {
                return Err(invalid());
            }
            store::leaderboard(&state.pool, &a, board, &period, q.limit.unwrap_or(50)).await?
        }
        _ => return Err(invalid()),
    };
    Ok(private_json(StatusCode::OK, body))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    request_id: String,
    op: String,
    args: Value,
}
struct Outcome {
    status: StatusCode,
    body: Value,
    retry: Option<u64>,
}
impl Outcome {
    fn response(self) -> Response {
        let mut r = private_json(self.status, self.body);
        if let Some(retry) = self.retry {
            r.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&retry.to_string()).expect("integer"),
            );
        }
        r
    }
    async fn error(e: AppError) -> Result<Self, AppError> {
        let r = e.into_response();
        let status = r.status();
        let retry = r
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok());
        let bytes = axum::body::to_bytes(r.into_body(), 65536)
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        Ok(Self {
            status,
            body: serde_json::from_slice(&bytes)?,
            retry,
        })
    }
}
pub async fn action(
    State(state): State<AppState>,
    p: Principal,
    JsonBody(input): JsonBody<Action>,
) -> Result<Response, AppError> {
    if !ids::is_valid(&input.request_id, ids::PREFIX_REQUEST) {
        return Err(invalid());
    }
    let a = store::account(&state.pool, &p).await?;
    let hash =
        sha256_hex(serde_json::to_string(&json!({"op":input.op,"args":input.args}))?.as_bytes());
    let mut connection = state.pool.acquire().await.map_err(AppError::db)?;
    // Transaction-local isolation prevents unrelated first saves/receipts from taking
    // conflicting gap locks. The stable account row below still serializes this user.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        .execute(&mut *connection)
        .await
        .map_err(AppError::db)?;
    let mut tx = connection.begin().await.map_err(AppError::db)?;
    // A stable existing row avoids missing-row/gap-lock races and serializes all actions for this account.
    sqlx::query("SELECT user_id FROM ip_please_mapp_users WHERE identity_key=? FOR UPDATE")
        .bind(&a.identity_key)
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::db)?;
    let old = sqlx::query("SELECT payload_hash,status,body,retry_after FROM ip_please_mapp_receipts WHERE user_id=? AND request_id=?")
        .bind(&a.user_id)
        .bind(&input.request_id)
        .fetch_optional(&mut *tx).await.map_err(AppError::db)?;
    if let Some(row) = old {
        if row
            .try_get::<String, _>("payload_hash")
            .map_err(AppError::db)?
            != hash
        {
            return Err(AppError::Detail(DetailCode::MappRequestConflict));
        }
        let out = Outcome {
            status: StatusCode::from_u16(
                row.try_get::<i32, _>("status").map_err(AppError::db)? as u16
            )
            .map_err(|e| AppError::Internal(e.into()))?,
            body: serde_json::from_str(&row.try_get::<String, _>("body").map_err(AppError::db)?)?,
            retry: row
                .try_get::<Option<i64>, _>("retry_after")
                .map_err(AppError::db)?
                .map(|v| v as u64),
        };
        tx.commit().await.map_err(AppError::db)?;
        return Ok(out.response());
    }
    let result = execute(&state, &mut tx, &a, &input).await;
    let out = match result {
        Ok((status, body)) => Outcome {
            status,
            body,
            retry: None,
        },
        Err(e) => {
            if matches!(
                &e,
                AppError::Internal(_)
                    | AppError::Detail(
                        DetailCode::InternalError
                            | DetailCode::SyncUnavailable
                            | DetailCode::BackendUnavailable
                    )
            ) {
                return Err(e);
            }
            Outcome::error(e).await?
        }
    };
    // Transient failures have no accepted business effect. Keep the request ID reusable
    // after Retry-After; terminal business responses and successes are durable receipts.
    if out.status == StatusCode::TOO_MANY_REQUESTS {
        tx.rollback().await.map_err(AppError::db)?;
        return Ok(out.response());
    }
    sqlx::query("INSERT INTO ip_please_mapp_receipts (user_id,request_id,payload_hash,status,body,retry_after,created_at_ms) VALUES (?,?,?,?,?,?,?)")

        .bind(&a.user_id)
        .bind(&input.request_id)
        .bind(hash)
        .bind(i32::from(out.status.as_u16()))
        .bind(out.body.to_string())
        .bind(out.retry.map(|v|v as i64))
        .bind(now_ms())
        .execute(&mut *tx).await.map_err(AppError::db)?;
    tx.commit().await.map_err(AppError::db)?;
    Ok(out.response())
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, AppError> {
    v[k].as_str().ok_or_else(invalid)
}
fn fields(args: &Value, allowed: &[&str]) -> Result<(), AppError> {
    if args
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return Err(invalid());
    }
    Ok(())
}
async fn execute(
    state: &AppState,
    tx: &mut Transaction<'_, MySql>,
    a: &Account,
    input: &Action,
) -> Result<(StatusCode, Value), AppError> {
    let args = &input.args;
    let now = now_ms();
    state.limiter.check(ratelimit::ENDLESS_ACTION, &a.user_id)?;
    if input.op == "save" {
        fields(args, &["day", "payload", "base_version"])?;
        let upload: saves::SaveUpload =
            serde_json::from_value(args.clone()).map_err(|_| invalid())?;
        saves::validate_upload(&upload, state.config.max_payload_bytes)?;
        state.limiter.check(
            crate::ratelimit::Rule {
                bucket: "mapp_save",
                limit: u32::from(state.config.rate_limit_seconds > 0),
                window: std::time::Duration::from_secs(state.config.rate_limit_seconds),
                code: DetailCode::SyncRateLimited,
            },
            &a.user_id,
        )?;
        return Ok((
            StatusCode::OK,
            saves::save_in_tx(tx, &a.user_id, &upload).await?,
        ));
    }
    if input.op == "run_start" {
        fields(args, &["mode", "client_rules_version"])?;
        let request: StartRequest = serde_json::from_value(args.clone()).map_err(|_| invalid())?;
        request.validate_rules()?;
        let mode = match request.mode.as_str() {
            "daily" => Mode::Daily,
            "endless" => Mode::Endless,
            _ => return Err(invalid()),
        };
        state.limiter.check(ratelimit::ENDLESS_START, &a.user_id)?;
        let (seed, date) = match mode {
            Mode::Daily => {
                let d = runs::daily_date(now);
                (
                    rng::daily_seed(&state.config.endless_seed_secret, &d),
                    Some(d),
                )
            }
            Mode::Endless => (rng::random_seed(), None),
        };
        let id = runs::create(
            &mut **tx,
            &a.user_id,
            &RunState::new(mode, &seed, date),
            now,
        )
        .await?;
        sqlx::query(
            "INSERT INTO ip_please_mapp_run_sources (run_id,identity_key,scope_key) VALUES (?,?,?)",
        )
        .bind(&id)
        .bind(&a.identity_key)
        .bind(&a.scope_key)
        .execute(&mut **tx)
        .await
        .map_err(AppError::db)?;
        let run = runs::load(&mut **tx, &id)
            .await?
            .ok_or(AppError::Detail(DetailCode::NotFound))?;
        return Ok((
            StatusCode::CREATED,
            json!({"run":runs::run_view(&run),"item":null}),
        ));
    }
    let allowed: &[&str] = match input.op.as_str() {
        "run_next" | "run_abandon" => &["run_id"],
        "run_inspect" => &["run_id", "entrant_id", "fields", "say"],
        "run_quiz" => &["run_id", "entrant_id"],
        "run_decision" => &["run_id", "entrant_id", "decision"],
        "wave_result" => &["run_id", "wave_id", "picks", "hits"],
        _ => return Err(invalid()),
    };
    fields(args, allowed)?;
    let id = text(args, "run_id")?;
    ids::require(id, ids::PREFIX_RUN)?;
    let entrant =
        if input.op == "run_inspect" || input.op == "run_quiz" || input.op == "run_decision" {
            let id = text(args, "entrant_id")?;
            ids::require(id, ids::PREFIX_ENTRANT)?;
            id
        } else {
            ""
        };
    let wave = if input.op == "wave_result" {
        let id = text(args, "wave_id")?;
        ids::require(id, ids::PREFIX_WAVE)?;
        id
    } else {
        ""
    };
    let kind = input.op.strip_prefix("run_").unwrap_or("wave");
    let(value,run)=runs::mutate_tx(tx,id,&a.user_id,now,kind,|run|{
        let value=match input.op.as_str(){
            "run_next"=>run.next(now,&mut ids::generate)?,
            "run_inspect"=>{let claim=match(args.get("fields"),args.get("say")){(Some(f),None)=>Claim::Fields(serde_json::from_value(f.clone()).map_err(|_|StepError::Invalid)?),(None,Some(s))=>Claim::Say(s.as_u64().and_then(|n|usize::try_from(n).ok()).ok_or(StepError::Invalid)?),_=>return Err(StepError::Invalid)};run.inspect(entrant,claim)?},
            "run_quiz"=>run.quiz(entrant)?,
            "run_decision"=>run.decide(entrant,Decision::parse(args["decision"].as_str().ok_or(StepError::Invalid)?).ok_or(StepError::Invalid)?,now)?,
            "wave_result"=>run.wave_result(wave,args,now)?,
            "run_abandon"=>{if run.ended(){return Err(StepError::Conflict)}run.end("abandon");json!({})},
            _=>return Err(StepError::Invalid),
        };
        // Do not persist arbitrary client payloads or hidden state in event audit data.
        let log=json!({"entrant_id":if entrant.is_empty(){None}else{Some(entrant)},"wave_id":if wave.is_empty(){None}else{Some(wave)},"slot":run.slot,"points":value["points"]});
        Ok((value,log))
    }).await?;
    let body = match input.op.as_str() {
        "run_next" => json!({"run":runs::run_view(&run),"item":value}),
        "run_inspect" | "run_quiz" => value,
        _ => {
            let mut body = value;
            body["run"] = runs::run_view(&run);
            body["final"] = if run.state.ended() {
                runs::final_view_conn(tx, &run).await?
            } else {
                Value::Null
            };
            body
        }
    };
    Ok((StatusCode::OK, body))
}
