use super::auth::Principal;
use crate::{
    endless::store::{boards_for, RunRow},
    error::AppError,
    ids, profile,
    util::{iso_from_ms, now_ms, sha256_hex},
};
use serde_json::{json, Value};
use sqlx::{MySql, MySqlConnection, MySqlPool, Row, Transaction};
#[derive(Clone)]
pub struct Account {
    pub user_id: String,
    pub identity_key: String,
    pub scope_key: String,
    pub linuxdo_id: String,
}
impl Principal {
    pub fn scope_key(&self) -> String {
        sha256_hex(json!([self.iss, self.app_id]).to_string().as_bytes())
    }
    pub fn identity_key(&self) -> String {
        sha256_hex(
            json!([self.iss, self.app_id, self.sub])
                .to_string()
                .as_bytes(),
        )
    }
}
pub async fn account(pool: &MySqlPool, p: &Principal) -> Result<Account, AppError> {
    let key = p.identity_key();
    sqlx::query("INSERT INTO ip_please_mapp_users (identity_key,issuer,app_id,channel,linuxdo_id,user_id,created_at_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE identity_key=identity_key")

        .bind(&key)
        .bind(&p.iss)
        .bind(&p.app_id)
        .bind(&p.channel)
        .bind(&p.sub)
        .bind(ids::generate(ids::PREFIX_USER))
        .bind(now_ms())
        .execute(pool).await.map_err(AppError::db)?;
    let user_id =
        sqlx::query_scalar("SELECT user_id FROM ip_please_mapp_users WHERE identity_key=?")
            .bind(&key)
            .fetch_one(pool)
            .await
            .map_err(AppError::db)?;
    Ok(Account {
        user_id,
        identity_key: key,
        scope_key: p.scope_key(),
        linuxdo_id: p.sub.clone(),
    })
}
pub async fn user(pool: &MySqlPool, a: &Account) -> Result<Value, AppError> {
    let p = profile::load(pool, &a.user_id).await?;
    Ok(
        json!({"user_id":a.user_id,"linuxdo_id":a.linuxdo_id,"display_name":p.display_name,"avatar_url":null,"tag":profile::display_tag(&a.user_id)}),
    )
}
pub async fn finalize(
    tx: &mut Transaction<'_, MySql>,
    run: &RunRow,
    now: i64,
    scope: &str,
) -> Result<(), AppError> {
    let s = &run.state;
    if s.flagged() {
        return Ok(());
    }
    for (board, period) in boards_for(s.mode, s.daily_date.as_deref(), now) {
        sqlx::query("INSERT INTO ip_please_mapp_leaderboard (scope_key,board,period,user_id,run_id,score,travelers,best_streak,achieved_at_ms) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE run_id=IF(VALUES(score)>score,VALUES(run_id),run_id),travelers=IF(VALUES(score)>score,VALUES(travelers),travelers),best_streak=IF(VALUES(score)>score,VALUES(best_streak),best_streak),achieved_at_ms=IF(VALUES(score)>score,VALUES(achieved_at_ms),achieved_at_ms),score=GREATEST(score,VALUES(score))")

        .bind(scope)
        .bind(board)
        .bind(period)
        .bind(&run.user_id)
        .bind(&run.run_id)
        .bind(s.score)
        .bind(s.travelers)
        .bind(s.best_streak)
        .bind(now)
        .execute(&mut **tx).await.map_err(AppError::db)?;
    }
    Ok(())
}
pub async fn my_entry(
    conn: &mut MySqlConnection,
    scope: &str,
    board: &str,
    period: &str,
    user_id: &str,
) -> Result<Option<(i64, i64)>, AppError> {
    let row = sqlx::query("SELECT score,achieved_at_ms FROM ip_please_mapp_leaderboard WHERE scope_key=? AND board=? AND period=? AND user_id=?")

        .bind(scope)
        .bind(board)
        .bind(period)
        .bind(user_id)
        .fetch_optional(&mut *conn).await.map_err(AppError::db)?;
    let Some(row) = row else { return Ok(None) };
    let score: i64 = row.try_get("score").map_err(AppError::db)?;
    let at: i64 = row.try_get("achieved_at_ms").map_err(AppError::db)?;
    let better:i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ip_please_mapp_leaderboard WHERE scope_key=? AND board=? AND period=? AND (score>? OR (score=? AND achieved_at_ms<?))")

        .bind(scope)
        .bind(board)
        .bind(period)
        .bind(score)
        .bind(score)
        .bind(at)
        .fetch_one(conn).await.map_err(AppError::db)?;
    Ok(Some((better + 1, score)))
}
pub async fn leaderboard(
    pool: &MySqlPool,
    a: &Account,
    board: &str,
    period: &str,
    limit: i64,
) -> Result<Value, AppError> {
    let rows = sqlx::query("SELECT l.*,u.linuxdo_id,p.display_name FROM ip_please_mapp_leaderboard l JOIN ip_please_mapp_users u ON l.user_id=u.user_id LEFT JOIN ip_please_player_profiles p ON p.user_id=l.user_id WHERE l.scope_key=? AND l.board=? AND l.period=? ORDER BY l.score DESC,l.achieved_at_ms ASC LIMIT ?")

        .bind(&a.scope_key)
        .bind(board)
        .bind(period)
        .bind(limit.clamp(1,100))
        .fetch_all(pool).await.map_err(AppError::db)?;
    let mut entries = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let uid: String = r.try_get("user_id").map_err(AppError::db)?;
        entries.push(json!({"rank":i+1,"linuxdo_id":r.try_get::<String,_>("linuxdo_id").map_err(AppError::db)?,"display_name":r.try_get::<Option<String>,_>("display_name").map_err(AppError::db)?.unwrap_or_else(||profile::FALLBACK_NAME.into()),"avatar_url":null,"tag":profile::display_tag(&uid),"score":r.try_get::<i64,_>("score").map_err(AppError::db)?,"travelers":r.try_get::<i32,_>("travelers").map_err(AppError::db)?,"best_streak":r.try_get::<i32,_>("best_streak").map_err(AppError::db)?,"achieved_at":iso_from_ms(r.try_get("achieved_at_ms").map_err(AppError::db)?),"me":uid==a.user_id}));
    }
    let mut conn = pool.acquire().await.map_err(AppError::db)?;
    let me = my_entry(&mut conn, &a.scope_key, board, period, &a.user_id)
        .await?
        .map(|(rank, score)| json!({"rank":rank,"score":score,"linuxdo_id":a.linuxdo_id}));
    Ok(json!({"board":board,"period":period,"entries":entries,"me":me}))
}
