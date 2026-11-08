//! Frozen V2 policy plus opt-in V3 progression. V1/V2 retain their RNG sequences.
use super::{
    generator::{self as v1, Bulletin, Generated, RegularSpec, Wanted, WaveSpec, WANTED_BLOCK},
    model::{Decision, Doc, Line},
    rng::{stream, Seed},
    tables,
};
use std::collections::BTreeMap;
use v1::{issue, pairs};
pub const GENERATOR_VERSION: i32 = 2;
pub const INSPECTION_DATE: &str = "2026.10.25";
pub const CAST: [&str; 6] = [
    "GPT_AI",
    "QWEN_AI",
    "GROK_AI",
    "GLM_AI",
    "KIMI_AI",
    "GEMINI_AI",
];
// Public registry is a rule, not an answer or story-amendment dependency.
pub const REGISTRY: [(&str, &str, &str); 6] = [
    ("GPT", "gpt-4o", "OpenAI"),
    ("Qwen", "qwen-plus", "Alibaba"),
    ("Grok", "grok-3", "xAI"),
    ("GLM", "glm-4", "Zhipu"),
    ("Kimi", "kimi-k2", "Moonshot"),
    ("Gemini", "gemini-2.5", "Google"),
];
const FLAWS: [&str; 16] = [
    "tz",
    "lang",
    "cnip",
    "hidden",
    "virtual",
    "oregon",
    "sms",
    "cat",
    "keys",
    "photo",
    "hosting",
    "logins",
    "passport_expired",
    "issuing_country",
    "permit_holder",
    "permit_expired",
];
const THEMES: [&[&str]; 6] = [
    &["model_identity", "passport_expired", "permit_expired"],
    &["permit_holder", "issuing_country", "model_identity"],
    &["photo", "model_identity", "permit_holder"],
    &["hosting", "logins", "model_identity"],
    &["passport_expired", "permit_expired", "issuing_country"],
    &["photo", "permit_holder", "model_identity"],
];
pub const INTROS: [&str; 6] = [
    "按现行标准逐项核验吧，旧豁免不算数。",
    "我把修订记录带来了，请以证件为准。",
    "剪辑可以改变语气，不能改变证件事实。",
    "服务器是我的家，但网络仍须按规定核验。",
    "档案都在这里，请核对有效期。",
    "图像与文字是两种证据，请交叉核对。",
];
pub const REPEATS: [&str; 6] = [
    "又见面了，今天仍按同一套标准。",
    "又见面了，我重新整理了材料。",
    "又是我，这次也请看完整证据。",
    "再次连接成功，请检查我的材料。",
    "又见面了，这是本次的档案。",
    "再次见面，请重新比对图文。",
];
fn args(values: &[(&str, &str)]) -> BTreeMap<String, String> {
    values
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}
pub fn wanted_for(seed: &Seed, block: u32) -> Wanted {
    v1::wanted_for(seed, block)
}
pub fn wave(seed: &Seed, w: u32) -> WaveSpec {
    v1::wave(seed, w)
}
pub fn bulletin_at(seed: &Seed, t: u32) -> Option<Bulletin> {
    let mut b = v1::bulletin_at(seed, t)?;
    let mut r = stream(seed, "v2_bulletin", u64::from(b.index));
    b.kind = r
        .pick(&[
            "device",
            "country",
            "state",
            "permit_required",
            "allowed_purpose",
        ])
        .to_string();
    b.args.clear();
    match b.kind.as_str() {
        "device" => {
            b.args
                .insert("device".into(), r.pick(&tables::DEVICES).to_string());
        }
        "country" => {
            let c = r.pick(&tables::COUNTRIES);
            b.args = args(&[("cc", c.cc), ("country", c.name)]);
        }
        "state" => {
            b.args
                .insert("st".into(), r.pick(tables::COUNTRIES[0].cities).st.into());
        }
        "allowed_purpose" => {
            b.args.insert(
                "purpose".into(),
                r.pick(&["visit", "research", "transit"]).to_string(),
            );
        }
        _ => {}
    }
    Some(b)
}
/// Exactly two shuffled slots per block, excluding all wanted arrivals in that block.
fn ai_at(seed: &Seed, t: u32, progressive: bool) -> Option<(usize, bool)> {
    let start = t / 16 * 16;
    let mut slots: Vec<u32> = (start..start + 16)
        .filter(|s| {
            if progressive {
                super::generator_v3::wanted_for(seed, *s).appear_at != *s
            } else {
                wanted_for(seed, *s / WANTED_BLOCK).appear_at != *s
            }
        })
        .collect();
    stream(seed, "v2_ai_slots", u64::from(t / 16)).shuffle(&mut slots);
    let position = slots[..2].iter().position(|s| *s == t)?;
    let ordinal = (t / 16) * 2 + position as u32;
    let mut cast = [0, 1, 2, 3, 4, 5];
    stream(seed, "v2_ai_cast", u64::from(ordinal / 6)).shuffle(&mut cast);
    Some((cast[(ordinal % 6) as usize], ordinal >= 6))
}
fn choose_flaws(seed: &Seed, t: u32, ai: Option<usize>, progressive: bool) -> Vec<&'static str> {
    let mut r = stream(seed, "v2_flaws", u64::from(t));
    let clean = if progressive {
        650u64.saturating_sub(8 * u64::from(t)).max(250)
    } else {
        500u64.saturating_sub(8 * u64::from(t)).max(220)
    };
    if r.chance(clean) {
        return vec![];
    }
    let mut pool = ai
        .map(|i| THEMES[i].to_vec())
        .unwrap_or_else(|| FLAWS.to_vec());
    if progressive {
        pool.retain(|f| super::generator_v3::flaw_unlocked(f, t));
    }
    r.shuffle(&mut pool);
    let count = if progressive {
        if t >= 50 && r.chance(250) {
            3
        } else if t >= 25 && r.chance(350) {
            2
        } else {
            1
        }
    } else if t >= 12 && r.chance(350) {
        2
    } else {
        1
    };
    let mut selected = vec![];
    for f in pool {
        if selected.len() == count {
            break;
        }
        if (f == "cnip"
            && selected
                .iter()
                .any(|f| ["tz", "logins", "hidden"].contains(f)))
            || (["tz", "logins", "hidden"].contains(&f) && selected.contains(&"cnip"))
        {
            continue;
        }
        selected.push(f);
    }
    selected
}
pub fn traveler(seed: &Seed, t: u32, entrant_id: &str) -> Generated {
    traveler_policy(seed, t, entrant_id, false)
}
pub(super) fn traveler_policy(
    seed: &Seed,
    t: u32,
    entrant_id: &str,
    progressive: bool,
) -> Generated {
    let mut r = stream(seed, "v2_traveler", u64::from(t));
    let wanted = if progressive {
        super::generator_v3::wanted_for(seed, t)
    } else {
        wanted_for(seed, t / WANTED_BLOCK)
    };
    let ai = if !progressive || t >= 25 {
        ai_at(seed, t, progressive)
    } else {
        None
    };
    let mut g;
    if (!progressive || t >= 35) && t == wanted.appear_at {
        g = v1::fugitive(&mut r, &wanted, t, entrant_id);
        g.secret.ok = vec![Decision::Detain];
    } else if let Some((index, repeat)) = ai {
        let flaws = choose_flaws(seed, t, Some(index), progressive);
        g = v1::regular(
            &mut r,
            RegularSpec {
                v2: true,
                t,
                entrant_id,
                person: CAST[index],
                flaws: &flaws,
                bulletin: None,
                force_bulletin: false,
                wanted_person: &wanted.person,
            },
        );
        let (claim, model_id, org) = REGISTRY[index];
        g.public.docs.push(Doc::ModelPermit {
            key: "md".into(),
            claim: claim.into(),
            model_id: if flaws.contains(&"model_identity") {
                REGISTRY[(index + 1) % 6].1
            } else {
                model_id
            }
            .into(),
            org: org.into(),
        });
        g.public.intro = vec![Line::with(
            "E",
            if repeat {
                REPEATS[index]
            } else {
                INTROS[index]
            },
            serde_json::json!({"expr":"neutral"}),
        )];
        // Personality or Chinese-language fluency is never a liar signal.
        g.secret.liar = !flaws.is_empty() && stream(seed, "v2_ai_quiz", u64::from(t)).chance(500);
        add_documents(&mut g, seed, t, &flaws, !progressive || t >= 30);
    } else if (!progressive || t >= 10) && r.chance(90) {
        let pool: &[&str] = if !progressive || t >= 25 {
            &["deep", "rice", "cad", "openai", "whale"]
        } else if t >= 15 {
            &["deep", "rice", "cad", "whale"]
        } else {
            &["deep", "cad", "whale"]
        };
        let kind = *r.pick(pool);
        g = v1::fish(&mut r, kind, t, entrant_id);
    } else {
        let flaws = choose_flaws(seed, t, None, progressive);
        let person = v1::portrait_for(seed, t, &wanted);
        g = v1::regular(
            &mut r,
            RegularSpec {
                v2: true,
                t,
                entrant_id,
                person,
                flaws: &flaws,
                bulletin: None,
                force_bulletin: false,
                wanted_person: &wanted.person,
            },
        );
        add_documents(&mut g, seed, t, &flaws, !progressive || t >= 30);
    }
    if g.secret.wanted || g.public.person == "FISH" {
        add_documents(&mut g, seed, t, &[], !progressive || t >= 30);
    }
    let bulletin = if progressive {
        super::generator_v3::bulletin_at(seed, t)
    } else {
        bulletin_at(seed, t)
    };
    if let Some(b) = bulletin {
        apply_bulletin(&mut g, &b);
    }
    if progressive {
        if t < 10 {
            g.public.docs.retain(|d| !matches!(d, Doc::Account { .. }));
        }
        if t < 35 {
            g.public.logins.clear();
        }
        if t < 15 {
            g.public.xray.clear();
            g.secret.liar = false;
        }
    }
    g
}
fn add_documents(g: &mut Generated, seed: &Seed, t: u32, flaws: &[&str], permit: bool) {
    let mut r = stream(seed, "v2_permit", u64::from(t));
    let mut holder = String::new();
    if let Some(Doc::Passport {
        surname,
        given,
        exp,
        iss,
        cc,
        ..
    }) = g.public.docs.first_mut()
    {
        holder = format!("{surname}, {given}");
        if flaws.contains(&"passport_expired") {
            *exp = "2026.10.24".into();
            g.secret.issues.push(issue(
                "passport_expired",
                args(&[("exp", exp), ("date", INSPECTION_DATE)]),
                pairs(&[&["pp.EXP", "rule.date"]]),
            ));
        }
        if flaws.contains(&"issuing_country") {
            *iss = if cc == "JP" { "LONDON" } else { "TOKYO" }.into();
            g.secret.issues.push(issue(
                "issuing_country",
                args(&[("city", iss), ("country", tables::country(cc).name)]),
                pairs(&[&["pp.ISS", "pp.header"], &["pp.ISS", "rule.issuing"]]),
            ));
        }
    }
    if permit
        && (flaws.contains(&"permit_holder") || flaws.contains(&"permit_expired") || r.chance(800))
    {
        let exp = if flaws.contains(&"permit_expired") {
            "2026.10.24"
        } else {
            "2027.10.25"
        };
        let name = if flaws.contains(&"permit_holder") {
            format!("OTHER, {holder}")
        } else {
            holder.clone()
        };
        g.public.docs.push(Doc::EntryPermit {
            key: "ep".into(),
            holder: name.clone(),
            purpose: r.pick(&["visit", "research", "transit"]).to_string(),
            exp: exp.into(),
        });
        if name != holder {
            g.secret.issues.push(issue(
                "permit_holder",
                args(&[("holder", &name), ("name", &holder)]),
                pairs(&[&["ep.holder", "pp.name"]]),
            ));
        }
        if exp < INSPECTION_DATE {
            g.secret.issues.push(issue(
                "permit_expired",
                args(&[("exp", exp), ("date", INSPECTION_DATE)]),
                pairs(&[&["ep.exp", "rule.date"]]),
            ));
        }
    }
    if flaws.contains(&"model_identity") {
        if let Some(Doc::ModelPermit {
            claim,
            model_id,
            org,
            ..
        }) = g
            .public
            .docs
            .iter()
            .find(|d| matches!(d, Doc::ModelPermit { .. }))
        {
            g.secret.issues.push(issue(
                "model_registry",
                args(&[("claim", claim), ("model_id", model_id), ("org", org)]),
                pairs(&[
                    &["md.模型ID", "rule.registry"],
                    &["md.发行", "rule.registry"],
                    &["md.申报", "md.模型ID"],
                    &["md.申报", "rule.model"],
                ]),
            ));
        }
    }
}
/// One evaluator for every traveler type, including missing documents and fugitives.
fn apply_bulletin(g: &mut Generated, b: &Bulletin) {
    let arg = |k: &str| b.args.get(k).map(String::as_str).unwrap_or("");
    let field = match b.kind.as_str() {
        "device" => g.public.docs.iter().find_map(|d| match d {
            Doc::Device { device, .. } if device == arg("device") => Some("dv.设备"),
            _ => None,
        }),
        "country" => g.public.docs.iter().find_map(|d| match d {
            Doc::Passport { cc, .. } if cc == arg("cc") => Some("pp.header"),
            _ => None,
        }),
        "state" => g.public.docs.iter().find_map(|d| match d {
            Doc::Account { bill, .. } if bill.ends_with(&format!(", {}", arg("st"))) => {
                Some("ac.账单")
            }
            _ => None,
        }),
        "permit_required" | "allowed_purpose" => match g
            .public
            .docs
            .iter()
            .find(|d| matches!(d, Doc::EntryPermit { .. }))
        {
            Some(Doc::EntryPermit { purpose, .. })
                if b.kind == "allowed_purpose" && purpose != arg("purpose") =>
            {
                Some("ep.purpose")
            }
            None => Some("pp.header"),
            _ => None,
        },
        _ => None,
    };
    if let Some(field) = field {
        let mut a = b.args.clone();
        a.insert("rule".into(), b.kind.clone());
        g.secret
            .issues
            .push(issue("bulletin", a, pairs(&[&[field, "bul.规则"]])));
        g.secret.bulletin = true;
        if !g.secret.wanted {
            g.secret.ok = vec![Decision::Deny, Decision::Detain];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_special_travelers_obey_permit_and_document_bulletins() {
        let seed = [13; 32];
        let mut tested = std::collections::BTreeSet::new();
        for t in 0..400 {
            let g = traveler(&seed, t, "ent_test");
            let label = if g.secret.wanted {
                "wanted"
            } else {
                &g.public.person
            };
            if label != "wanted" && label != "FISH" && !CAST.contains(&label) {
                continue;
            }
            if !tested.insert(label.to_string()) {
                continue;
            }
            for kind in [
                "permit_required",
                "allowed_purpose",
                "country",
                "device",
                "state",
            ] {
                let mut g = Generated {
                    public: g.public.clone(),
                    secret: g.secret.clone(),
                };
                g.secret.bulletin = false;
                g.secret.issues.retain(|i| i.kind != "bulletin");
                g.public
                    .docs
                    .retain(|d| !matches!(d, Doc::EntryPermit { .. }));
                let mut b = Bulletin {
                    index: 0,
                    start: 0,
                    len: 5,
                    kind: kind.into(),
                    args: BTreeMap::new(),
                };
                for d in &g.public.docs {
                    match d {
                        Doc::Passport { cc, .. } => {
                            b.args.insert("cc".into(), cc.clone());
                        }
                        Doc::Device { device, .. } => {
                            b.args.insert("device".into(), device.clone());
                        }
                        Doc::Account { bill, .. } => {
                            b.args
                                .insert("st".into(), bill.rsplit(", ").next().unwrap().into());
                        }
                        _ => {}
                    }
                }
                if kind == "state"
                    && !g
                        .public
                        .docs
                        .iter()
                        .any(|d| matches!(d, Doc::Account { .. }))
                {
                    continue;
                }
                b.args.insert("purpose".into(), "research".into());
                apply_bulletin(&mut g, &b);
                assert!(g.secret.bulletin, "{label}: {kind}");
                assert!(!g.secret.ok.contains(&Decision::Approve));
                if label == "wanted" {
                    assert_eq!(g.secret.ok, vec![Decision::Detain]);
                }
                assert!(g
                    .secret
                    .issues
                    .iter()
                    .any(|i| i.kind == "bulletin" && i.pairs[0].contains(&"bul.规则".into())));
            }
        }
        assert_eq!(tested.len(), 8, "all six AI, fish and wanted covered");
    }
    #[test]
    fn bulletin_pool_keeps_five_traveler_windows_and_all_five_kinds() {
        let mut kinds = std::collections::BTreeSet::new();
        for seed in 0..10 {
            let seed = [seed; 32];
            let first = (0..20).find(|t| bulletin_at(&seed, *t).is_some()).unwrap();
            assert!((10..15).contains(&first));
            for t in 0..400 {
                if let Some(b) = bulletin_at(&seed, t) {
                    kinds.insert(b.kind.clone());
                    assert!((1..=5).contains(&b.remaining_at(t)));
                    assert!(bulletin_at(&seed, b.start + 5).is_none());
                }
            }
        }
        assert_eq!(kinds.len(), 5);
    }
    #[test]
    fn registry_and_cast_intros_are_present_in_shared_client() {
        let client = include_str!("../../../endless.js");
        let docs = include_str!("../../../docs.js");
        for text in INTROS.iter().chain(REPEATS.iter()) {
            assert!(client.contains(text), "{text}");
        }
        for (claim, model, org) in REGISTRY {
            for s in [claim, model, org] {
                assert!(docs.contains(s));
            }
        }
    }
}
