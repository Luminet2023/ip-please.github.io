//! 服务器端会话（`sess_*`）与 Refresh Token 轮换。
//!
//! - 会话：闲置上限（每次刷新顺延）+ 绝对上限；吊销后所有 AT 立即失效（每次请求查库）。
//! - RT：每次刷新换新；旧 RT 在 10 秒内重放视为多标签页竞态（`invalid_token`，客户端重读存储），
//!   超过 10 秒重放视为泄露，吊销整个会话（`token_revoked`）。

use sqlx::{MySqlPool, Row};

use crate::auth::tokens::{new_refresh_token, refresh_token_hash};
use crate::config::Config;
use crate::error::{AppError, AuthErrorCode};
use crate::ids;
use crate::profile;

pub const REUSE_GRACE_MS: i64 = 10_000;

#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub session_id: String,
    pub user_id: String,
    pub is_admin: bool,
    pub created_at_ms: i64,
    pub idle_expires_at_ms: i64,
    pub expires_at_ms: i64,
    pub revoked_at_ms: Option<i64>,
}

impl SessionRecord {
    /// 会话在 `now` 时是否仍可用于 AT（闲置上限只在刷新时检查）。
    pub fn active_for_access(&self, now: i64) -> bool {
        self.revoked_at_ms.is_none() && now < self.expires_at_ms
    }
}

/// 新会话签发的凭据（AT 由调用方用 `TokenSigner` 另行签发）。
#[derive(Debug, Clone)]
pub struct Issued {
    pub session_id: String,
    pub user_id: String,
    pub is_admin: bool,
    pub refresh_token: String,
    pub refresh_expires_at_ms: i64,
    pub session_expires_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshDecision {
    Rotate,
    StaleInGrace,
    Reuse,
    Expired,
    Revoked,
}

/// RT 刷新判定（纯函数）。
pub fn classify_refresh(
    rt_expires_at_ms: i64,
    rt_used_at_ms: Option<i64>,
    session: &SessionRecord,
    now: i64,
) -> RefreshDecision {
    if session.revoked_at_ms.is_some() {
        return RefreshDecision::Revoked;
    }
    if now >= session.expires_at_ms || now >= session.idle_expires_at_ms {
        return RefreshDecision::Expired;
    }
    if let Some(used_at) = rt_used_at_ms {
        return if now - used_at <= REUSE_GRACE_MS {
            RefreshDecision::StaleInGrace
        } else {
            RefreshDecision::Reuse
        };
    }
    if now >= rt_expires_at_ms {
        return RefreshDecision::Expired;
    }
    RefreshDecision::Rotate
}

fn row_to_session(row: &sqlx::mysql::MySqlRow) -> Result<SessionRecord, sqlx::Error> {
    Ok(SessionRecord {
        session_id: row.try_get("session_id")?,
        user_id: row.try_get("user_id")?,
        is_admin: row.try_get("is_admin")?,
        created_at_ms: row.try_get("created_at_ms")?,
        idle_expires_at_ms: row.try_get("idle_expires_at_ms")?,
        expires_at_ms: row.try_get("expires_at_ms")?,
        revoked_at_ms: row.try_get("revoked_at_ms")?,
    })
}

const SESSION_COLUMNS: &str = "session_id, user_id, is_admin, created_at_ms, idle_expires_at_ms, \
     expires_at_ms, revoked_at_ms";

pub async fn find(
    pool: &MySqlPool,
    session_id: &str,
) -> Result<Option<SessionRecord>, sqlx::Error> {
    let row = sqlx::query(&format!(
        "SELECT {SESSION_COLUMNS} FROM ip_please_sessions WHERE session_id = ?"
    ))
    .bind(session_id)
    .fetch_optional(pool)
    .await?;
    row.as_ref().map(row_to_session).transpose()
}

pub struct NewSession<'a> {
    pub user_id: &'a str,
    pub subject: &'a str,
    pub idp_sid: Option<&'a str>,
    pub is_admin: bool,
}

pub async fn create(
    pool: &MySqlPool,
    config: &Config,
    new: NewSession<'_>,
    now: i64,
) -> Result<Issued, AppError> {
    let session_id = ids::generate(ids::PREFIX_SESSION);
    let expires_at = now + config.session_max_ms();
    let idle_expires_at = (now + config.session_idle_ms()).min(expires_at);
    let refresh_token = new_refresh_token();

    let mut tx = pool.begin().await.map_err(AppError::db)?;
    sqlx::query(
        "INSERT INTO ip_please_sessions
            (session_id, user_id, subject, idp_sid, is_admin, created_at_ms,
             last_refresh_at_ms, idle_expires_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(new.user_id)
    .bind(new.subject)
    .bind(new.idp_sid)
    .bind(new.is_admin)
    .bind(now)
    .bind(now)
    .bind(idle_expires_at)
    .bind(expires_at)
    .execute(&mut *tx)
    .await
    .map_err(AppError::db)?;
    insert_refresh_token(&mut tx, &session_id, &refresh_token, idle_expires_at, now).await?;
    profile::ensure(&mut *tx, new.user_id, now)
        .await
        .map_err(AppError::db)?;
    tx.commit().await.map_err(AppError::db)?;

    Ok(Issued {
        session_id,
        user_id: new.user_id.to_string(),
        is_admin: new.is_admin,
        refresh_token,
        refresh_expires_at_ms: idle_expires_at,
        session_expires_at_ms: expires_at,
    })
}

async fn insert_refresh_token(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    session_id: &str,
    token: &str,
    expires_at: i64,
    now: i64,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO ip_please_refresh_tokens (token_hash, session_id, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?)",
    )
    .bind(refresh_token_hash(token))
    .bind(session_id)
    .bind(now)
    .bind(expires_at)
    .execute(&mut **tx)
    .await
    .map_err(AppError::db)?;
    Ok(())
}

/// 用 RT 换新 RT（事务内加锁）。失败一律是 Auth 信封：
/// 未知 / 过期 / 已吊销 / 重放 → `token_revoked`；宽限期内的旧 RT → `invalid_token`。
pub async fn refresh(
    pool: &MySqlPool,
    config: &Config,
    refresh_token: &str,
    now: i64,
) -> Result<Issued, AppError> {
    let revoked = || AppError::Auth(AuthErrorCode::TokenRevoked);
    let hash = refresh_token_hash(refresh_token);

    let mut tx = pool.begin().await.map_err(AppError::db)?;
    let Some(rt) = sqlx::query(
        "SELECT session_id, expires_at_ms, used_at_ms FROM ip_please_refresh_tokens
         WHERE token_hash = ? FOR UPDATE",
    )
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::db)?
    else {
        return Err(revoked());
    };
    let session_id: String = rt.try_get("session_id").map_err(AppError::db)?;
    let rt_expires_at: i64 = rt.try_get("expires_at_ms").map_err(AppError::db)?;
    let rt_used_at: Option<i64> = rt.try_get("used_at_ms").map_err(AppError::db)?;

    let Some(session) = sqlx::query(&format!(
        "SELECT {SESSION_COLUMNS} FROM ip_please_sessions WHERE session_id = ? FOR UPDATE"
    ))
    .bind(&session_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::db)?
    .as_ref()
    .map(row_to_session)
    .transpose()
    .map_err(AppError::db)?
    else {
        return Err(revoked());
    };

    match classify_refresh(rt_expires_at, rt_used_at, &session, now) {
        RefreshDecision::Revoked | RefreshDecision::Expired => Err(revoked()),
        RefreshDecision::StaleInGrace => Err(AppError::Auth(AuthErrorCode::InvalidToken)),
        RefreshDecision::Reuse => {
            sqlx::query(
                "UPDATE ip_please_sessions SET revoked_at_ms = ?, revoke_reason = 'reuse'
                 WHERE session_id = ? AND revoked_at_ms IS NULL",
            )
            .bind(now)
            .bind(&session_id)
            .execute(&mut *tx)
            .await
            .map_err(AppError::db)?;
            tx.commit().await.map_err(AppError::db)?;
            tracing::warn!(session_id = %session_id, "refresh token reuse detected; session revoked");
            Err(revoked())
        }
        RefreshDecision::Rotate => {
            sqlx::query("UPDATE ip_please_refresh_tokens SET used_at_ms = ? WHERE token_hash = ?")
                .bind(now)
                .bind(&hash)
                .execute(&mut *tx)
                .await
                .map_err(AppError::db)?;
            let idle_expires_at = (now + config.session_idle_ms()).min(session.expires_at_ms);
            let next = new_refresh_token();
            insert_refresh_token(&mut tx, &session_id, &next, idle_expires_at, now).await?;
            sqlx::query(
                "UPDATE ip_please_sessions SET last_refresh_at_ms = ?, idle_expires_at_ms = ?
                 WHERE session_id = ?",
            )
            .bind(now)
            .bind(idle_expires_at)
            .bind(&session_id)
            .execute(&mut *tx)
            .await
            .map_err(AppError::db)?;
            tx.commit().await.map_err(AppError::db)?;
            Ok(Issued {
                session_id,
                user_id: session.user_id,
                is_admin: session.is_admin,
                refresh_token: next,
                refresh_expires_at_ms: idle_expires_at,
                session_expires_at_ms: session.expires_at_ms,
            })
        }
    }
}

/// 用 RT 找到会话并吊销（登出）。未知 RT 返回 `None`。
pub async fn session_for_refresh_token(
    pool: &MySqlPool,
    refresh_token: &str,
) -> Result<Option<(String, String)>, AppError> {
    let row = sqlx::query(
        "SELECT s.session_id, s.user_id FROM ip_please_refresh_tokens t
         JOIN ip_please_sessions s ON s.session_id = t.session_id
         WHERE t.token_hash = ?",
    )
    .bind(refresh_token_hash(refresh_token))
    .fetch_optional(pool)
    .await
    .map_err(AppError::db)?;
    row.map(|row| -> Result<(String, String), AppError> {
        Ok((
            row.try_get("session_id").map_err(AppError::db)?,
            row.try_get("user_id").map_err(AppError::db)?,
        ))
    })
    .transpose()
}

pub async fn revoke(
    pool: &MySqlPool,
    session_id: &str,
    reason: &str,
    now: i64,
) -> Result<u64, AppError> {
    let result = sqlx::query(
        "UPDATE ip_please_sessions SET revoked_at_ms = ?, revoke_reason = ?
         WHERE session_id = ? AND revoked_at_ms IS NULL",
    )
    .bind(now)
    .bind(reason)
    .bind(session_id)
    .execute(pool)
    .await
    .map_err(AppError::db)?;
    Ok(result.rows_affected())
}

pub async fn revoke_user(
    pool: &MySqlPool,
    user_id: &str,
    reason: &str,
    now: i64,
) -> Result<u64, AppError> {
    let result = sqlx::query(
        "UPDATE ip_please_sessions SET revoked_at_ms = ?, revoke_reason = ?
         WHERE user_id = ? AND revoked_at_ms IS NULL",
    )
    .bind(now)
    .bind(reason)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(AppError::db)?;
    Ok(result.rows_affected())
}

/// 反向通道注销：有 `sid` 只吊销该 IdP 会话对应的本地会话（若同时给了 `sub` 也要匹配），
/// 只有 `sub` 时吊销该 IdP 用户的全部本地会话。
pub async fn revoke_for_idp(
    pool: &MySqlPool,
    sid: Option<&str>,
    subject: Option<&str>,
    now: i64,
) -> Result<u64, sqlx::Error> {
    let result = match (sid, subject) {
        (Some(sid), Some(subject)) => {
            sqlx::query(
                "UPDATE ip_please_sessions SET revoked_at_ms = ?, revoke_reason = 'backchannel'
                 WHERE idp_sid = ? AND subject = ? AND revoked_at_ms IS NULL",
            )
            .bind(now)
            .bind(sid)
            .bind(subject)
            .execute(pool)
            .await?
        }
        (Some(sid), None) => {
            sqlx::query(
                "UPDATE ip_please_sessions SET revoked_at_ms = ?, revoke_reason = 'backchannel'
                 WHERE idp_sid = ? AND revoked_at_ms IS NULL",
            )
            .bind(now)
            .bind(sid)
            .execute(pool)
            .await?
        }
        (None, Some(subject)) => {
            sqlx::query(
                "UPDATE ip_please_sessions SET revoked_at_ms = ?, revoke_reason = 'backchannel'
                 WHERE subject = ? AND revoked_at_ms IS NULL",
            )
            .bind(now)
            .bind(subject)
            .execute(pool)
            .await?
        }
        (None, None) => return Ok(0),
    };
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(now: i64) -> SessionRecord {
        SessionRecord {
            session_id: "sess_aaaaaaaaaaaaaaaaaaaaaa".into(),
            user_id: "user_aaaaaaaaaaaaaaaaaaaaaa".into(),
            is_admin: false,
            created_at_ms: now - 1000,
            idle_expires_at_ms: now + 1_000_000,
            expires_at_ms: now + 2_000_000,
            revoked_at_ms: None,
        }
    }

    #[test]
    fn rotates_fresh_token() {
        let now = 1_000_000_000;
        assert_eq!(
            classify_refresh(now + 10, None, &session(now), now),
            RefreshDecision::Rotate
        );
    }

    #[test]
    fn stale_token_within_grace_is_not_reuse() {
        let now = 1_000_000_000;
        assert_eq!(
            classify_refresh(now + 10, Some(now - 5_000), &session(now), now),
            RefreshDecision::StaleInGrace
        );
        assert_eq!(
            classify_refresh(now + 10, Some(now - REUSE_GRACE_MS - 1), &session(now), now),
            RefreshDecision::Reuse
        );
    }

    #[test]
    fn expiry_and_revocation_win() {
        let now = 1_000_000_000;
        assert_eq!(
            classify_refresh(now - 1, None, &session(now), now),
            RefreshDecision::Expired
        );
        let mut idle = session(now);
        idle.idle_expires_at_ms = now;
        assert_eq!(
            classify_refresh(now + 10, None, &idle, now),
            RefreshDecision::Expired
        );
        let mut absolute = session(now);
        absolute.expires_at_ms = now - 1;
        assert_eq!(
            classify_refresh(now + 10, None, &absolute, now),
            RefreshDecision::Expired
        );
        let mut revoked = session(now);
        revoked.revoked_at_ms = Some(now - 1);
        assert_eq!(
            classify_refresh(now + 10, Some(now - 100_000), &revoked, now),
            RefreshDecision::Revoked
        );
    }

    #[test]
    fn access_check() {
        let now = 1_000_000_000;
        let mut s = session(now);
        assert!(s.active_for_access(now));
        s.revoked_at_ms = Some(now);
        assert!(!s.active_for_access(now));
    }
}
