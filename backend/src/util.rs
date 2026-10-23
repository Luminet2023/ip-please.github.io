//! 时间、哈希与随机串等小工具。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{SecondsFormat, TimeZone, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// 毫秒时间戳 → ISO-8601（UTC，毫秒精度），用于对外的 `*_at` 字段。
pub fn iso_from_ms(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|moment| moment.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}

/// 毫秒时间戳 → Unix 秒（对外的 `expires_at`）。
pub fn unix_secs(ms: i64) -> i64 {
    ms.div_euclid(1000)
}

pub fn sha256_hex(input: &[u8]) -> String {
    hex::encode(Sha256::digest(input))
}

pub fn sha256_b64url(input: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(input))
}

pub fn b64url(input: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(input)
}

/// `bytes` 字节的安全随机数，base64url 编码（32 字节 → 43 字符）。
pub fn random_b64url(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// 形如 base64url 的不透明串（PKCE、state、RT 等）。
pub fn is_b64url(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_tokens_are_b64url() {
        let token = random_b64url(32);
        assert_eq!(token.len(), 43);
        assert!(is_b64url(&token, 43, 43));
        assert_ne!(token, random_b64url(32));
    }

    #[test]
    fn pkce_challenge_matches_rfc7636_example() {
        // RFC 7636 附录 B 的示例
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            sha256_b64url(verifier.as_bytes()),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn time_helpers() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(unix_secs(1_999), 1);
        assert_eq!(unix_secs(-1), -1);
    }
}
