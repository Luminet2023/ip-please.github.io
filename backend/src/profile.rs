//! 玩家展示资料：名字与头像直接取自 IdP 的 ID Token，每次登录覆盖一次。
//!
//! 名字按 `OIDC_NAME_CLAIMS` 的顺序取第一个可用的值（像邮箱的跳过），头像取 `OIDC_AVATAR_CLAIM`，
//! 只接受 https 地址。本服务不保存 IdP 的 Token，IdP 里改了名字或头像要下次登录才生效。

use std::collections::HashMap;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};
use sqlx::{Executor, MySql, MySqlPool, Row};

use crate::auth::AuthUser;
use crate::config::Config;
use crate::error::{private_json, AppError};
use crate::util::{iso_from_ms, sha256_hex, unix_secs};
use crate::AppState;

/// IdP 没给可用名字、或会话早于本功能建立（还没存过资料）时的显示名。
pub const FALLBACK_NAME: &str = "审查员";
const DISPLAY_NAME_MAX: usize = 32;
const AVATAR_URL_MAX: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub display_name: String,
    pub avatar_url: Option<String>,
}

impl Profile {
    fn fallback() -> Self {
        Self {
            display_name: FALLBACK_NAME.to_string(),
            avatar_url: None,
        }
    }

    /// 从 ID Token 的 claims 取展示资料。
    pub fn from_claims(claims: &HashMap<String, Value>, config: &Config) -> Self {
        let display_name = config
            .oidc_name_claims
            .iter()
            .filter_map(|claim| claims.get(claim).and_then(Value::as_str))
            .find_map(clean_name)
            .unwrap_or_else(|| FALLBACK_NAME.to_string());
        let avatar_url = claims
            .get(&config.oidc_avatar_claim)
            .and_then(Value::as_str)
            .and_then(clean_avatar_url);
        Self {
            display_name,
            avatar_url,
        }
    }
}

/// 4 位标签：前端按它给默认头像取色，同名玩家也能区分；不可反推 user_id。
pub fn display_tag(user_id: &str) -> String {
    sha256_hex(user_id.as_bytes())[..4].to_ascii_uppercase()
}

/// 方向控制与零宽字符会打乱名字的显示顺序或伪装成别人，一律去掉。
fn is_invisible(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

/// 规范化 IdP 给的名字：去掉不可见字符、合并空白、最长 32 字；空的或像邮箱的不用。
fn clean_name(raw: &str) -> Option<String> {
    let visible: String = raw
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !is_invisible(*c))
        .collect();
    let name: String = visible
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(DISPLAY_NAME_MAX)
        .collect();
    let name = name.trim_end();
    (!name.is_empty() && !name.contains('@')).then(|| name.to_string())
}

/// 头像只接受 https、不带账号密码的地址。
fn clean_avatar_url(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    let acceptable = url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.as_str().len() <= AVATAR_URL_MAX;
    acceptable.then(|| url.to_string())
}

/// 登录时写入（覆盖）展示资料。
pub async fn save<'e, E>(
    executor: E,
    user_id: &str,
    profile: &Profile,
    now: i64,
) -> Result<(), sqlx::Error>
where
    E: Executor<'e, Database = MySql>,
{
    sqlx::query(
        "INSERT INTO ip_please_player_profiles (user_id, display_name, avatar_url, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            display_name = VALUES(display_name),
            avatar_url = VALUES(avatar_url),
            updated_at_ms = VALUES(updated_at_ms)",
    )
    .bind(user_id)
    .bind(&profile.display_name)
    .bind(&profile.avatar_url)
    .bind(now)
    .execute(executor)
    .await?;
    Ok(())
}

pub async fn load(pool: &MySqlPool, user_id: &str) -> Result<Profile, AppError> {
    let row = sqlx::query(
        "SELECT display_name, avatar_url FROM ip_please_player_profiles WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::db)?;
    let Some(row) = row else {
        return Ok(Profile::fallback());
    };
    Ok(Profile {
        display_name: row.try_get("display_name").map_err(AppError::db)?,
        avatar_url: row.try_get("avatar_url").map_err(AppError::db)?,
    })
}

pub fn user_json(user_id: &str, profile: &Profile, is_admin: bool) -> serde_json::Value {
    json!({
        "user_id": user_id,
        "display_name": profile.display_name,
        "avatar_url": profile.avatar_url,
        "tag": display_tag(user_id),
        "is_admin": is_admin,
    })
}

pub async fn get_me(State(state): State<AppState>, user: AuthUser) -> Result<Response, AppError> {
    let profile = load(&state.pool, &user.user_id).await?;
    let mut body = user_json(&user.user_id, &profile, user.is_admin);
    body["session"] = json!({
        "session_id": user.session_id,
        "created_at": iso_from_ms(user.session_created_at_ms),
        "expires_at": unix_secs(user.session_expires_at_ms),
    });
    Ok(private_json(StatusCode::OK, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(value: Value) -> HashMap<String, Value> {
        serde_json::from_value(value).unwrap()
    }

    fn config() -> Config {
        Config::for_tests("mysql://unused", "https://idp.test/realms/test")
    }

    #[test]
    fn name_claims_in_order() {
        let cfg = config();
        let profile = Profile::from_claims(
            &claims(json!({ "name": "小鱼 干", "preferred_username": "fish" })),
            &cfg,
        );
        assert_eq!(profile.display_name, "小鱼 干");
        // name 缺失或只有空白时退到下一个 claim；像邮箱的值跳过
        let profile = Profile::from_claims(
            &claims(json!({ "name": "  ", "nickname": "a@b.c", "preferred_username": "fish" })),
            &cfg,
        );
        assert_eq!(profile.display_name, "fish");
        let profile = Profile::from_claims(&claims(json!({ "email": "a@b.c" })), &cfg);
        assert_eq!(profile, Profile::fallback());
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(
            clean_name(" Claude\u{202E}\u{200B}  Opus\n").as_deref(),
            Some("Claude Opus")
        );
        assert_eq!(clean_name("\u{0007}").as_deref(), None);
        assert_eq!(clean_name(&"长".repeat(40)).unwrap().chars().count(), 32);
        assert_eq!(
            clean_name(&format!("{}  尾", "a".repeat(31))).as_deref(),
            Some("a".repeat(31).as_str())
        );
    }

    #[test]
    fn avatar_urls() {
        assert_eq!(
            clean_avatar_url("https://cdn.test/a.png?s=64").as_deref(),
            Some("https://cdn.test/a.png?s=64")
        );
        assert_eq!(
            clean_avatar_url("https://cdn.test/a b\".png").as_deref(),
            Some("https://cdn.test/a%20b%22.png")
        );
        assert!(clean_avatar_url("http://cdn.test/a.png").is_none());
        assert!(clean_avatar_url("javascript:alert(1)").is_none());
        assert!(clean_avatar_url("data:image/png;base64,AAAA").is_none());
        assert!(clean_avatar_url("https://user:pw@cdn.test/a.png").is_none());
        assert!(clean_avatar_url(&format!("https://cdn.test/{}", "a".repeat(600))).is_none());

        let cfg = config();
        let profile = Profile::from_claims(
            &claims(json!({ "name": "Fish", "picture": "http://cdn.test/a.png" })),
            &cfg,
        );
        assert_eq!(profile.avatar_url, None);
    }

    #[test]
    fn tags_are_stable() {
        assert_eq!(display_tag("user_abc"), display_tag("user_abc"));
        assert_eq!(display_tag("user_abc").len(), 4);
    }
}
