use ip_please_sync::endless::{
    generator,
    state::{Mode, RunState},
};
#[test]
fn new_runs_use_v4_while_v1_and_v2_resume_unchanged() {
    let state = RunState::new(Mode::Daily, &[9; 32], Some("2026-11-08".into()));
    assert_eq!(
        state.generator_version, 4,
        "new games use backend policy v4 with client contract v3"
    );
    let mut old = serde_json::to_value(&state).unwrap();
    old["generator_version"] = 1.into();
    let mut old: RunState = serde_json::from_value(old).unwrap();
    old.next(0, &mut |_| "ent_test".into()).unwrap();
    let item = old.view_item().unwrap();
    assert_eq!(
        item["entrant"],
        serde_json::to_value(generator::traveler(&[9; 32], 0, "ent_test").public).unwrap()
    );
}
use ip_please_sync::endless::model::Decision;
use ip_please_sync::endless::state::Current;
use std::collections::{BTreeMap, BTreeSet};
fn generate(seed: u8, t: u32) -> ip_please_sync::endless::state::TravelerState {
    let mut s = RunState::new(Mode::Endless, &[seed; 32], None);
    s.generator_version = 2;
    s.generator_version = 2;
    s.slot = t + t / 8;
    s.next(0, &mut |_| "ent_test".into()).unwrap();
    match s.current.unwrap() {
        Current::Traveler(t) => t,
        _ => panic!(),
    }
}
#[test]
fn v2_all_nationalities_have_clean_and_flawed_documents_and_ai_cases() {
    let mut countries: BTreeMap<String, [u32; 2]> = BTreeMap::new();
    let mut cast: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
    let mut docs = BTreeSet::new();
    for seed in 0..12 {
        for t in 0..160 {
            let g = generate(seed, t);
            let public = serde_json::to_value(&g.public).unwrap();
            let cc = public["docs"][0]["cc"].as_str().unwrap().to_owned();
            let flawed = !g.secret.ok.contains(&Decision::Approve);
            if !g.public.person.ends_with("_AI") && g.public.person != "FISH" && !g.secret.wanted {
                countries.entry(cc).or_default()[flawed as usize] += 1;
            }
            if g.public.person.ends_with("_AI") {
                cast.entry(g.public.person.clone())
                    .or_default()
                    .insert(g.secret.flaws.len());
            }
            for doc in public["docs"].as_array().unwrap() {
                docs.insert(doc["type"].as_str().unwrap().to_owned());
            }
            if g.secret.wanted {
                assert_eq!(g.secret.ok, vec![Decision::Detain]);
            }
            if !flawed {
                assert!(g.secret.issues.is_empty());
            }
            for issue in &g.secret.issues {
                assert!(issue.kind == "tell" || !issue.pairs.is_empty());
            }
        }
    }
    for cc in ["US", "UK", "JP", "DE", "SG"] {
        let counts = countries.get(cc).unwrap();
        assert!(counts[0] > 5 && counts[1] > 5, "{cc}: {counts:?}");
    }
    assert!(docs.contains("entry_permit"));
    for name in [
        "GPT_AI",
        "QWEN_AI",
        "GROK_AI",
        "GLM_AI",
        "KIMI_AI",
        "GEMINI_AI",
    ] {
        let counts = cast.get(name).expect(name);
        assert!(
            counts.contains(&0) && counts.contains(&1) && counts.contains(&2),
            "{name}: {counts:?}"
        );
    }
}
#[test]
fn v2_exposes_fixed_shift_and_has_two_ai_per_sixteen_without_wanted_collisions() {
    let mut s = RunState::new(Mode::Endless, &[8; 32], None);
    s.generator_version = 2;
    assert_eq!(s.view_summary()["inspection_date"], "2026.10.25");
    for block in 0..8 {
        let mut ai = 0;
        for t in block * 16..block * 16 + 16 {
            let g = generate(8, t);
            if g.public.person.ends_with("_AI") {
                ai += 1;
                assert!(!g.secret.wanted);
            }
        }
        assert_eq!(ai, 2);
    }
}
#[test]
fn wanted_must_be_detained_and_citation_explains_that() {
    let mut s = RunState::new(Mode::Endless, &[8; 32], None);
    s.generator_version = 2;
    let t = generator::wanted_for(&[8; 32], 0).appear_at;
    s.slot = t + t / 8;
    s.next(0, &mut |_| "ent_test".into()).unwrap();
    let response = s.decide("ent_test", Decision::Deny, 2000).unwrap();
    assert_eq!(response["correct"], false);
    assert_eq!(response["citation"]["kind"], "denied_wanted");
}

#[test]
fn version_defaults_preserve_old_bulletins_waves_and_pending_items() {
    let mut old = serde_json::to_value(RunState::new(Mode::Endless, &[9; 32], None)).unwrap();
    for key in [
        "generator_version",
        "document_reviews",
        "model_identity_checks",
    ] {
        old.as_object_mut().unwrap().remove(key);
    }
    let mut s: RunState = serde_json::from_value(old).unwrap();
    assert_eq!(s.generator_version, 1);
    s.slot = 8;
    s.next(0, &mut |_| "wave_test".into()).unwrap();
    if let Some(Current::Wave(w)) = &s.current {
        assert_eq!(w.spec, generator::wave(&[9; 32], 0));
    } else {
        panic!()
    }
    let saved = serde_json::to_vec(&s).unwrap();
    let resumed: RunState = serde_json::from_slice(&saved).unwrap();
    assert_eq!(resumed.view_item(), s.view_item());
    for t in 0..80 {
        s.current = None;
        s.slot = t + t / 8;
        let expected = generator::bulletin_at(&[9; 32], t);
        let view = s.view_summary();
        assert_eq!(view["bulletin"].is_null(), expected.is_none());
        if let Some(b) = expected {
            assert_eq!(view["bulletin"]["kind"], b.kind);
            assert_eq!(view["bulletin"]["remaining"], b.remaining_at(t));
        }
    }
}

#[test]
fn v2_actual_document_facts_support_every_new_issue_and_evidence_is_inspectable() {
    use ip_please_sync::endless::generator_v2::{CAST, REGISTRY};
    use ip_please_sync::endless::model::{is_known_field, Doc};
    use ip_please_sync::endless::state::Claim;
    let mut seen = BTreeSet::new();
    let mut cases: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for seed in 0..16 {
        for t in 0..160 {
            let g = generate(seed, t);
            let serialized = serde_json::to_value(&g.public).unwrap();
            for forbidden in [
                "ok", "flaws", "liar", "case", "variant", "wanted", "bulletin",
            ] {
                assert!(
                    serialized.get(forbidden).is_none(),
                    "public answer leak {forbidden}"
                );
            }
            let Doc::Passport {
                cc,
                iss,
                exp,
                surname,
                given,
                ..
            } = &g.public.docs[0]
            else {
                panic!()
            };
            let permit = g
                .public
                .docs
                .iter()
                .find(|d| matches!(d, Doc::EntryPermit { .. }));
            let mut s = RunState::new(Mode::Endless, &[seed; 32], None);
            s.generator_version = 2;
            s.current = Some(Current::Traveler(g.clone()));
            for issue in &g.secret.issues {
                seen.insert(issue.kind.clone());
                if CAST.contains(&g.public.person.as_str()) && issue.kind != "bulletin" {
                    cases
                        .entry(g.public.person.clone())
                        .or_default()
                        .insert(issue.kind.clone());
                }
                match issue.kind.as_str() {
                    "passport_expired" => assert!(exp.as_str() < "2026.10.25"),
                    "issuing_country" => assert!(!ip_please_sync::endless::tables::country(cc)
                        .cities
                        .iter()
                        .any(|c| c.en == iss)),
                    "permit_expired" => {
                        let Some(Doc::EntryPermit { exp, .. }) = permit else {
                            panic!()
                        };
                        assert!(exp.as_str() < "2026.10.25");
                    }
                    "permit_holder" => {
                        let Some(Doc::EntryPermit { holder, .. }) = permit else {
                            panic!()
                        };
                        assert_ne!(*holder, format!("{surname}, {given}"));
                    }
                    "model_registry" => {
                        let d = g
                            .public
                            .docs
                            .iter()
                            .find(|d| matches!(d, Doc::ModelPermit { .. }))
                            .unwrap();
                        let Doc::ModelPermit {
                            claim,
                            model_id,
                            org,
                            ..
                        } = d
                        else {
                            panic!()
                        };
                        assert!(!REGISTRY
                            .iter()
                            .any(|(c, m, o)| c == claim && m == model_id && o == org));
                    }
                    "tz" if cc == "SG" => {
                        let d = g
                            .public
                            .docs
                            .iter()
                            .find(|d| matches!(d, Doc::Device { .. }))
                            .unwrap();
                        let Doc::Device { tz, .. } = d else { panic!() };
                        assert!(!["Asia/Shanghai", "Asia/Singapore"].contains(&tz.as_str()));
                    }
                    "billing_region" => {
                        let bill = &issue.args["bill"];
                        assert_ne!(
                            bill.rsplit(", ").next().unwrap(),
                            ip_please_sync::endless::tables::country(cc)
                                .cities
                                .iter()
                                .find(|c| c.en == iss)
                                .map(|c| c.st)
                                .unwrap_or("")
                        );
                    }
                    _ => {}
                }
                for pair in &issue.pairs {
                    assert!(pair.iter().all(|f| is_known_field(f)));
                    assert_eq!(
                        s.inspect("ent_test", Claim::Fields(pair.clone())).unwrap()["match"],
                        true,
                        "{pair:?}"
                    );
                }
            }
            if g.secret.ok.contains(&Decision::Approve) {
                assert!(exp.as_str() >= "2026.10.25");
                assert!(ip_please_sync::endless::tables::country(cc)
                    .cities
                    .iter()
                    .any(|c| c.en == iss));
            }
        }
    }
    for kind in [
        "passport_expired",
        "issuing_country",
        "permit_expired",
        "permit_holder",
        "model_registry",
        "billing_region",
    ] {
        assert!(seen.contains(kind), "{kind} never generated");
    }
    for name in CAST {
        assert!(cases[name].len() >= 3, "{name}: {:?}", cases[name]);
    }
}

#[test]
fn v2_daily_generation_is_order_independent_and_has_a_golden() {
    use ip_please_sync::endless::{generator_v2 as v2, rng::daily_seed};
    use sha2::{Digest, Sha256};
    let seed = daily_seed(b"test-only-daily-seed", "2026-11-08");
    let mut hash = Sha256::new();
    for t in 0..96 {
        let a = v2::traveler(&seed, t, "ent_golden");
        let _ = v2::traveler(&seed, 200 - t, "other_id");
        let b = v2::traveler(&seed, t, "ent_golden");
        assert_eq!(a.public, b.public);
        assert_eq!(a.secret, b.secret);
        hash.update(serde_json::to_vec(&a.public).unwrap());
        hash.update(serde_json::to_vec(&a.secret).unwrap());
        hash.update(serde_json::to_vec(&v2::bulletin_at(&seed, t)).unwrap());
    }
    for w in 0..12 {
        hash.update(serde_json::to_vec(&v2::wave(&seed, w)).unwrap());
    }
    for b in 0..3 {
        hash.update(serde_json::to_vec(&v2::wanted_for(&seed, b)).unwrap());
    }
    assert_eq!(
        hex::encode(hash.finalize()),
        "a0d1cacc843edcb57202fbcf9d1446d15ef333f62bb5cf9c37733330b9eba94a"
    );
}

#[test]
fn classification_counters_advance_once_per_decision_including_retry() {
    let model = (0..80)
        .map(|t| generate(19, t))
        .find(|t| t.public.person.ends_with("_AI"))
        .unwrap();
    let mut s = RunState::new(Mode::Endless, &[19; 32], None);
    s.generator_version = 2;
    let decision = model.secret.ok[0];
    s.current = Some(Current::Traveler(model));
    let first = s.decide("ent_test", decision, 2000).unwrap();
    assert_eq!(s.document_reviews, 1);
    assert_eq!(s.model_identity_checks, 1);
    assert_eq!(first, s.decide("ent_test", decision, 4000).unwrap());
    assert_eq!(s.document_reviews, 1);
    assert_eq!(s.model_identity_checks, 1);
}

#[test]
fn start_version_negotiation_rejects_missing_old_and_future_versions() {
    use ip_please_sync::endless::routes::StartRequest;
    for value in [
        serde_json::json!({"mode":"daily"}),
        serde_json::json!({"mode":"daily","client_rules_version":1}),
        serde_json::json!({"mode":"daily","client_rules_version":2}),
        serde_json::json!({"mode":"daily","client_rules_version":4}),
    ] {
        assert!(serde_json::from_value::<StartRequest>(value)
            .unwrap()
            .validate_rules()
            .is_err());
    }
    assert!(serde_json::from_value::<StartRequest>(
        serde_json::json!({"mode":"daily","client_rules_version":3})
    )
    .unwrap()
    .validate_rules()
    .is_ok());
}
