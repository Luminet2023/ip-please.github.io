//! 本服务自己的 Access Token（HS256 JWT）与 Refresh Token（不透明随机串）。
//!
//! - AT：`{iss, aud:"ip-please", sub:user_*, sid:sess_*, iat, exp}`，只接受 HS256，
//!   按 `kid` 区分当前 / 上一把签名密钥（轮换期间两把都认）。
//! - RT：32 字节安全随机数（base64url，43 字符）。库里只存 SHA-256，不存原文。

use std::collections::HashSet;

use jsonwebtoken::Validation;
use jsonwebtoken::{decode, decode_header, encode, Algorithm, DecodingKey, EncodingKey, Header};
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::error::{AppError, AuthErrorCode};
use crate::ids;
use crate::util::{is_b64url, random_b64url, sha256_hex};

pub const AUDIENCE: &str = "ip-please";
const LEEWAY_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub sid: String,
    pub iat: i64,
    pub exp: i64,
}

struct SigningKey {
    kid: String,
    encoding: EncodingKey,
    decoding: DecodingKey,
}

impl SigningKey {
    fn new(secret: &[u8]) -> Self {
        // kid 取密钥摘要前 8 位：稳定、可区分新旧，不泄露密钥本身。
        Self {
            kid: format!("k{}", &sha256_hex(secret)[..8]),
            encoding: EncodingKey::from_secret(secret),
            decoding: DecodingKey::from_secret(secret),
        }
    }
}

pub struct TokenSigner {
    issuer: String,
    ttl_secs: i64,
    current: SigningKey,
    previous: Option<SigningKey>,
}

impl TokenSigner {
    pub fn new(config: &Config) -> Self {
        Self {
            issuer: config.token_issuer.clone(),
            ttl_secs: config.access_token_ttl_seconds,
            current: SigningKey::new(&config.session_jwt_secret),
            previous: config
                .session_jwt_secret_previous
                .as_deref()
                .map(SigningKey::new),
        }
    }

    pub fn ttl_secs(&self) -> i64 {
        self.ttl_secs
    }

    /// 签发 AT，返回 `(token, exp_unix_secs)`。
    pub fn issue(&self, user_id: &str, session_id: &str, now_secs: i64) -> (String, i64) {
        let exp = now_secs + self.ttl_secs;
        let claims = AccessClaims {
            iss: self.issuer.clone(),
            aud: AUDIENCE.to_string(),
            sub: user_id.to_string(),
            sid: session_id.to_string(),
            iat: now_secs,
            exp,
        };
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some(self.current.kid.clone());
        let token = encode(&header, &claims, &self.current.encoding)
            .expect("HS256 signing with an in-memory key cannot fail");
        (token, exp)
    }

    /// 校验 AT 的签名、算法、iss、aud、exp；任何问题都是 401 `invalid_token`。
    /// 会话是否仍有效由调用方查库判断（吊销 → `token_revoked`）。
    pub fn verify(&self, token: &str) -> Result<AccessClaims, AppError> {
        let invalid = || AppError::Auth(AuthErrorCode::InvalidToken);
        let header = decode_header(token).map_err(|_| invalid())?;
        if header.alg != Algorithm::HS256 {
            return Err(invalid());
        }
        let key = match header.kid.as_deref() {
            None => &self.current,
            Some(kid) if kid == self.current.kid => &self.current,
            Some(kid) => match &self.previous {
                Some(previous) if previous.kid == kid => previous,
                _ => return Err(invalid()),
            },
        };

        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = LEEWAY_SECS;
        validation.set_issuer(&[self.issuer.as_str()]);
        validation.set_audience(&[AUDIENCE]);
        validation.required_spec_claims = ["exp", "iss", "aud", "sub"]
            .into_iter()
            .map(ToString::to_string)
            .collect::<HashSet<_>>();

        let claims = decode::<AccessClaims>(token, &key.decoding, &validation)
            .map_err(|err| {
                tracing::debug!(error = %err, "access token rejected");
                invalid()
            })?
            .claims;
        if !ids::is_valid(&claims.sub, ids::PREFIX_USER)
            || !ids::is_valid(&claims.sid, ids::PREFIX_SESSION)
        {
            return Err(invalid());
        }
        Ok(claims)
    }
}

/// 新的 Refresh Token 原文（只在响应里出现一次）。
pub fn new_refresh_token() -> String {
    random_b64url(32)
}

/// RT 的库内形式。
pub fn refresh_token_hash(token: &str) -> String {
    sha256_hex(token.as_bytes())
}

/// RT 外形校验：43 位 base64url。
pub fn is_refresh_token_shape(token: &str) -> bool {
    is_b64url(token, 43, 43)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::now_ms;

    fn signer_with(secret: &[u8], previous: Option<&[u8]>) -> TokenSigner {
        let mut config = Config::for_tests("mysql://unused", "https://idp.test/realms/t");
        config.session_jwt_secret = secret.to_vec();
        config.session_jwt_secret_previous = previous.map(<[u8]>::to_vec);
        TokenSigner::new(&config)
    }

    fn ids() -> (String, String) {
        (
            ids::generate(ids::PREFIX_USER),
            ids::generate(ids::PREFIX_SESSION),
        )
    }

    #[test]
    fn round_trip() {
        let signer = signer_with(b"0123456789abcdef0123456789abcdef", None);
        let (user, sess) = ids();
        let now = now_ms() / 1000;
        let (token, exp) = signer.issue(&user, &sess, now);
        assert_eq!(exp, now + 600);
        let claims = signer.verify(&token).expect("valid token");
        assert_eq!(claims.sub, user);
        assert_eq!(claims.sid, sess);
        assert_eq!(claims.aud, AUDIENCE);
    }

    #[test]
    fn rejects_wrong_secret_and_expired() {
        let a = signer_with(b"0123456789abcdef0123456789abcdef", None);
        let b = signer_with(b"fedcba9876543210fedcba9876543210", None);
        let (user, sess) = ids();
        let now = now_ms() / 1000;
        let (token, _) = a.issue(&user, &sess, now);
        assert!(b.verify(&token).is_err(), "different secret");
        let (old, _) = a.issue(&user, &sess, now - 2000);
        assert!(a.verify(&old).is_err(), "expired beyond leeway");
    }

    #[test]
    fn previous_key_is_accepted_during_rotation() {
        let old_secret = b"0123456789abcdef0123456789abcdef";
        let old = signer_with(old_secret, None);
        let rotated = signer_with(b"fedcba9876543210fedcba9876543210", Some(old_secret));
        let (user, sess) = ids();
        let (token, _) = old.issue(&user, &sess, now_ms() / 1000);
        assert!(rotated.verify(&token).is_ok());
    }

    #[test]
    fn rejects_none_and_rs256_and_foreign_claims() {
        let signer = signer_with(b"0123456789abcdef0123456789abcdef", None);
        // alg=none
        let none = format!(
            "{}.{}.",
            crate::util::b64url(br#"{"alg":"none","typ":"JWT"}"#),
            crate::util::b64url(br#"{"sub":"user_aaaaaaaaaaaaaaaaaaaaaa"}"#)
        );
        assert!(signer.verify(&none).is_err());
        // RS256 头（算法混淆）
        let rs = format!(
            "{}.{}.sig",
            crate::util::b64url(br#"{"alg":"RS256","typ":"JWT"}"#),
            crate::util::b64url(br#"{"sub":"x"}"#)
        );
        assert!(signer.verify(&rs).is_err());
        // sub 不是 user_* 前缀
        let (_, sess) = ids();
        let (token, _) = signer.issue("12345", &sess, now_ms() / 1000);
        assert!(signer.verify(&token).is_err());
    }

    #[test]
    fn refresh_tokens() {
        let token = new_refresh_token();
        assert!(is_refresh_token_shape(&token));
        assert_eq!(refresh_token_hash(&token).len(), 64);
        assert!(!is_refresh_token_shape("short"));
    }
}
