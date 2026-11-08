use ip_please_sync::endless::{
    generator_v2::CAST,
    model::{Decision, Doc},
    state::{Claim, Current, Mode, RunState},
};

fn at(t: u32) -> RunState {
    let mut run = RunState::new(Mode::Endless, &[11; 32], None);
    run.slot = t;
    run.travelers = t;
    run.next(0, &mut |_| "ent_fixture".into()).unwrap();
    run
}

#[test]
fn quiz_and_detention_are_basic_tools_and_xray_opens_on_tenth() {
    for (t, xray) in [(0, false), (3, false), (4, false), (8, false), (9, true)] {
        let mut run = at(t);
        let view = run.view_summary();
        let rules = view["progression"]["active_rules"].as_array().unwrap();
        assert!(
            rules.contains(&serde_json::json!("quiz")),
            "quiz locked at traveler {}",
            t + 1
        );
        assert_eq!(rules.contains(&serde_json::json!("xray")), xray);
        assert_eq!(view["progression"]["capabilities"]["detain"], true);
        let Current::Traveler(ref mut traveler) = run.current.as_mut().unwrap() else {
            panic!()
        };
        traveler.found.push(0);
        assert!(run.quiz("ent_fixture").is_ok());
        assert!(run.decide("ent_fixture", Decision::Detain, 2000).is_ok());
    }
}

#[test]
fn all_v4_ai_use_published_ordinary_evidence_without_model_papers_or_rules() {
    use ip_please_sync::endless::generator_v4 as v4;
    for seed in 0..24 {
        for t in 0..100 {
            let g = v4::traveler(&[seed; 32], t, "ent_fixture");
            let view = v4::progression(t);
            let rules = view["active_rules"].as_array().unwrap();
            assert!(!g
                .public
                .docs
                .iter()
                .any(|d| matches!(d, Doc::ModelPermit { .. })));
            for key in ["model", "registry", "corp"] {
                assert!(!rules.contains(&serde_json::json!(key)));
            }
            for issue in &g.secret.issues {
                assert!(!["model_identity", "model_registry"].contains(&issue.kind.as_str()));
                for pair in &issue.pairs {
                    for field in pair {
                        if let Some(rule) = field.strip_prefix("rule.") {
                            assert!(
                                rules.contains(&serde_json::json!(rule)),
                                "{} at {t}",
                                issue.kind
                            );
                        }
                    }
                    let mut run = RunState::new(Mode::Endless, &[seed; 32], None);
                    run.current = Some(Current::Traveler(
                        ip_please_sync::endless::state::TravelerState {
                            entrant_id: "ent_fixture".into(),
                            t,
                            issued_at_ms: 0,
                            public: g.public.clone(),
                            secret: g.secret.clone(),
                            found: vec![],
                            wrong_claims: 0,
                            wrong_before_first_find: 0,
                            quiz: None,
                        },
                    ));
                    assert_eq!(
                        run.inspect("ent_fixture", Claim::Fields(pair.clone()))
                            .unwrap()["match"],
                        true
                    );
                }
            }
        }
    }
}

#[test]
fn early_ai_share_ordinary_documents_and_never_add_model_constitution_rules() {
    let mut seen = std::collections::BTreeSet::new();
    let mut clean = false;
    let mut flawed = false;
    for seed in 0..48 {
        let mut run = RunState::new(Mode::Endless, &[seed; 32], None);
        for t in 0..16 {
            if run.current.is_none() {
                run.next(i64::from(t) * 10000, &mut |_| "ent_fixture".into())
                    .unwrap();
            }
            let Current::Traveler(ref traveler) = run.current.as_ref().unwrap() else {
                panic!("early wave")
            };
            let rules = run.view_summary()["progression"]["active_rules"]
                .as_array()
                .unwrap()
                .clone();
            for key in ["model", "registry", "corp"] {
                assert!(!rules.contains(&serde_json::json!(key)));
            }
            if CAST.contains(&traveler.public.person.as_str()) {
                seen.insert(traveler.public.person.clone());
                assert!(!traveler
                    .public
                    .docs
                    .iter()
                    .any(|d| matches!(d, Doc::ModelPermit { .. } | Doc::EntryPermit { .. })));
                if t < 10 {
                    assert!(traveler
                        .public
                        .docs
                        .iter()
                        .all(|d| matches!(d, Doc::Passport { .. } | Doc::Device { .. })));
                }
                clean |= traveler.secret.ok.contains(&Decision::Approve);
                flawed |= !traveler.secret.ok.contains(&Decision::Approve);
            }
            let answer = traveler
                .secret
                .ok
                .iter()
                .copied()
                .find(|d| t >= 4 || *d != Decision::Detain)
                .unwrap();
            run.decide("ent_fixture", answer, i64::from(t) * 10000 + 2000)
                .unwrap();
        }
    }
    assert_eq!(
        seen.len(),
        CAST.len(),
        "all six AI can appear in the opening segment"
    );
    assert!(
        clean && flawed,
        "early AI identity must not reveal the answer"
    );
}

#[test]
fn v4_daily_finishes_forty_and_has_a_stable_generator_fingerprint() {
    use ip_please_sync::endless::{generator::WaveSpec, generator_v4 as v4};
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for t in 0..120 {
        let g = v4::traveler(&[13; 32], t, "ent_fixture");
        hash.update(serde_json::to_vec(&(&g.public, &g.secret)).unwrap());
    }
    let digest = hex::encode(hash.finalize());
    let mut run = RunState::new(Mode::Daily, &[13; 32], Some("2026-11-09".into()));
    let mut now = 0;
    while !run.ended() {
        run.next(now, &mut |prefix| format!("{prefix}_fixture"))
            .unwrap();
        now += 100_000;
        match run.current.clone().unwrap() {
            Current::Traveler(tr) => {
                run.decide(&tr.entrant_id, tr.secret.ok[0], now).unwrap();
            }
            Current::Wave(w) => {
                let before = run.travelers;
                let payload = match w.spec {
                    WaveSpec::Rush { faces } => {
                        serde_json::json!({"picks":faces.iter().enumerate().map(|(i,f)|serde_json::json!({"i":i,"pick":f.ok,"rt_ms":500})).collect::<Vec<_>>()})
                    }
                    WaveSpec::Clones { runners } => {
                        serde_json::json!({"hits":runners.iter().enumerate().map(|(i,c)|serde_json::json!({"i":i,"t_ms":c.ts_ms+500})).collect::<Vec<_>>()})
                    }
                };
                run.wave_result(&w.wave_id, &payload, now).unwrap();
                assert_eq!(run.travelers, before);
            }
        }
        now += 100_000;
    }
    assert_eq!(run.travelers, 40);
    assert_eq!(run.generator_version, 4);
    assert_eq!(
        digest,
        "806c65a3bae2bc514761f5f31e6aae88430f760f177ca04ffe27290365ade6e5"
    );
}
