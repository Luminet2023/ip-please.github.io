//! 与 IdP（Keycloak）的交互：授权 URL、服务器端换码、ID Token 校验、
//! OIDC Back-Channel Logout 1.0 的 Logout Token 校验。
//!
//! IdP 签发的 Token 只在这里用来确认身份，确认后即丢弃；对外只发本服务自己的 AT/RT。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use jsonwebtoken::{decode, decode_header, Algorithm, Validation};
use serde::Deserialize;
use serde_json::Value;

use crate::auth::jwks::JwksCache;
use crate::config::Config;
use crate::error::{AppError, AuthErrorCode, DetailCode};
use crate::profile::Profile;

pub const BACKCHANNEL_EVENT: &str = "http://schemas.openid.net/event/backchannel-logout";
const LEEWAY_SECS: u64 = 30;
const LOGOUT_TOKEN_MAX_AGE_SECS: i64 = 600;
const LOGOUT_TOKEN_MAX_SKEW_SECS: i64 = 60;
const JTI_TTL: Duration = Duration::from_secs(600);

/// 构造授权跳转地址（code + PKCE S256 + nonce）。
pub fn authorize_url(
    authorization_endpoint: &str,
    config: &Config,
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    code_challenge: &str,
) -> anyhow::Result<String> {
    let url = reqwest::Url::parse_with_params(
        authorization_endpoint,
        &[
            ("client_id", config.oidc_client_id.as_str()),
            ("redirect_uri", redirect_uri),
            ("response_type", "code"),
            ("scope", config.oidc_scope.as_str()),
            ("state", state),
            ("nonce", nonce),
            ("code_challenge", code_challenge),
            ("code_challenge_method", "S256"),
        ],
    )?;
    Ok(url.into())
}

#[derive(Debug, Deserialize)]
pub struct TokenSet {
    pub id_token: String,
    #[serde(default)]
    pub access_token: Option<String>,
}

/// 换码失败的两类原因：IdP 明确拒绝（授权码无效 / 已用 / 客户端配置不符）与 IdP 不可达。
#[derive(Debug)]
pub enum ExchangeError {
    Rejected(String),
    Unavailable(anyhow::Error),
}

/// 在服务器端用授权码换 Token。配置了 client secret 时用 `client_secret_basic`。
pub async fn exchange_code(
    jwks: &JwksCache,
    config: &Config,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<TokenSet, ExchangeError> {
    let endpoints = jwks.endpoints().await.map_err(ExchangeError::Unavailable)?;
    let mut request = jwks.http().post(&endpoints.token_endpoint).form(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
        ("client_id", config.oidc_client_id.as_str()),
    ]);
    if let Some(secret) = &config.oidc_client_secret {
        request = request.basic_auth(&config.oidc_client_id, Some(secret));
    }
    let response = request
        .send()
        .await
        .map_err(|err| ExchangeError::Unavailable(err.into()))?;
    let status = response.status();
    if status.is_server_error() {
        return Err(ExchangeError::Unavailable(anyhow::anyhow!(
            "token endpoint returned {status}"
        )));
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let reason = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value.get("error").and_then(Value::as_str).map(String::from))
            .unwrap_or_else(|| status.to_string());
        return Err(ExchangeError::Rejected(reason));
    }
    response
        .json::<TokenSet>()
        .await
        .map_err(|err| ExchangeError::Rejected(format!("malformed token response: {err}")))
}

#[derive(Debug, Deserialize)]
struct IdTokenClaims {
    sub: String,
    #[serde(default)]
    sid: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    azp: Option<String>,
    #[serde(flatten)]
    extra: HashMap<String, Value>,
}

/// ID Token 里确认出的身份。
#[derive(Debug, Clone)]
pub struct Identity {
    pub subject: String,
    pub idp_sid: Option<String>,
    pub roles: Vec<String>,
    /// 展示用的名字与头像（`profile` scope 的 claims）。
    pub profile: Profile,
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(String::from))
            .collect(),
        Some(Value::String(single)) => vec![single.clone()],
        _ => Vec::new(),
    }
}

/// `resource_access.{client_id}.roles`（Keycloak 默认放在 IdP 的 Access Token 里）。
fn client_roles(claims: &HashMap<String, Value>, client_id: &str) -> Vec<String> {
    strings(
        claims
            .get("resource_access")
            .and_then(|access| access.get(client_id))
            .and_then(|client| client.get("roles")),
    )
}

/// 校验 ID Token：RS256 签名、iss、aud、exp、nonce、azp。
pub async fn verify_id_token(
    jwks: &JwksCache,
    config: &Config,
    token: &str,
    expected_nonce: &str,
) -> Result<Identity, AppError> {
    let invalid = || AppError::Detail(DetailCode::LoginAttemptInvalid);
    let header = decode_header(token).map_err(|_| invalid())?;
    if header.alg != Algorithm::RS256 {
        return Err(invalid());
    }
    let key = jwks
        .key(header.kid.as_deref().unwrap_or_default())
        .await
        .map_err(|err| match err {
            AppError::Auth(AuthErrorCode::SessionValidationFailed) => err,
            _ => invalid(),
        })?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.leeway = LEEWAY_SECS;
    validation.set_issuer(&[config.oidc_issuer.as_str()]);
    validation.set_audience(&[config.oidc_client_id.as_str()]);
    let claims = decode::<IdTokenClaims>(token, &key, &validation)
        .map_err(|err| {
            tracing::warn!(error = %err, "ID token rejected");
            invalid()
        })?
        .claims;

    if claims.sub.trim().is_empty() || claims.nonce.as_deref() != Some(expected_nonce) {
        return Err(invalid());
    }
    if let Some(azp) = &claims.azp {
        if azp != &config.oidc_client_id {
            return Err(invalid());
        }
    }

    let mut roles = strings(claims.extra.get(&config.oidc_roles_claim));
    roles.extend(client_roles(&claims.extra, &config.oidc_client_id));
    Ok(Identity {
        profile: Profile::from_claims(&claims.extra, config),
        subject: claims.sub,
        idp_sid: claims.sid.filter(|sid| !sid.is_empty()),
        roles,
    })
}

/// 从 IdP 的 Access Token 读客户端角色（尽力而为：验签失败就当没有角色）。
pub async fn roles_from_access_token(
    jwks: &JwksCache,
    config: &Config,
    token: &str,
) -> Vec<String> {
    let Ok(header) = decode_header(token) else {
        return Vec::new();
    };
    if header.alg != Algorithm::RS256 {
        return Vec::new();
    }
    let Ok(key) = jwks.key(header.kid.as_deref().unwrap_or_default()).await else {
        return Vec::new();
    };
    let mut validation = Validation::new(Algorithm::RS256);
    validation.leeway = LEEWAY_SECS;
    validation.validate_aud = false;
    validation.set_issuer(&[config.oidc_issuer.as_str()]);
    match decode::<HashMap<String, Value>>(token, &key, &validation) {
        Ok(data) => client_roles(&data.claims, &config.oidc_client_id),
        Err(err) => {
            tracing::debug!(error = %err, "IdP access token not usable for roles");
            Vec::new()
        }
    }
}

#[derive(Debug, Deserialize)]
struct LogoutClaims {
    #[serde(default)]
    iat: Option<i64>,
    #[serde(default)]
    jti: Option<String>,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    sid: Option<String>,
    #[serde(default)]
    nonce: Option<Value>,
    #[serde(default)]
    events: Option<Value>,
}

/// 校验通过的注销请求：要吊销的 IdP 会话 / 用户。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogoutRequest {
    pub sid: Option<String>,
    pub subject: Option<String>,
}

/// 按 OIDC Back-Channel Logout 1.0 §2.6 校验 Logout Token。
/// 校验失败 → 400 `invalid_request`；JWKS 不可用 → 503 `backend_unavailable`。
pub async fn verify_logout_token(
    jwks: &JwksCache,
    config: &Config,
    replay: &JtiCache,
    token: &str,
    now_secs: i64,
) -> Result<LogoutRequest, AppError> {
    let invalid = || AppError::Detail(DetailCode::ValidationError);
    let header = decode_header(token).map_err(|_| invalid())?;
    if header.alg != Algorithm::RS256 {
        return Err(invalid());
    }
    let key = jwks
        .key(header.kid.as_deref().unwrap_or_default())
        .await
        .map_err(|err| match err {
            AppError::Auth(AuthErrorCode::SessionValidationFailed) => {
                AppError::Detail(DetailCode::BackendUnavailable)
            }
            _ => invalid(),
        })?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.leeway = LEEWAY_SECS;
    validation.set_issuer(&[config.oidc_issuer.as_str()]);
    validation.set_audience(&[config.oidc_client_id.as_str()]);
    // Logout Token 不一定带 exp；带了就校验（jsonwebtoken 只在存在时检查）。
    validation.required_spec_claims = ["iss", "aud"]
        .into_iter()
        .map(ToString::to_string)
        .collect::<HashSet<_>>();
    let claims = decode::<LogoutClaims>(token, &key, &validation)
        .map_err(|err| {
            tracing::warn!(error = %err, "logout token rejected");
            invalid()
        })?
        .claims;

    let Some(iat) = claims.iat else {
        return Err(invalid());
    };
    if iat < now_secs - LOGOUT_TOKEN_MAX_AGE_SECS || iat > now_secs + LOGOUT_TOKEN_MAX_SKEW_SECS {
        return Err(invalid());
    }
    let has_event = claims
        .events
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|events| events.get(BACKCHANNEL_EVENT))
        .is_some_and(Value::is_object);
    if !has_event || claims.nonce.is_some() {
        return Err(invalid());
    }
    let sid = claims.sid.filter(|value| !value.is_empty());
    let subject = claims.sub.filter(|value| !value.is_empty());
    if sid.is_none() && subject.is_none() {
        return Err(invalid());
    }
    if let Some(jti) = &claims.jti {
        if !replay.first_use(jti) {
            return Err(invalid());
        }
    }
    Ok(LogoutRequest { sid, subject })
}

/// Logout Token 的 `jti` 防重放（进程内，10 分钟，与 iat 的接受窗口一致）。
#[derive(Default)]
pub struct JtiCache {
    seen: Mutex<HashMap<String, Instant>>,
}

impl JtiCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// 第一次见到返回 true；重放返回 false。
    pub fn first_use(&self, jti: &str) -> bool {
        let now = Instant::now();
        let mut seen = self.seen.lock().expect("jti mutex");
        seen.retain(|_, at| now.duration_since(*at) < JTI_TTL);
        if seen.contains_key(jti) {
            return false;
        }
        seen.insert(jti.to_string(), now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::jwks::Endpoints;
    use jsonwebtoken::{encode, DecodingKey, EncodingKey, Header};
    use serde_json::json;

    const PRIVATE_PEM: &[u8] = include_bytes!("../../tests/fixtures/test_rsa_private.pem");
    const PUBLIC_PEM: &[u8] = include_bytes!("../../tests/fixtures/test_rsa_public.pem");
    const ISSUER: &str = "https://idp.test/realms/t";
    const KID: &str = "test-key";

    fn config() -> Config {
        Config::for_tests("mysql://unused", ISSUER)
    }

    fn jwks() -> JwksCache {
        let endpoints = Endpoints {
            issuer: ISSUER.into(),
            jwks_uri: format!("{ISSUER}/certs"),
            authorization_endpoint: format!("{ISSUER}/auth"),
            token_endpoint: format!("{ISSUER}/token"),
        };
        let mut keys = HashMap::new();
        keys.insert(
            KID.to_string(),
            DecodingKey::from_rsa_pem(PUBLIC_PEM).expect("public key"),
        );
        JwksCache::with_fixed_keys(ISSUER, endpoints, keys).expect("jwks")
    }

    fn sign(claims: &Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(KID.into());
        encode(
            &header,
            claims,
            &EncodingKey::from_rsa_pem(PRIVATE_PEM).expect("private key"),
        )
        .expect("sign")
    }

    fn now() -> i64 {
        crate::util::unix_secs(crate::util::now_ms())
    }

    fn id_claims() -> Value {
        let cfg = config();
        json!({
            "iss": ISSUER, "aud": cfg.oidc_client_id, "azp": cfg.oidc_client_id,
            "sub": "kc-subject-1", "sid": "kc-session-1", "nonce": "nonce-1",
            "iat": now(), "exp": now() + 300,
            "ip_please_roles": ["ip-please-admin"],
            "name": "小鱼干", "picture": "https://cdn.test/fish.png",
        })
    }

    #[tokio::test]
    async fn id_token_valid() {
        let identity = verify_id_token(&jwks(), &config(), &sign(&id_claims()), "nonce-1")
            .await
            .expect("valid");
        assert_eq!(identity.subject, "kc-subject-1");
        assert_eq!(identity.idp_sid.as_deref(), Some("kc-session-1"));
        assert_eq!(identity.roles, vec!["ip-please-admin".to_string()]);
        assert_eq!(identity.profile.display_name, "小鱼干");
        assert_eq!(
            identity.profile.avatar_url.as_deref(),
            Some("https://cdn.test/fish.png")
        );
    }

    #[tokio::test]
    async fn id_token_rejections() {
        let jwks = jwks();
        let cfg = config();
        let expect_invalid = |result: Result<Identity, AppError>| {
            assert!(matches!(
                result,
                Err(AppError::Detail(DetailCode::LoginAttemptInvalid))
            ));
        };
        expect_invalid(verify_id_token(&jwks, &cfg, &sign(&id_claims()), "other").await);

        let mut wrong_aud = id_claims();
        wrong_aud["aud"] = json!("someone-else");
        expect_invalid(verify_id_token(&jwks, &cfg, &sign(&wrong_aud), "nonce-1").await);

        let mut wrong_azp = id_claims();
        wrong_azp["azp"] = json!("someone-else");
        expect_invalid(verify_id_token(&jwks, &cfg, &sign(&wrong_azp), "nonce-1").await);

        let mut expired = id_claims();
        expired["exp"] = json!(now() - 600);
        expect_invalid(verify_id_token(&jwks, &cfg, &sign(&expired), "nonce-1").await);

        let mut wrong_iss = id_claims();
        wrong_iss["iss"] = json!("https://evil.test");
        expect_invalid(verify_id_token(&jwks, &cfg, &sign(&wrong_iss), "nonce-1").await);

        // 算法混淆：拿公钥当 HMAC 密钥签 HS256
        let hs = encode(
            &Header::new(Algorithm::HS256),
            &id_claims(),
            &EncodingKey::from_secret(PUBLIC_PEM),
        )
        .unwrap();
        expect_invalid(verify_id_token(&jwks, &cfg, &hs, "nonce-1").await);

        // 未知 kid
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("unknown".into());
        let unknown = encode(
            &header,
            &id_claims(),
            &EncodingKey::from_rsa_pem(PRIVATE_PEM).unwrap(),
        )
        .unwrap();
        expect_invalid(verify_id_token(&jwks, &cfg, &unknown, "nonce-1").await);
    }

    #[test]
    fn client_roles_are_read_from_resource_access() {
        let claims: HashMap<String, Value> = serde_json::from_value(json!({
            "resource_access": {
                "app_test_client_0001": { "roles": ["ip-please-admin", "x"] },
                "other": { "roles": ["nope"] }
            }
        }))
        .unwrap();
        assert_eq!(
            client_roles(&claims, "app_test_client_0001"),
            vec!["ip-please-admin".to_string(), "x".to_string()]
        );
    }

    fn logout_claims() -> Value {
        let cfg = config();
        json!({
            "iss": ISSUER, "aud": cfg.oidc_client_id, "iat": now(),
            "jti": format!("jti-{}", crate::util::random_b64url(8)),
            "sub": "kc-subject-1", "sid": "kc-session-1",
            "events": { BACKCHANNEL_EVENT: {} },
        })
    }

    async fn check_logout(claims: &Value, replay: &JtiCache) -> Result<LogoutRequest, AppError> {
        verify_logout_token(&jwks(), &config(), replay, &sign(claims), now()).await
    }

    #[tokio::test]
    async fn logout_token_valid_variants() {
        let replay = JtiCache::new();
        let both = check_logout(&logout_claims(), &replay)
            .await
            .expect("valid");
        assert_eq!(both.sid.as_deref(), Some("kc-session-1"));
        assert_eq!(both.subject.as_deref(), Some("kc-subject-1"));

        let mut sid_only = logout_claims();
        sid_only.as_object_mut().unwrap().remove("sub");
        let request = check_logout(&sid_only, &replay).await.expect("sid only");
        assert_eq!(request.subject, None);

        let mut sub_only = logout_claims();
        sub_only.as_object_mut().unwrap().remove("sid");
        let request = check_logout(&sub_only, &replay).await.expect("sub only");
        assert_eq!(request.sid, None);
    }

    #[tokio::test]
    async fn logout_token_rejections() {
        let replay = JtiCache::new();
        let reject = |result: Result<LogoutRequest, AppError>| {
            assert!(matches!(
                result,
                Err(AppError::Detail(DetailCode::ValidationError))
            ));
        };

        let mut no_events = logout_claims();
        no_events.as_object_mut().unwrap().remove("events");
        reject(check_logout(&no_events, &replay).await);

        let mut events_not_object = logout_claims();
        events_not_object["events"] = json!({ BACKCHANNEL_EVENT: "yes" });
        reject(check_logout(&events_not_object, &replay).await);

        let mut with_nonce = logout_claims();
        with_nonce["nonce"] = json!("n");
        reject(check_logout(&with_nonce, &replay).await);

        let mut anonymous = logout_claims();
        anonymous.as_object_mut().unwrap().remove("sid");
        anonymous.as_object_mut().unwrap().remove("sub");
        reject(check_logout(&anonymous, &replay).await);

        let mut wrong_aud = logout_claims();
        wrong_aud["aud"] = json!("other-client");
        reject(check_logout(&wrong_aud, &replay).await);

        let mut stale = logout_claims();
        stale["iat"] = json!(now() - 3600);
        reject(check_logout(&stale, &replay).await);

        let mut no_iat = logout_claims();
        no_iat.as_object_mut().unwrap().remove("iat");
        reject(check_logout(&no_iat, &replay).await);

        let replayed = logout_claims();
        assert!(check_logout(&replayed, &replay).await.is_ok());
        reject(check_logout(&replayed, &replay).await);
    }

    #[test]
    fn authorize_url_has_pkce_and_nonce() {
        let url = authorize_url(
            &format!("{ISSUER}/protocol/openid-connect/auth"),
            &config(),
            "https://game.test/",
            "state-1",
            "nonce-1",
            "challenge-1",
        )
        .unwrap();
        let parsed = reqwest::Url::parse(&url).unwrap();
        let params: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(params["response_type"], "code");
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["code_challenge"], "challenge-1");
        assert_eq!(params["nonce"], "nonce-1");
        assert_eq!(params["state"], "state-1");
        assert_eq!(params["redirect_uri"], "https://game.test/");
        assert_eq!(params["scope"], "openid profile");
    }
}
