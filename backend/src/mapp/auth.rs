//! SDK 0.3.0 platform request verification. Tokens are reusable capabilities, not sessions.
use crate::{
    error::{AppError, AuthErrorCode, DetailCode},
    util::sha256_hex,
    AppState,
};
use axum::{extract::FromRequestParts, http::request::Parts};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub const ISSUER: &str = "https://linux.do";
pub const AUDIENCE: &str = "https://api.luminet.cn";
pub const JWKS_URL: &str = "https://linux.do/mini-app-api/jwks";
fn invalid() -> AppError {
    AppError::Auth(AuthErrorCode::InvalidToken)
}
#[derive(Clone, Debug, Deserialize)]
pub struct Principal {
    pub iss: String,
    pub sub: String,
    pub app_id: String,
    pub channel: String,
    pub version: String,
    pub scopes: Vec<String>,
    pub aud: String,
    pub iat: i64,
    pub nbf: i64,
    pub exp: i64,
    pub jti: String,
    pub htm: String,
    pub htu: String,
    pub query_keys: Vec<String>,
    #[serde(default, deserialize_with = "trust_level")]
    pub trust_level: Option<u8>,
}
struct Keys {
    values: HashMap<String, DecodingKey>,
    attempted: Option<Instant>,
    loaded: Option<Instant>,
}
pub struct Verifier {
    url: String,
    client: reqwest::Client,
    keys: Mutex<Keys>,
}
impl Verifier {
    pub fn new(url: &str) -> Self {
        Self {
            url: url.into(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client"),
            keys: Mutex::new(Keys {
                values: HashMap::new(),
                attempted: None,
                loaded: None,
            }),
        }
    }
    async fn key(&self, kid: &str) -> Result<DecodingKey, AppError> {
        // Mutex spans refresh: singleflight, with negative-cache cooldown for unknown kids.
        let mut keys = self.keys.lock().await;
        if keys
            .loaded
            .is_some_and(|t| t.elapsed() < Duration::from_secs(3600))
        {
            if let Some(key) = keys.values.get(kid) {
                return Ok(key.clone());
            }
        }
        if keys
            .attempted
            .is_some_and(|t| t.elapsed() < Duration::from_secs(5))
        {
            return Err(invalid());
        }
        keys.attempted = Some(Instant::now());
        let response = self
            .client
            .get(&self.url)
            .send()
            .await
            .map_err(|_| invalid())?;
        if !response.status().is_success() || response.content_length().is_some_and(|n| n > 65536) {
            return Err(invalid());
        }
        let bytes = response.bytes().await.map_err(|_| invalid())?;
        if bytes.len() > 65536 {
            return Err(invalid());
        }
        let doc: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let mut values = HashMap::new();
        for jwk in doc["keys"].as_array().ok_or_else(invalid)? {
            if jwk["kty"] != "EC"
                || jwk["crv"] != "P-256"
                || jwk.get("d").is_some()
                || jwk.get("alg").is_some_and(|v| v != "ES256")
                || jwk.get("use").is_some_and(|v| v != "sig")
            {
                continue;
            }
            let x = jwk["x"].as_str().ok_or_else(invalid)?;
            let y = jwk["y"].as_str().ok_or_else(invalid)?;
            let xb = canonical_b64(x)?;
            let yb = canonical_b64(y)?;
            if xb.len() != 32 || yb.len() != 32 {
                return Err(invalid());
            }
            // ASN.1 SubjectPublicKeyInfo for id-ecPublicKey / prime256v1 / uncompressed point.
            let mut der = hex::decode("3059301306072a8648ce3d020106082a8648ce3d03010703420004")
                .expect("constant DER");
            der.extend(xb);
            der.extend(yb);
            let expected = sha256_hex(&der);
            if jwk["kid"].as_str() != Some(&expected) {
                return Err(invalid());
            }
            if values
                .insert(
                    expected,
                    DecodingKey::from_ec_components(x, y).map_err(|_| invalid())?,
                )
                .is_some()
            {
                return Err(invalid());
            }
        }
        keys.values = values;
        keys.loaded = Some(Instant::now());
        keys.values.get(kid).cloned().ok_or_else(invalid)
    }
    pub async fn verify(
        &self,
        authorization: &str,
        app: &str,
        method: &str,
        url: &str,
        now: i64,
    ) -> Result<Principal, AppError> {
        if authorization.len() > 131079
            || app.is_empty()
            || !matches!(
                method,
                "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
            )
        {
            return Err(invalid());
        }
        let token = authorization.strip_prefix("Bearer ").ok_or_else(invalid)?;
        let parts: Vec<_> = token.split('.').collect();
        if parts.len() != 3 || canonical_b64(parts[2])?.len() != 64 {
            return Err(invalid());
        }
        let header: Value =
            serde_json::from_slice(&canonical_b64(parts[0])?).map_err(|_| invalid())?;
        canonical_b64(parts[1])?;
        if header["alg"] != "ES256"
            || header["typ"] != "mini-app-access+jwt"
            || ["jku", "jwk", "x5u", "crit"]
                .iter()
                .any(|k| header.get(k).is_some())
        {
            return Err(invalid());
        }
        let key = self
            .key(header["kid"].as_str().ok_or_else(invalid)?)
            .await?;
        let mut validation = Validation::new(Algorithm::ES256);
        validation.validate_exp = false;
        validation.validate_aud = false;
        validation.required_spec_claims.clear();
        let c = jsonwebtoken::decode::<Principal>(token, &key, &validation)
            .map_err(|_| invalid())?
            .claims;
        if c.iss != ISSUER
            || c.aud != AUDIENCE
            || c.app_id != app
            || !matches!(c.channel.as_str(), "sandbox" | "production")
            || c.htm != method
            || c.sub.is_empty()
            || c.sub.len() > 20
            || c.sub.starts_with('0')
            || !c.sub.bytes().all(|b| b.is_ascii_digit())
            || c.version.is_empty()
            || c.version.len() > 64
            || !c.version.as_bytes()[0].is_ascii_alphanumeric()
            || !c
                .version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+_-".contains(&b))
            || c.scopes != ["network.request"]
            || c.trust_level.is_some_and(|v| v > 4)
            || !(16..=128).contains(&c.jti.len())
            || !c
                .jti
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || [c.iat, c.nbf, c.exp, now]
                .iter()
                .any(|v| v.unsigned_abs() > 9_007_199_254_740_991)
            || c.exp <= c.iat
            || c.exp - c.iat > 900
            || c.iat > now + 5
            || c.nbf > now + 5
            || c.nbf > c.iat
            || c.iat - c.nbf > 5
            || c.exp <= now
        {
            return Err(invalid());
        }
        validate_url(&c.htu, &c.query_keys, url)?;
        Ok(c)
    }
}
fn canonical_b64(s: &str) -> Result<Vec<u8>, AppError> {
    if s.is_empty()
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD.decode(s).map_err(|_| invalid())?;
    if URL_SAFE_NO_PAD.encode(&bytes) != s {
        return Err(invalid());
    }
    Ok(bytes)
}
fn parsed_url(raw: &str) -> Result<(reqwest::Url, &str), AppError> {
    if !raw
        .get(..8)
        .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
        || raw.len() > 16384
        || raw
            .bytes()
            .any(|b| !(0x21..=0x7e).contains(&b) || b == b'\\' || b == b'#')
    {
        return Err(invalid());
    }
    for (i, b) in raw.bytes().enumerate() {
        if b == b'%'
            && (i + 2 >= raw.len()
                || !raw.as_bytes()[i + 1..i + 3]
                    .iter()
                    .all(u8::is_ascii_hexdigit))
        {
            return Err(invalid());
        }
    }
    let url = reqwest::Url::parse(raw).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.port() == Some(0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.origin().ascii_serialization() != AUDIENCE
    {
        return Err(invalid());
    }
    let after = raw.get(8..).ok_or_else(invalid)?;
    let raw_path = after
        .find(['/', '?'])
        .map(|i| after[i..].split('?').next().unwrap_or(""))
        .unwrap_or("");
    if (if raw_path.is_empty() { "/" } else { raw_path }) != url.path() {
        return Err(invalid());
    }
    Ok((url, raw.split_once('?').map(|(_, q)| q).unwrap_or("")))
}
fn validate_url(fixed: &str, keys: &[String], actual: &str) -> Result<(), AppError> {
    let (f, fq) = parsed_url(fixed)?;
    let (a, aq) = parsed_url(actual)?;
    if f.path() != a.path() || f.query_pairs().any(|(k, _)| k == "mini_app_token") {
        return Err(invalid());
    }
    let mut allowed = HashSet::new();
    for k in keys {
        if k.is_empty()
            || k.len() > 64
            || !k
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            || k == "mini_app_token"
            || !allowed.insert(k.as_str())
            || f.query_pairs().any(|(name, _)| name == k.as_str())
        {
            return Err(invalid());
        }
    }
    let suffix = if aq == fq {
        ""
    } else if fq.is_empty() {
        aq
    } else {
        aq.strip_prefix(&format!("{fq}&"))
            .filter(|s| !s.is_empty())
            .ok_or_else(invalid)?
    };
    let pairs: Vec<(String, String)> = serde_urlencoded::from_str(suffix).map_err(|_| invalid())?;
    if serde_urlencoded::to_string(&pairs).map_err(|_| invalid())? != suffix {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    for (key, _) in pairs {
        if !allowed.contains(key.as_str()) || !seen.insert(key) {
            return Err(invalid());
        }
    }
    Ok(())
}
impl FromRequestParts<AppState> for Principal {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let auth = parts
            .headers
            .get("authorization")
            .ok_or(AppError::Detail(DetailCode::Unauthorized))?
            .to_str()
            .map_err(|_| invalid())?;
        let path = parts.uri.path_and_query().ok_or_else(invalid)?.as_str();
        state
            .mapp
            .verify(
                auth,
                &state.config.mapp_app_id,
                parts.method.as_str(),
                &format!("{AUDIENCE}{path}"),
                crate::util::unix_secs(crate::util::now_ms()),
            )
            .await
    }
}

fn trust_level<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u8>, D::Error> {
    u8::deserialize(d).map(Some)
}
