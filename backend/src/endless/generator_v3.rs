//! Progressive policy. Shared constructors retain frozen v1/v2 RNG behaviour.
use super::{
    generator::{self, Bulletin, Generated, Slot, Wanted, WaveSpec},
    generator_v2,
    rng::Seed,
};
use serde_json::{json, Value};
pub const GENERATOR_VERSION: i32 = 3;
pub const GROUPS: [&[&str]; 8] = [
    &["region", "photo"],
    &["tz"],
    &["pay"],
    &["quiz", "xray"],
    &["date", "issuing"],
    &["model", "registry", "corp"],
    &["permit"],
    &["net", "wanted", "bulletin"],
];
pub fn progression(t: u32) -> Value {
    let stage = (t / 5).min(7) as usize;
    json!({"stage":stage,"completed_travelers":t,"active_rules":GROUPS[..=stage].concat(),
        "new_rules":GROUPS[stage],"next_unlock_at":if stage<7 {Some((stage+1)*5)} else {None},
        "next_rules":if stage<7 {GROUPS[stage+1]} else {&[]},"waves_unlocked":t>=15})
}
pub fn slot(k: u32) -> Slot {
    if k < 15 {
        return Slot::Traveler(k);
    }
    match generator::slot(k - 15) {
        Slot::Traveler(t) => Slot::Traveler(t + 15),
        Slot::Wave(w) => Slot::Wave(w),
    }
}
pub fn travelers_issued(k: u32) -> u32 {
    if k <= 15 {
        k
    } else {
        k - (k - 15) / 9
    }
}
pub fn flaw_unlocked(f: &str, t: u32) -> bool {
    t >= match f {
        "cnip" | "photo" => 0,
        "tz" | "lang" => 5,
        "virtual" | "oregon" | "sms" => 10,
        "hidden" | "cat" | "keys" => 15,
        "passport_expired" | "issuing_country" => 20,
        "model_identity" => 25,
        "permit_holder" | "permit_expired" => 30,
        "hosting" | "logins" => 35,
        _ => u32::MAX,
    }
}
pub fn wanted_for(seed: &Seed, t: u32) -> Wanted {
    let mut w = generator_v2::wanted_for(seed, t.saturating_sub(35) / 40);
    w.appear_at += 35;
    w
}
pub fn bulletin_at(seed: &Seed, t: u32) -> Option<Bulletin> {
    if t < 35 {
        return None;
    }
    let mut b = generator_v2::bulletin_at(seed, t - 25)?;
    b.start += 25;
    Some(b)
}
pub fn traveler(seed: &Seed, t: u32, id: &str) -> Generated {
    generator_v2::traveler_policy(seed, t, id, true)
}

/// V3 keeps established wave content and server timing; only its slot schedule changes.
pub fn wave(seed: &Seed, w: u32) -> WaveSpec {
    generator_v2::wave(seed, w)
}
