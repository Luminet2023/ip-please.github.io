use std::env;

use anyhow::{bail, Context};

/// 运行时配置。所有秘密（数据库连接串、client secret、签名密钥）只从环境变量读取，
/// 不落盘、不进仓库。
#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub database_url: String,
    pub oidc_issuer: String,
    pub oidc_client_id: String,
    /// 机密客户端的 secret；为空时按公共客户端换码（切换期兼容）。
    pub oidc_client_secret: Option<String>,
    pub oidc_jwks_url: Option<String>,
    pub oidc_redirect_uris: Vec<String>,
    pub oidc_scope: String,
    /// ID Token 里携带角色列表的 claim（Keycloak 专用 mapper）。
    pub oidc_roles_claim: String,
    pub oidc_admin_role: String,
    pub session_jwt_secret: Vec<u8>,
    pub session_jwt_secret_previous: Option<Vec<u8>>,
    pub token_issuer: String,
    pub access_token_ttl_seconds: i64,
    pub session_idle_days: i64,
    pub session_max_days: i64,
    /// 反向代理写入真实客户端 IP 的请求头（nginx 的 `X-Real-IP`）。
    pub client_ip_header: String,
    pub allowed_origins: Vec<String>,
    pub max_payload_bytes: usize,
    pub rate_limit_seconds: u64,
}

const MIN_SECRET_BYTES: usize = 32;

fn var_or(name: &str, default: &str) -> String {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn optional_var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parsed_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    optional_var(name)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn secret(name: &str) -> anyhow::Result<Option<Vec<u8>>> {
    let Some(value) = optional_var(name) else {
        return Ok(None);
    };
    if value.len() < MIN_SECRET_BYTES {
        bail!("{name} must be at least {MIN_SECRET_BYTES} bytes (generate with: openssl rand -hex 32)");
    }
    Ok(Some(value.into_bytes()))
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = env::var("SYNC_DATABASE_URL")
            .context("SYNC_DATABASE_URL is required (mysql://user:password@host:3306/database)")?;
        if !database_url.starts_with("mysql://") {
            bail!("SYNC_DATABASE_URL must start with mysql://");
        }

        let session_jwt_secret = secret("SESSION_JWT_SECRET")?
            .context("SESSION_JWT_SECRET is required (generate with: openssl rand -hex 32)")?;

        let redirect_uris = list(&var_or(
            "OIDC_REDIRECT_URIS",
            "https://www.fuckanthropic.dev/",
        ));
        if redirect_uris.is_empty() {
            bail!("OIDC_REDIRECT_URIS must list at least one redirect URI");
        }

        Ok(Self {
            bind_addr: var_or("BIND_ADDR", "0.0.0.0:8080"),
            database_url,
            oidc_issuer: var_or("OIDC_ISSUER", "https://auth.luminet.cn/realms/prod")
                .trim_end_matches('/')
                .to_string(),
            oidc_client_id: var_or("OIDC_CLIENT_ID", "app_vXmK3nB7cmKcW6q7"),
            oidc_client_secret: optional_var("OIDC_CLIENT_SECRET"),
            oidc_jwks_url: optional_var("OIDC_JWKS_URL"),
            oidc_redirect_uris: redirect_uris,
            oidc_scope: var_or("OIDC_SCOPE", "openid profile"),
            oidc_roles_claim: var_or("OIDC_ROLES_CLAIM", "ip_please_roles"),
            oidc_admin_role: var_or("OIDC_ADMIN_ROLE", "ip-please-admin"),
            session_jwt_secret,
            session_jwt_secret_previous: secret("SESSION_JWT_SECRET_PREVIOUS")?,
            token_issuer: var_or("TOKEN_ISSUER", "https://api.luminet.cn/anthropic"),
            access_token_ttl_seconds: parsed_or("ACCESS_TOKEN_TTL_SECONDS", 600i64).clamp(60, 3600),
            session_idle_days: parsed_or("SESSION_IDLE_DAYS", 14i64).clamp(1, 90),
            session_max_days: parsed_or("SESSION_MAX_DAYS", 30i64).clamp(1, 365),
            client_ip_header: var_or("CLIENT_IP_HEADER", "x-real-ip").to_ascii_lowercase(),
            allowed_origins: list(&var_or(
                "ALLOWED_ORIGINS",
                "https://www.fuckanthropic.dev,https://fuckanthropic.dev",
            )),
            max_payload_bytes: parsed_or("SYNC_MAX_PAYLOAD_BYTES", 256 * 1024usize),
            rate_limit_seconds: parsed_or("SYNC_RATE_LIMIT_SECONDS", 3u64),
        })
    }

    /// 测试用：不读环境变量的固定配置。
    pub fn for_tests(database_url: &str, issuer: &str) -> Self {
        Self {
            bind_addr: "127.0.0.1:0".to_string(),
            database_url: database_url.to_string(),
            oidc_issuer: issuer.trim_end_matches('/').to_string(),
            oidc_client_id: "app_test_client_0001".to_string(),
            oidc_client_secret: Some("test-client-secret".to_string()),
            oidc_jwks_url: None,
            oidc_redirect_uris: vec!["https://game.test/".to_string()],
            oidc_scope: "openid profile".to_string(),
            oidc_roles_claim: "ip_please_roles".to_string(),
            oidc_admin_role: "ip-please-admin".to_string(),
            session_jwt_secret: b"test-session-secret-0123456789abcdef".to_vec(),
            session_jwt_secret_previous: None,
            token_issuer: "https://api.test/anthropic".to_string(),
            access_token_ttl_seconds: 600,
            session_idle_days: 14,
            session_max_days: 30,
            client_ip_header: "x-real-ip".to_string(),
            allowed_origins: vec!["https://game.test".to_string()],
            max_payload_bytes: 256 * 1024,
            rate_limit_seconds: 0,
        }
    }

    /// 会话闲置上限（毫秒）。
    pub fn session_idle_ms(&self) -> i64 {
        self.session_idle_days * 86_400_000
    }

    /// 会话绝对上限（毫秒）。
    pub fn session_max_ms(&self) -> i64 {
        self.session_max_days * 86_400_000
    }
}
