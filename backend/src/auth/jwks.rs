//! IdP 的 discovery + JWKS 缓存：用于校验 ID Token 与反向通道注销的 Logout Token（RS256）。
//!
//! 本服务自己的 Access Token 由 `tokens.rs` 用 HS256 签发和校验，不经过这里。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use jsonwebtoken::DecodingKey;
use serde::Deserialize;
use tokio::sync::{Mutex as AsyncMutex, RwLock};

use crate::error::{AppError, AuthErrorCode};

const JWKS_TTL: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// discovery 文档里本服务用到的端点。
#[derive(Debug, Clone, Deserialize)]
pub struct Endpoints {
    pub issuer: String,
    pub jwks_uri: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
}

#[derive(Debug, Deserialize)]
struct JwksDocument {
    keys: Vec<Jwk>,
}

#[derive(Debug, Deserialize)]
struct Jwk {
    kid: Option<String>,
    kty: String,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
    #[serde(default, rename = "use")]
    use_: Option<String>,
}

/// discovery + JWKS 缓存。密钥按需刷新，鉴权流程不阻塞在冷启动上。
pub struct JwksCache {
    client: reqwest::Client,
    issuer: String,
    jwks_override: Option<String>,
    endpoints: Mutex<Option<Endpoints>>,
    keys: RwLock<HashMap<String, DecodingKey>>,
    fetched_at: Mutex<Option<Instant>>,
    refresh_guard: AsyncMutex<()>,
    /// 测试用：固定密钥，不访问网络。
    fixed: bool,
}

impl JwksCache {
    pub fn new(issuer: &str, jwks_override: Option<String>) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .user_agent("ip-please-sync/0.2")
            .build()?;
        Ok(Self {
            client,
            issuer: issuer.trim_end_matches('/').to_string(),
            jwks_override,
            endpoints: Mutex::new(None),
            keys: RwLock::new(HashMap::new()),
            fetched_at: Mutex::new(None),
            refresh_guard: AsyncMutex::new(()),
            fixed: false,
        })
    }

    /// 测试用：给定端点与签名公钥，不做任何网络请求（换码仍会访问 `token_endpoint`）。
    pub fn with_fixed_keys(
        issuer: &str,
        endpoints: Endpoints,
        keys: HashMap<String, DecodingKey>,
    ) -> anyhow::Result<Self> {
        let cache = Self::new(issuer, None)?;
        *cache.endpoints.lock().expect("jwks mutex") = Some(endpoints);
        Ok(Self {
            keys: RwLock::new(keys),
            fixed: true,
            ..cache
        })
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// 启动时预取一次；失败只记录警告，后续请求会重试。
    pub async fn warm_up(&self) -> anyhow::Result<()> {
        self.refresh().await
    }

    /// IdP 端点（discovery 结果缓存到进程退出）。
    pub async fn endpoints(&self) -> anyhow::Result<Endpoints> {
        if let Some(endpoints) = self.endpoints.lock().expect("jwks mutex").clone() {
            return Ok(endpoints);
        }
        let url = format!("{}/.well-known/openid-configuration", self.issuer);
        let document: Endpoints = self
            .client
            .get(&url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if document.issuer.trim_end_matches('/') != self.issuer {
            anyhow::bail!(
                "discovery issuer mismatch: expected {}, got {}",
                self.issuer,
                document.issuer
            );
        }
        *self.endpoints.lock().expect("jwks mutex") = Some(document.clone());
        Ok(document)
    }

    async fn jwks_url(&self) -> anyhow::Result<String> {
        match &self.jwks_override {
            Some(url) => Ok(url.clone()),
            None => Ok(self.endpoints().await?.jwks_uri),
        }
    }

    async fn refresh(&self) -> anyhow::Result<()> {
        if self.fixed {
            return Ok(());
        }
        let _guard = self.refresh_guard.lock().await;
        let fetched_at = *self.fetched_at.lock().expect("jwks mutex");
        if let Some(fetched) = fetched_at {
            if fetched.elapsed() < JWKS_TTL && !self.keys.read().await.is_empty() {
                return Ok(());
            }
        }
        let jwks_url = self.jwks_url().await?;
        let document: JwksDocument = self
            .client
            .get(&jwks_url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let mut keys = HashMap::new();
        for jwk in document.keys {
            if jwk.kty != "RSA" || jwk.use_.as_deref() == Some("enc") {
                continue;
            }
            let (Some(kid), Some(n), Some(e)) = (jwk.kid, jwk.n, jwk.e) else {
                continue;
            };
            if let Ok(key) = DecodingKey::from_rsa_components(&n, &e) {
                keys.insert(kid, key);
            }
        }
        if keys.is_empty() {
            anyhow::bail!("JWKS contained no usable RSA signing keys");
        }
        *self.keys.write().await = keys;
        *self.fetched_at.lock().expect("jwks mutex") = Some(Instant::now());
        tracing::info!("JWKS refreshed");
        Ok(())
    }

    /// 取签名公钥：缓存未命中时刷新一次；IdP 不可达 → 503 `session_validation_failed`。
    pub async fn key(&self, kid: &str) -> Result<DecodingKey, AppError> {
        if let Some(key) = self.keys.read().await.get(kid) {
            return Ok(key.clone());
        }
        self.refresh().await.map_err(|err| {
            tracing::error!(error = ?err, "JWKS refresh failed");
            AppError::Auth(AuthErrorCode::SessionValidationFailed)
        })?;
        self.keys
            .read()
            .await
            .get(kid)
            .cloned()
            .ok_or(AppError::Auth(AuthErrorCode::InvalidToken))
    }
}
