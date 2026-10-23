//! 进程内固定窗口限流。只适用于单实例部署（与 deploy/README.md 的说明一致）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::error::{AppError, DetailCode};

/// 一个限流桶：`limit` 次 / `window`。超限时返回 `code`（带 `Retry-After`）。
#[derive(Clone, Copy, Debug)]
pub struct Rule {
    pub bucket: &'static str,
    pub limit: u32,
    pub window: Duration,
    pub code: DetailCode,
}

impl Rule {
    pub const fn per_minute(bucket: &'static str, limit: u32) -> Self {
        Self {
            bucket,
            limit,
            window: Duration::from_secs(60),
            code: DetailCode::RateLimited,
        }
    }

    pub const fn per_seconds(bucket: &'static str, limit: u32, seconds: u64) -> Self {
        Self {
            bucket,
            limit,
            window: Duration::from_secs(seconds),
            code: DetailCode::RateLimited,
        }
    }
}

pub const AUTH_LOGIN: Rule = Rule::per_minute("auth_login", 10);
pub const AUTH_REFRESH: Rule = Rule::per_minute("auth_refresh", 30);
pub const AUTH_BACKCHANNEL: Rule = Rule::per_minute("auth_backchannel", 60);
pub const PUBLIC_READ: Rule = Rule::per_minute("public_read", 120);
pub const ADMIN_WRITE: Rule = Rule::per_minute("admin_write", 30);
pub const ENDLESS_ACTION: Rule = Rule::per_seconds("endless_action", 8, 1);
pub const ENDLESS_START: Rule = Rule::per_seconds("endless_start", 1, 10);

const PRUNE_THRESHOLD: usize = 4096;

/// (桶, 键) → (窗口起点, 已用次数)
type Windows = HashMap<(&'static str, String), (Instant, u32)>;

#[derive(Default)]
pub struct RateLimiter {
    windows: Mutex<Windows>,
    disabled: bool,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// 测试用：不限流（集成测试在一秒内连发大量请求）。
    pub fn disabled() -> Self {
        Self {
            disabled: true,
            ..Self::default()
        }
    }

    pub fn check(&self, rule: Rule, key: &str) -> Result<(), AppError> {
        self.check_at(rule, key, Instant::now())
    }

    fn check_at(&self, rule: Rule, key: &str, now: Instant) -> Result<(), AppError> {
        if self.disabled || rule.limit == 0 || rule.window.is_zero() {
            return Ok(());
        }
        let mut windows = self.windows.lock().expect("rate limiter mutex");
        if windows.len() > PRUNE_THRESHOLD {
            windows.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(3600));
        }
        let entry = windows
            .entry((rule.bucket, key.to_string()))
            .or_insert((now, 0));
        if now.duration_since(entry.0) >= rule.window {
            *entry = (now, 0);
        }
        if entry.1 >= rule.limit {
            let remaining = rule.window.saturating_sub(now.duration_since(entry.0));
            return Err(AppError::DetailRetryAfter(
                rule.code,
                remaining.as_secs().max(1),
            ));
        }
        entry.1 += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_limit_and_resets_after_window() {
        let limiter = RateLimiter::new();
        let rule = Rule::per_seconds("t", 2, 10);
        let start = Instant::now();
        assert!(limiter.check_at(rule, "a", start).is_ok());
        assert!(limiter.check_at(rule, "a", start).is_ok());
        match limiter.check_at(rule, "a", start + Duration::from_secs(3)) {
            Err(AppError::DetailRetryAfter(DetailCode::RateLimited, secs)) => assert_eq!(secs, 7),
            other => panic!("expected rate limit, got {other:?}"),
        }
        assert!(
            limiter.check_at(rule, "b", start).is_ok(),
            "keys are independent"
        );
        assert!(limiter
            .check_at(rule, "a", start + Duration::from_secs(10))
            .is_ok());
    }

    #[test]
    fn zero_limit_disables() {
        let limiter = RateLimiter::new();
        let rule = Rule::per_seconds("t", 0, 10);
        for _ in 0..10 {
            assert!(limiter.check(rule, "a").is_ok());
        }
    }
}
