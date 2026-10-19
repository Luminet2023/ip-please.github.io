//! OIDC Access Token 校验：拉取 IdP 的 discovery + JWKS 缓存，验证 RS256 JWT。
//!
//! 鉴权失败必须走 `AuthErrorResponse`（见 `error.rs`），不能混用 Detail 信封。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::FromRequestParts;
use axum::http::header;
use axum::http::request::Parts;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{Mutex as AsyncMutex, RwLock};

use crate::error::{AppError, AuthErrorCode};
use crate::AppState;

const JWKS_TTL: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    jwks_uri: String,
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

/// Access Token 的 claims。只取本项目需要的字段。
#[derive(Debug, Clone, Deserialize)]
pub struct Claims {
    pub sub: String,
    /// 由 `jsonwebtoken::Validation` 校验，不在业务代码里直接读取。
    #[allow(dead_code)]
    pub iss: String,
    /// 同上：过期时间由 `Validation` 检查，这里只保留字段以便调试输出。
    #[allow(dead_code)]
    pub exp: i64,
    #[serde(default)]
    pub azp: Option<String>,
    #[serde(default)]
    pub aud: Option<Value>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub preferred_username: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

impl Claims {
    fn audience_contains(&self, client_id: &str) -> bool {
        match &self.aud {
            Some(Value::String(single)) => single == client_id,
            Some(Value::Array(items)) => items.iter().any(|item| item.as_str() == Some(client_id)),
            _ => false,
        }
    }

    fn has_scope(&self, required: &str) -> bool {
        match &self.scope {
            Some(scope) => scope.split_whitespace().any(|item| item == required),
            None => false,
        }
    }
}

/// 通过请求头 `Authorization: Bearer <AT>` 解析出的调用者身份。
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub subject: String,
    pub claims: Claims,
}

impl AuthUser {
    pub fn display_name(&self) -> Option<&str> {
        self.claims
            .preferred_username
            .as_deref()
            .or(self.claims.email.as_deref())
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let raw = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok());

        // 规范：缺少 Authorization 头 → 401 DetailErrorResponse {"detail":"Unauthorized"}
        let Some(raw) = raw else {
            return Err(AppError::Detail(crate::error::DetailCode::Unauthorized));
        };
        let Some(token) = raw
            .strip_prefix("Bearer ")
            .or_else(|| raw.strip_prefix("bearer "))
            .map(str::trim)
        else {
            return Err(AppError::Detail(crate::error::DetailCode::Unauthorized));
        };

        let header = decode_header(token)
            .map_err(|_| AppError::Auth(AuthErrorCode::InvalidToken))?;
        if header.alg != Algorithm::RS256 {
            return Err(AppError::Auth(AuthErrorCode::InvalidToken));
        }
        let kid = header.kid.unwrap_or_default();
        let key = state.jwks.key(&kid).await?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = 30;
        validation.validate_aud = false;
        validation.set_issuer(&[state.config.oidc_issuer.as_str()]);

        let data = decode::<Claims>(token, &key, &validation).map_err(|err| {
            tracing::debug!(error = %err, "access token rejected");
            AppError::Auth(AuthErrorCode::InvalidToken)
        })?;
        let claims = data.claims;

        if claims.sub.trim().is_empty() {
            return Err(AppError::Auth(AuthErrorCode::InvalidToken));
        }

        // Keycloak 的 AT 把 client 放在 azp；aud 可能含其它 audience。
        if !claims.audience_contains(&state.config.oidc_client_id)
            && claims.azp.as_deref() != Some(state.config.oidc_client_id.as_str())
        {
            tracing::debug!(azp = ?claims.azp, "token was not issued for this client");
            return Err(AppError::Auth(AuthErrorCode::InvalidToken));
        }

        let required_scope = state.config.oidc_required_scope.trim();
        if !required_scope.is_empty() && !claims.has_scope(required_scope) {
            return Err(AppError::Auth(AuthErrorCode::InsufficientScope));
        }

        Ok(AuthUser {
            subject: claims.sub.clone(),
            claims,
        })
    }
}

/// discovery + JWKS 缓存。密钥按需刷新，鉴权流程不阻塞在冷启动上。
pub struct JwksCache {
    client: reqwest::Client,
    issuer: String,
    jwks_url: Mutex<Option<String>>,
    keys: RwLock<HashMap<String, DecodingKey>>,
    fetched_at: Mutex<Option<Instant>>,
    refresh_guard: AsyncMutex<()>,
}

impl JwksCache {
    pub async fn new(issuer: &str, jwks_override: Option<String>) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .user_agent("ip-please-sync/0.1")
            .build()?;
        Ok(Self {
            client,
            issuer: issuer.trim_end_matches('/').to_string(),
            jwks_url: Mutex::new(jwks_override),
            keys: RwLock::new(HashMap::new()),
            fetched_at: Mutex::new(None),
            refresh_guard: AsyncMutex::new(()),
        })
    }

    /// 启动时预取一次；失败只记录警告，后续请求会重试。
    pub async fn warm_up(&self) -> anyhow::Result<()> {
        self.refresh().await
    }

    async fn discover(&self) -> anyhow::Result<String> {
        if let Some(url) = self.jwks_url.lock().expect("jwks mutex").clone() {
            return Ok(url);
        }
        let url = format!("{}/.well-known/openid-configuration", self.issuer);
        let document: DiscoveryDocument = self
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
        *self.jwks_url.lock().expect("jwks mutex") = Some(document.jwks_uri.clone());
        Ok(document.jwks_uri)
    }

    async fn refresh(&self) -> anyhow::Result<()> {
        let _guard = self.refresh_guard.lock().await;
        let fetched_at = *self.fetched_at.lock().expect("jwks mutex");
        if let Some(fetched) = fetched_at {
            if fetched.elapsed() < JWKS_TTL && !self.keys.read().await.is_empty() {
                return Ok(());
            }
        }
        let jwks_url = self.discover().await?;
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
