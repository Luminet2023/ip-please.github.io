//! 玩家资料：排行榜与面板只显示昵称，永不显示 IdP 用户名或邮箱。

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use rand::Rng;
use serde::Deserialize;
use serde_json::json;
use sqlx::{Executor, MySql, MySqlPool, Row};

use crate::auth::AuthUser;
use crate::error::{private_json, AppError, DetailCode};
use crate::extract::JsonBody;
use crate::ratelimit;
use crate::util::{iso_from_ms, now_ms, sha256_hex, unix_secs};
use crate::AppState;

const DEFAULT_PREFIX: &str = "审查员-";
const TAG_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const NICKNAME_MIN: usize = 2;
const NICKNAME_MAX: usize = 16;
const NICKNAME_EXTRA_CHARS: &str = " _-·.";
const NICKNAME_BLOCKLIST: [&str; 6] = ["http", "www.", "admin", "管理", "官方", "客服"];

#[derive(Debug, Clone)]
pub struct Profile {
    pub nickname: String,
    pub nickname_set: bool,
}

pub fn default_nickname() -> String {
    let mut rng = rand::thread_rng();
    let suffix: String = (0..4)
        .map(|_| TAG_ALPHABET[rng.gen_range(0..TAG_ALPHABET.len())] as char)
        .collect();
    format!("{DEFAULT_PREFIX}{suffix}")
}

/// 排行榜上昵称后面的 4 位标签，用来区分重名玩家，不可反推 user_id。
pub fn display_tag(user_id: &str) -> String {
    sha256_hex(user_id.as_bytes())[..4].to_ascii_uppercase()
}

/// 校验并规范化昵称（去首尾空白）。
pub fn validate_nickname(input: &str) -> Result<String, AppError> {
    let invalid = || AppError::Detail(DetailCode::NicknameInvalid);
    let nickname = input.trim();
    let count = nickname.chars().count();
    if !(NICKNAME_MIN..=NICKNAME_MAX).contains(&count) {
        return Err(invalid());
    }
    if nickname.contains("  ")
        || !nickname
            .chars()
            .all(|c| c.is_alphanumeric() || NICKNAME_EXTRA_CHARS.contains(c))
    {
        return Err(invalid());
    }
    let lowered = nickname.to_lowercase();
    if NICKNAME_BLOCKLIST.iter().any(|word| lowered.contains(word)) {
        return Err(invalid());
    }
    Ok(nickname.to_string())
}

/// 首次建会话时补一条默认资料；已有则不动。
pub async fn ensure<'e, E>(executor: E, user_id: &str, now: i64) -> Result<(), sqlx::Error>
where
    E: Executor<'e, Database = MySql>,
{
    sqlx::query(
        "INSERT IGNORE INTO ip_please_profiles (user_id, nickname, nickname_set, updated_at_ms)
         VALUES (?, ?, FALSE, ?)",
    )
    .bind(user_id)
    .bind(default_nickname())
    .bind(now)
    .execute(executor)
    .await?;
    Ok(())
}

pub async fn load(pool: &MySqlPool, user_id: &str) -> Result<Profile, AppError> {
    ensure(pool, user_id, now_ms())
        .await
        .map_err(AppError::db)?;
    let row =
        sqlx::query("SELECT nickname, nickname_set FROM ip_please_profiles WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .map_err(AppError::db)?;
    Ok(Profile {
        nickname: row.try_get("nickname").map_err(AppError::db)?,
        nickname_set: row.try_get("nickname_set").map_err(AppError::db)?,
    })
}

pub fn user_json(user_id: &str, profile: &Profile, is_admin: bool) -> serde_json::Value {
    json!({
        "user_id": user_id,
        "nickname": profile.nickname,
        "nickname_set": profile.nickname_set,
        "tag": display_tag(user_id),
        "is_admin": is_admin,
    })
}

fn me_json(user: &AuthUser, profile: &Profile) -> serde_json::Value {
    let mut body = user_json(&user.user_id, profile, user.is_admin);
    body["session"] = json!({
        "session_id": user.session_id,
        "created_at": iso_from_ms(user.session_created_at_ms),
        "expires_at": unix_secs(user.session_expires_at_ms),
    });
    body
}

pub async fn get_me(State(state): State<AppState>, user: AuthUser) -> Result<Response, AppError> {
    let profile = load(&state.pool, &user.user_id).await?;
    Ok(private_json(StatusCode::OK, me_json(&user, &profile)))
}

#[derive(Debug, Deserialize)]
pub struct ProfileUpdate {
    nickname: String,
}

pub async fn update_me(
    State(state): State<AppState>,
    user: AuthUser,
    JsonBody(update): JsonBody<ProfileUpdate>,
) -> Result<Response, AppError> {
    let nickname = validate_nickname(&update.nickname)?;
    state
        .limiter
        .check(ratelimit::PROFILE_UPDATE, &user.user_id)?;
    load(&state.pool, &user.user_id).await?;
    sqlx::query(
        "UPDATE ip_please_profiles SET nickname = ?, nickname_set = TRUE, updated_at_ms = ?
         WHERE user_id = ?",
    )
    .bind(&nickname)
    .bind(now_ms())
    .bind(&user.user_id)
    .execute(&state.pool)
    .await
    .map_err(AppError::db)?;
    let profile = Profile {
        nickname,
        nickname_set: true,
    };
    Ok(private_json(StatusCode::OK, me_json(&user, &profile)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_nicknames_are_valid() {
        for _ in 0..50 {
            let nickname = default_nickname();
            assert!(validate_nickname(&nickname).is_ok(), "{nickname}");
        }
    }

    #[test]
    fn nickname_rules() {
        assert_eq!(validate_nickname("  小鱼 干 ").unwrap(), "小鱼 干");
        assert!(validate_nickname("Inspector_42").is_ok());
        assert!(validate_nickname("a").is_err(), "too short");
        assert!(validate_nickname(&"长".repeat(17)).is_err(), "too long");
        assert!(validate_nickname("<script>").is_err());
        assert!(validate_nickname("a\u{0007}b").is_err(), "control char");
        assert!(validate_nickname("hello  world").is_err(), "double space");
        assert!(validate_nickname("www.evil.com").is_err());
        assert!(validate_nickname("Admin酱").is_err());
        assert!(validate_nickname("官方审查员").is_err());
    }

    #[test]
    fn tags_are_stable() {
        assert_eq!(display_tag("user_abc"), display_tag("user_abc"));
        assert_eq!(display_tag("user_abc").len(), 4);
    }
}
