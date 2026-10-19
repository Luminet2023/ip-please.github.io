//! 对外标识符（AGENT.md Prefix Registry）。
//!
//! 格式：`^[a-z]{2,8}_[0-9a-zA-Z]{16,32}$`。后缀取自密码学安全随机源，
//! 一旦分配即保持稳定，不可从后缀推导任何业务含义。

use rand::distributions::Alphanumeric;
use rand::Rng;

use crate::error::{AppError, DetailCode};

pub const PREFIX_USER: &str = "user";
pub const PREFIX_SAVE: &str = "save";

const SUFFIX_LEN: usize = 22;

/// 生成一个符合 Prefix Registry 规范的新标识符。
pub fn generate(prefix: &str) -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(SUFFIX_LEN)
        .map(char::from)
        .collect();
    format!("{prefix}_{suffix}")
}

/// 校验标识符：前缀必须匹配，后缀长度 16..=32 且只含 ASCII 字母数字。
pub fn is_valid(value: &str, prefix: &str) -> bool {
    let Some(suffix) = value.strip_prefix(prefix).and_then(|rest| rest.strip_prefix('_')) else {
        return false;
    };
    (16..=32).contains(&suffix.len()) && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// 在 API 边界校验路径/查询参数中的标识符。
pub fn require(value: &str, prefix: &str) -> Result<(), AppError> {
    if is_valid(value, prefix) {
        Ok(())
    } else {
        Err(AppError::Detail(DetailCode::NotFound))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_match_registry_format() {
        for prefix in [PREFIX_USER, PREFIX_SAVE] {
            let id = generate(prefix);
            assert!(is_valid(&id, prefix), "{id} should be valid");
            assert_eq!(id.split('_').count(), 2);
            assert!(!is_valid(&id, "USE"));
            assert!(!is_valid(&id, "user_"));
        }
    }

    #[test]
    fn rejects_raw_numbers_and_bare_uuids() {
        assert!(!is_valid("12345", PREFIX_SAVE));
        assert!(!is_valid("550e8400-e29b-41d4-a716-446655440000", PREFIX_SAVE));
        assert!(!is_valid(&format!("save_{}", "a".repeat(15)), PREFIX_SAVE));
        assert!(!is_valid(&format!("save_{}", "a".repeat(33)), PREFIX_SAVE));
        assert!(!is_valid(&format!("save_{}", "a".repeat(20) + "-"), PREFIX_SAVE));
        assert!(!is_valid(&format!("user_{}", "a".repeat(20)), PREFIX_SAVE));
    }
}
