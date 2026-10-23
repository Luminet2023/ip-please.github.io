//! 可复现的随机源：同一个种子、同一个位置，永远生成同一位旅客（每日挑战全服一致的前提）。
//!
//! 每个位置一条独立子流：`ChaCha20(HMAC-SHA256(seed, "label:idx"))`，玩家的操作不会影响后面的序列。
//! 抽样函数自己实现，不用 `gen_range` 等：避免 rand 升级后同一种子出不同结果。

use hmac::{Hmac, Mac};
use rand::{RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use sha2::Sha256;

pub type Seed = [u8; 32];

pub struct Stream(ChaCha20Rng);

fn hmac(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message);
    mac.finalize().into_bytes().into()
}

/// 种子在位置 `idx` 上、用途为 `label` 的子流。
pub fn stream(seed: &Seed, label: &str, idx: u64) -> Stream {
    Stream(ChaCha20Rng::from_seed(hmac(
        seed,
        format!("{label}:{idx}").as_bytes(),
    )))
}

/// 每日挑战的种子：由服务器密钥和日期决定，不知道密钥就无法提前推算。
pub fn daily_seed(secret: &[u8], date: &str) -> Seed {
    hmac(secret, format!("daily:{date}").as_bytes())
}

pub fn random_seed() -> Seed {
    let mut seed = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut seed);
    seed
}

impl Stream {
    pub fn next_u64(&mut self) -> u64 {
        self.0.next_u64()
    }

    /// `[0, n)`（n 很小，取模偏差可以忽略）。
    pub fn below(&mut self, n: u64) -> u64 {
        if n <= 1 {
            return 0;
        }
        self.next_u64() % n
    }

    /// `[a, b]` 闭区间。
    pub fn range(&mut self, a: i64, b: i64) -> i64 {
        a + self.below((b - a + 1) as u64) as i64
    }

    /// 千分比概率。
    pub fn chance(&mut self, per_mille: u64) -> bool {
        self.below(1000) < per_mille
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }

    /// 从字符串表里抽一个（返回 `'static`，避免 `&&str` 的类型推断问题）。
    pub fn pick_str(&mut self, items: &[&'static str]) -> &'static str {
        items[self.below(items.len() as u64) as usize]
    }

    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.below(i as u64 + 1) as usize;
            items.swap(i, j);
        }
    }

    pub fn digits(&mut self, n: usize) -> String {
        (0..n)
            .map(|_| char::from(b'0' + self.below(10) as u8))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_stream() {
        let seed = [7u8; 32];
        let a: Vec<u64> = (0..4)
            .map(|_| stream(&seed, "traveler", 3).next_u64())
            .collect();
        assert!(a.windows(2).all(|w| w[0] == w[1]));
        assert_ne!(
            stream(&seed, "traveler", 3).next_u64(),
            stream(&seed, "traveler", 4).next_u64()
        );
        assert_ne!(
            stream(&seed, "traveler", 3).next_u64(),
            stream(&seed, "wave", 3).next_u64()
        );
    }

    /// 已知答案：防止 rand_chacha / hmac 升级后悄悄改变序列（每日挑战全服一致）。
    #[test]
    fn known_answer() {
        let seed = [0u8; 32];
        let mut s = stream(&seed, "traveler", 0);
        let first = s.next_u64();
        let again = stream(&seed, "traveler", 0).next_u64();
        assert_eq!(first, again);
        assert_eq!(
            first, KNOWN_FIRST_U64,
            "generator stream changed: bump GENERATOR_VERSION"
        );
    }

    const KNOWN_FIRST_U64: u64 = 2724188356199951958;

    #[test]
    fn samplers_stay_in_range() {
        let mut s = stream(&[1u8; 32], "t", 0);
        for _ in 0..1000 {
            assert!(s.below(7) < 7);
            let r = s.range(-3, 3);
            assert!((-3..=3).contains(&r));
        }
        let mut items = [1, 2, 3, 4, 5];
        s.shuffle(&mut items);
        let mut sorted = items;
        sorted.sort();
        assert_eq!(sorted, [1, 2, 3, 4, 5]);
        assert_eq!(s.digits(4).len(), 4);
        assert_eq!(
            daily_seed(b"k", "2026-10-24"),
            daily_seed(b"k", "2026-10-24")
        );
        assert_ne!(
            daily_seed(b"k", "2026-10-24"),
            daily_seed(b"k", "2026-10-25")
        );
    }
}
