//! Basic quiz/detention and ordinary early AI visitors, using the existing v3 client contract.
//! Persisted v1-v3 runs retain their original policies; no frontend update is required.
use super::{
    generator::{Bulletin, Generated, Slot, Wanted, WaveSpec},
    generator_v2, generator_v3,
    rng::Seed,
};
use serde_json::{json, Value};

pub const GENERATOR_VERSION: i32 = 4;
pub const CLIENT_RULES_VERSION: u32 = 3;
const CHAPTERS: [(u32, &[&str]); 7] = [
    (0, &["region", "photo", "quiz"]),
    (5, &["tz"]),
    (9, &["xray"]),
    (10, &["pay"]),
    (20, &["date", "issuing"]),
    (30, &["permit"]),
    (35, &["net", "wanted", "bulletin"]),
];

pub fn progression(t: u32) -> Value {
    let stage = CHAPTERS.iter().rposition(|(at, _)| t >= *at).unwrap_or(0);
    let active: Vec<&str> = CHAPTERS[..=stage]
        .iter()
        .flat_map(|(_, keys)| keys.iter().copied())
        .collect();
    let next = CHAPTERS.get(stage + 1);
    json!({"stage":stage,"completed_travelers":t,"active_rules":active,
        "new_rules":CHAPTERS[stage].1,"next_unlock_at":next.map(|(at,_)|at),
        "next_rules":next.map(|(_,keys)|*keys).unwrap_or(&[]),"waves_unlocked":t>=15,
        "capabilities":{"quiz":true,"detain":true,"xray":t>=9}})
}

pub fn flaw_unlocked(flaw: &str, t: u32) -> bool {
    match flaw {
        "hidden" => true,
        "cat" | "keys" => t >= 9,
        "model_identity" => false,
        _ => generator_v3::flaw_unlocked(flaw, t),
    }
}

pub fn rule_unlocked(rule: &str, t: u32) -> bool {
    CHAPTERS
        .iter()
        .any(|(at, rules)| t >= *at && rules.contains(&rule))
}

pub fn traveler(seed: &Seed, t: u32, id: &str) -> Generated {
    generator_v2::traveler_policy_version(seed, t, id, GENERATOR_VERSION)
}
pub fn slot(k: u32) -> Slot {
    generator_v3::slot(k)
}
pub fn travelers_issued(k: u32) -> u32 {
    generator_v3::travelers_issued(k)
}
pub fn wanted_for(seed: &Seed, t: u32) -> Wanted {
    generator_v3::wanted_for(seed, t)
}
pub fn bulletin_at(seed: &Seed, t: u32) -> Option<Bulletin> {
    generator_v3::bulletin_at(seed, t)
}
pub fn wave(seed: &Seed, w: u32) -> WaveSpec {
    generator_v3::wave(seed, w)
}
