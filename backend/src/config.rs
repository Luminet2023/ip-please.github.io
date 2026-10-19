use std::env;

use anyhow::{bail, Context};

/// 运行时配置。所有秘密（数据库连接串）只从环境变量读取，不落盘、不进仓库。
#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub database_url: String,
    pub oidc_issuer: String,
    pub oidc_client_id: String,
    pub oidc_jwks_url: Option<String>,
    pub oidc_required_scope: String,
    pub allowed_origins: Vec<String>,
    pub max_payload_bytes: usize,
    pub rate_limit_seconds: u64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = env::var("SYNC_DATABASE_URL")
            .context("SYNC_DATABASE_URL is required (mysql://user:password@host:3306/database)")?;
        if !database_url.starts_with("mysql://") {
            bail!("SYNC_DATABASE_URL must start with mysql://");
        }

        let oidc_issuer = env::var("OIDC_ISSUER")
            .unwrap_or_else(|_| "https://auth.luminet.cn/realms/prod".to_string());
        let issuer = oidc_issuer.trim_end_matches('/').to_string();

        let allowed_origins = env::var("ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "https://www.fuckanthropic.dev,https://fuckanthropic.dev".to_string())
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>();

        Ok(Self {
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string()),
            database_url,
            oidc_issuer: issuer,
            oidc_client_id: env::var("OIDC_CLIENT_ID")
                .unwrap_or_else(|_| "app_vXmK3nB7cmKcW6q7".to_string()),
            oidc_jwks_url: env::var("OIDC_JWKS_URL").ok().filter(|v| !v.trim().is_empty()),
            oidc_required_scope: env::var("OIDC_REQUIRED_SCOPE")
                .unwrap_or_else(|_| "openid".to_string()),
            allowed_origins,
            max_payload_bytes: env::var("SYNC_MAX_PAYLOAD_BYTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(256 * 1024),
            rate_limit_seconds: env::var("SYNC_RATE_LIMIT_SECONDS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3),
        })
    }
}
