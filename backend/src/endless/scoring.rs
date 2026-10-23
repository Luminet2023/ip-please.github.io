//! 计分（全部整数，分数只增不减）。
//!
//! - 判对：基础 100；拒绝 / 拘留有破绽的旅客时，没指认也没测谎揭穿（纯猜）只有 60。
//! - 盖章前指认出真实破绽：+50（第一次指认成功前错了超过 3 次不算）。
//! - 拘留被测谎揭穿的说谎者：+50。
//! - 连对倍率（按本次判定前的连对数）：0–4 ×1，5–9 ×1.5，10–19 ×2，20+ ×3。
//! - 拘留通缉犯：另加 500（不乘倍率）。判错：0 分，连对清零，警告 +1。
//! - 黑话快剪：每张脸 20，全对再 +60；蒸馏大军：每个 15，全中再 +50。

use serde::Serialize;

use super::model::{Decision, Secret};

pub const BASE: i64 = 100;
pub const GUESS_BASE: i64 = 60;
pub const POINTING_BONUS: i64 = 50;
pub const EXPOSED_BONUS: i64 = 50;
pub const WANTED_BONUS: i64 = 500;
pub const POINTING_MAX_WRONG: u32 = 3;
pub const RUSH_HIT: i64 = 20;
pub const RUSH_PERFECT: i64 = 60;
pub const CLONE_HIT: i64 = 15;
pub const CLONE_PERFECT: i64 = 50;

/// 倍率（十分之一为单位）：10 = ×1.0。
pub fn multiplier_tenths(streak_before: u32) -> i64 {
    match streak_before {
        0..=4 => 10,
        5..=9 => 15,
        10..=19 => 20,
        _ => 30,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Breakdown {
    pub base: i64,
    pub pointing: i64,
    pub exposed: i64,
    pub wanted: i64,
    /// ×1.5 记作 1.5
    pub multiplier: f64,
    pub total: i64,
}

/// 玩家在这位旅客身上做了什么。
#[derive(Debug, Clone, Copy, Default)]
pub struct Evidence {
    pub found_issue: bool,
    pub wrong_before_first_find: u32,
    pub exposed: bool,
}

pub fn score(
    decision: Decision,
    secret: &Secret,
    evidence: Evidence,
    streak_before: u32,
) -> (bool, Breakdown) {
    let correct = secret.ok.contains(&decision);
    let mult = multiplier_tenths(streak_before);
    let zero = Breakdown {
        base: 0,
        pointing: 0,
        exposed: 0,
        wanted: 0,
        multiplier: mult as f64 / 10.0,
        total: 0,
    };
    if !correct {
        return (false, zero);
    }
    let flawed = !secret.ok.contains(&Decision::Approve);
    let (base, pointing, exposed) = if !flawed {
        (BASE, 0, 0)
    } else if evidence.found_issue || evidence.exposed {
        let pointing =
            if evidence.found_issue && evidence.wrong_before_first_find <= POINTING_MAX_WRONG {
                POINTING_BONUS
            } else {
                0
            };
        let exposed = if evidence.exposed && secret.liar && decision == Decision::Detain {
            EXPOSED_BONUS
        } else {
            0
        };
        (BASE, pointing, exposed)
    } else {
        (GUESS_BASE, 0, 0)
    };
    let wanted = if secret.wanted && decision == Decision::Detain {
        WANTED_BONUS
    } else {
        0
    };
    let total = (base + pointing + exposed) * mult / 10 + wanted;
    (
        true,
        Breakdown {
            base,
            pointing,
            exposed,
            wanted,
            multiplier: mult as f64 / 10.0,
            total,
        },
    )
}

pub fn rush_points(hits: usize, faces: usize) -> i64 {
    hits as i64 * RUSH_HIT + if hits == faces { RUSH_PERFECT } else { 0 }
}

pub fn clone_points(hits: usize, runners: usize) -> i64 {
    hits as i64 * CLONE_HIT + if hits == runners { CLONE_PERFECT } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(ok: &[Decision], liar: bool, wanted: bool) -> Secret {
        Secret {
            ok: ok.to_vec(),
            flaws: vec![],
            issues: vec![],
            tell: None,
            liar,
            fish: None,
            wanted,
            bulletin: false,
        }
    }

    const FLAWED: [Decision; 2] = [Decision::Deny, Decision::Detain];

    #[test]
    fn valid_traveler() {
        let s = secret(&[Decision::Approve], false, false);
        let (ok, b) = score(Decision::Approve, &s, Evidence::default(), 0);
        assert!(ok);
        assert_eq!(b.total, 100);
        let (ok, b) = score(Decision::Deny, &s, Evidence::default(), 7);
        assert!(!ok);
        assert_eq!(b.total, 0);
    }

    #[test]
    fn guessing_scores_less_than_pointing() {
        let s = secret(&FLAWED, true, false);
        let guess = score(Decision::Deny, &s, Evidence::default(), 0).1.total;
        let pointed = score(
            Decision::Deny,
            &s,
            Evidence {
                found_issue: true,
                ..Evidence::default()
            },
            0,
        )
        .1
        .total;
        assert_eq!(guess, 60);
        assert_eq!(pointed, 150);
        let sloppy = score(
            Decision::Deny,
            &s,
            Evidence {
                found_issue: true,
                wrong_before_first_find: 4,
                exposed: false,
            },
            0,
        )
        .1
        .total;
        assert_eq!(sloppy, 100, "too many wrong claims: no pointing bonus");
        let exposed = score(
            Decision::Detain,
            &s,
            Evidence {
                found_issue: true,
                wrong_before_first_find: 0,
                exposed: true,
            },
            0,
        )
        .1
        .total;
        assert_eq!(exposed, 200);
    }

    #[test]
    fn multiplier_tiers() {
        assert_eq!(multiplier_tenths(4), 10);
        assert_eq!(multiplier_tenths(5), 15);
        assert_eq!(multiplier_tenths(19), 20);
        assert_eq!(multiplier_tenths(20), 30);
        let s = secret(&[Decision::Approve], false, false);
        assert_eq!(
            score(Decision::Approve, &s, Evidence::default(), 5).1.total,
            150
        );
        assert_eq!(
            score(Decision::Approve, &s, Evidence::default(), 25)
                .1
                .total,
            300
        );
    }

    #[test]
    fn wanted_outcomes() {
        let s = secret(&FLAWED, false, true);
        let found = Evidence {
            found_issue: true,
            ..Evidence::default()
        };
        assert_eq!(
            score(Decision::Detain, &s, found, 10).1.total,
            150 * 2 + 500
        );
        let (ok, deny) = score(Decision::Deny, &s, found, 0);
        assert!(ok);
        assert_eq!(deny.wanted, 0);
        assert!(!score(Decision::Approve, &s, found, 0).0);
    }

    #[test]
    fn waves() {
        assert_eq!(rush_points(6, 6), 180);
        assert_eq!(rush_points(4, 6), 80);
        assert_eq!(clone_points(10, 10), 200);
        assert_eq!(clone_points(3, 10), 45);
    }
}
