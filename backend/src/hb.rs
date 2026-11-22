//! 红包凭证（hb attestation）：把 LINUX DO 小程序玩家在某个榜上的个人最高分签成一枚短期 ES256 JWT，
//! 给 LINUX DO 红包站的代码判定红包（judge）离线验签用。
//!
//! - 只给小程序身份签（`linuxdo_id` 来自已验签的平台 JWT）；网站账号没有 `linuxdo_id`，不签。
//! - 只签服务器已经结算进 `ip_please_mapp_leaderboard` 的成绩，不签进行中的对局。
//! - 私钥来自 `HB_ATTEST_KEY`（PKCS#8 PEM，P-256）；没配就整个功能关闭（接口 404）。
//! - 公钥：`GET /anthropic/v1/hb/jwks`。`kid` 是 RFC 7638 JWK 指纹，judge 可以直接内置公钥。

use anyhow::{bail, Context};
use axum::{extract::State, http::StatusCode, response::Response};
use base64::Engine;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde_json::{json, Value};

use crate::{
    error::{private_json, AppError, DetailCode},
    util::{b64url, random_b64url, sha256_b64url},
    AppState,
};

/// 凭证的 `aud`。judge 必须校验它，避免把本服务别的 JWT 当成红包凭证。
pub const AUDIENCE: &str = "ip-please-hb";
/// JWT header 的 `typ`（RFC 8725 §3.11 显式类型）。
pub const TOKEN_TYPE: &str = "ip-please-hb+jwt";
/// 凭证里 `game` 字段的固定值，方便以后别的小游戏共用同一格式。
pub const GAME: &str = "ip-please";

pub struct Attester {
    key: EncodingKey,
    kid: String,
    jwk: Value,
    issuer: String,
    ttl_secs: i64,
}

/// 读 `HB_ATTEST_KEY`：PKCS#8 PEM，允许环境变量里把换行写成字面量 `\n`。
pub fn pem_to_der(pem: &str) -> anyhow::Result<Vec<u8>> {
    let pem = pem.replace("\\n", "\n");
    let body = pem
        .trim()
        .strip_prefix("-----BEGIN PRIVATE KEY-----")
        .and_then(|rest| rest.trim_end().strip_suffix("-----END PRIVATE KEY-----"))
        .context(
            "HB_ATTEST_KEY must be a PKCS#8 PEM (-----BEGIN PRIVATE KEY-----); generate with: \
             openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256",
        )?;
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(compact)
        .context("HB_ATTEST_KEY is not valid base64")
}

impl Attester {
    pub fn from_pkcs8_der(der: &[u8], issuer: &str, ttl_secs: i64) -> anyhow::Result<Self> {
        let pair = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            der,
            &ring::rand::SystemRandom::new(),
        )
        .map_err(|_| anyhow::anyhow!("HB_ATTEST_KEY must be a P-256 (prime256v1) private key"))?;
        let point = pair.public_key().as_ref();
        if point.len() != 65 || point[0] != 0x04 {
            bail!("unexpected P-256 public key encoding");
        }
        let (x, y) = (b64url(&point[1..33]), b64url(&point[33..]));
        // RFC 7638：必需成员按字典序、无空白。
        let kid = sha256_b64url(
            format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#).as_bytes(),
        );
        let jwk = json!({"kty":"EC","crv":"P-256","x":x,"y":y,"kid":kid,"alg":"ES256","use":"sig"});
        Ok(Self {
            key: EncodingKey::from_ec_der(der),
            kid,
            jwk,
            issuer: issuer.to_string(),
            ttl_secs,
        })
    }

    pub fn kid(&self) -> &str {
        &self.kid
    }

    pub fn jwks(&self) -> Value {
        json!({ "keys": [self.jwk] })
    }

    /// 签一枚凭证。`score` 里放榜单行的字段；`now_secs` 由调用方给，方便测试。
    pub fn sign(&self, claims: AttestClaims<'_>, now_secs: i64) -> Result<Value, AppError> {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(self.kid.clone());
        header.typ = Some(TOKEN_TYPE.into());
        let exp = now_secs + self.ttl_secs;
        let mut body = json!({
            "iss": self.issuer,
            "aud": AUDIENCE,
            "sub": claims.linuxdo_id,
            "iat": now_secs,
            "exp": exp,
            "jti": random_b64url(16),
            "game": GAME,
            "board": claims.board,
            "period": claims.period,
            "score": claims.score,
            "travelers": claims.travelers,
            "best_streak": claims.best_streak,
            "rank": claims.rank,
            "run_id": claims.run_id,
            "achieved_at": claims.achieved_at,
        });
        if let Some(nonce) = claims.nonce {
            body["nonce"] = json!(nonce);
        }
        let token = jsonwebtoken::encode(&header, &body, &self.key)
            .map_err(|e| AppError::Internal(e.into()))?;
        Ok(json!({ "token": token, "expires_at": exp, "claims": body }))
    }
}

pub struct AttestClaims<'a> {
    pub linuxdo_id: &'a str,
    pub board: &'a str,
    pub period: &'a str,
    pub score: i64,
    pub travelers: i32,
    pub best_streak: i32,
    pub rank: i64,
    pub run_id: &'a str,
    pub achieved_at: String,
    pub nonce: Option<&'a str>,
}

/// 玩家自己填的绑定值（一般填红包编号），原样进凭证，judge 比对。
pub fn valid_nonce(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// `GET /anthropic/v1/hb/jwks`（无需登录）。功能关闭时 404。
pub async fn jwks(State(state): State<AppState>) -> Result<Response, AppError> {
    let attester = state
        .hb
        .as_ref()
        .ok_or(AppError::Detail(DetailCode::NotFound))?;
    Ok(private_json(StatusCode::OK, attester.jwks()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};

    // 测试专用 P-256 密钥，只在 tests/fixtures 里。
    const TEST_KEY: &str = include_str!("../tests/fixtures/test_hb_private.pem");

    fn attester() -> Attester {
        Attester::from_pkcs8_der(
            &pem_to_der(TEST_KEY).unwrap(),
            "https://api.test/anthropic",
            900,
        )
        .unwrap()
    }

    fn claims(nonce: Option<&str>) -> AttestClaims<'_> {
        AttestClaims {
            linuxdo_id: "12345",
            board: "daily",
            period: "2026-11-22",
            score: 4200,
            travelers: 40,
            best_streak: 17,
            rank: 3,
            run_id: "run_aaaaaaaaaaaaaaaaaaaa",
            achieved_at: "2026-11-22T10:00:00.000Z".into(),
            nonce,
        }
    }

    #[test]
    fn signs_verifiable_es256_with_jwks_key() {
        let a = attester();
        let now = jsonwebtoken::get_current_timestamp() as i64;
        let out = a.sign(claims(Some("hb-001")), now).unwrap();
        let token = out["token"].as_str().unwrap();
        let header = decode_header(token).unwrap();
        assert_eq!(header.alg, Algorithm::ES256);
        assert_eq!(header.typ.as_deref(), Some(TOKEN_TYPE));
        assert_eq!(header.kid.as_deref(), Some(a.kid()));

        let jwk = &a.jwks()["keys"][0];
        let key =
            DecodingKey::from_ec_components(jwk["x"].as_str().unwrap(), jwk["y"].as_str().unwrap())
                .unwrap();
        let mut v = Validation::new(Algorithm::ES256);
        v.set_audience(&[AUDIENCE]);
        v.set_issuer(&["https://api.test/anthropic"]);
        let data = decode::<Value>(token, &key, &v).unwrap();
        let c = data.claims;
        assert_eq!(c["sub"], "12345");
        assert_eq!(c["score"], 4200);
        assert_eq!(c["nonce"], "hb-001");
        assert_eq!(c["game"], GAME);
        assert_eq!(c["exp"].as_i64().unwrap() - c["iat"].as_i64().unwrap(), 900);
        assert_eq!(out["expires_at"], c["exp"]);
    }

    #[test]
    fn nonce_is_omitted_when_absent_and_tampering_fails() {
        let a = attester();
        let now = jsonwebtoken::get_current_timestamp() as i64;
        let token = a.sign(claims(None), now).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        let jwk = &a.jwks()["keys"][0];
        let key =
            DecodingKey::from_ec_components(jwk["x"].as_str().unwrap(), jwk["y"].as_str().unwrap())
                .unwrap();
        let mut v = Validation::new(Algorithm::ES256);
        v.set_audience(&[AUDIENCE]);
        let c = decode::<Value>(&token, &key, &v).unwrap().claims;
        assert!(c.get("nonce").is_none());

        // 改分数：签名必须失效。
        let parts: Vec<&str> = token.split('.').collect();
        let mut body: Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(parts[1])
                .unwrap(),
        )
        .unwrap();
        body["score"] = json!(999_999);
        let forged = format!(
            "{}.{}.{}",
            parts[0],
            b64url(body.to_string().as_bytes()),
            parts[2]
        );
        assert!(decode::<Value>(&forged, &key, &v).is_err());
    }

    #[test]
    fn kid_is_rfc7638_thumbprint() {
        let a = attester();
        let jwk = &a.jwks()["keys"][0];
        let canonical = format!(
            r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#,
            jwk["x"].as_str().unwrap(),
            jwk["y"].as_str().unwrap()
        );
        assert_eq!(a.kid(), sha256_b64url(canonical.as_bytes()));
        assert_eq!(jwk["kid"], a.kid());
        assert!(
            jwk.get("d").is_none(),
            "JWKS must not leak the private scalar"
        );
    }

    #[test]
    fn pem_parsing() {
        assert!(pem_to_der(&TEST_KEY.replace('\n', "\\n")).is_ok());
        assert!(
            pem_to_der("-----BEGIN EC PRIVATE KEY-----\nAA==\n-----END EC PRIVATE KEY-----")
                .is_err()
        );
        assert!(Attester::from_pkcs8_der(b"not a key", "i", 900).is_err());
    }

    #[test]
    fn nonce_rules() {
        assert!(valid_nonce("hb-001_x.y"));
        assert!(!valid_nonce(""));
        assert!(!valid_nonce(&"a".repeat(65)));
        assert!(!valid_nonce("有中文"));
        assert!(!valid_nonce("a b"));
    }
}
