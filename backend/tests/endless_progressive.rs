use ip_please_sync::endless::{
    model::{Decision, Doc},
    state::{Current, Mode, RunState, StepError},
};
#[test]
fn early_runs_publish_only_learned_rules_and_documents() {
    for seed in 0..40 {
        let mut s = RunState::new(Mode::Endless, &[seed; 32], None);
        s.next(0, &mut |_| "ent_test".into()).unwrap();
        assert_eq!(
            s.view_summary()["progression"]["active_rules"],
            serde_json::json!(["region", "photo"])
        );
        let Some(Current::Traveler(t)) = s.current else {
            panic!()
        };
        assert!(t
            .public
            .docs
            .iter()
            .all(|d| matches!(d, Doc::Passport { .. } | Doc::Device { .. })));
        assert!(t.public.logins.is_empty() && t.public.xray.is_empty());
        assert!(t
            .secret
            .flaws
            .iter()
            .all(|f| ["cnip", "photo"].contains(&f.as_str())));
        assert!(!t.secret.liar && !t.secret.wanted);
    }
}
#[test]
fn initial_fifteen_slots_are_travelers_and_wrong_decision_unlocks_stage() {
    let mut s = RunState::new(Mode::Endless, &[7; 32], None);
    for t in 0..15 {
        s.next(i64::from(t) * 10000, &mut |_| "ent_test".into())
            .unwrap();
        let Some(Current::Traveler(ref tr)) = s.current else {
            panic!("wave at {t}")
        };
        assert_eq!(tr.t, t);
        let decision = if t == 4 {
            if tr.secret.ok.contains(&Decision::Approve) {
                Decision::Deny
            } else {
                Decision::Approve
            }
        } else {
            tr.secret.ok[0]
        };
        s.decide("ent_test", decision, i64::from(t) * 10000 + 2000)
            .unwrap();
        if t == 4 {
            assert_eq!(s.view_summary()["progression"]["stage"], 1);
            assert_eq!(s.travelers, 5);
        }
    }
    assert_eq!(s.processed, 15);
    assert_eq!(s.next_kind(), Some("traveler"));
    for t in 15..23 {
        s.next(i64::from(t) * 10000, &mut |_| "ent_test".into())
            .unwrap();
        let Some(Current::Traveler(ref tr)) = s.current else {
            panic!("wave at {t}")
        };
        assert_eq!(tr.t, t);
        let d = tr.secret.ok[0];
        s.decide("ent_test", d, i64::from(t) * 10000 + 2000)
            .unwrap();
    }
    assert_eq!(s.next_kind(), Some("wave"));
}
#[test]
fn quiz_cannot_run_before_published_even_with_evidence() {
    let mut s = RunState::new(Mode::Endless, &[2; 32], None);
    s.next(0, &mut |_| "ent_test".into()).unwrap();
    if let Some(Current::Traveler(ref mut t)) = s.current {
        t.found.push(0);
    }
    assert_eq!(s.quiz("ent_test"), Err(StepError::Invalid));
}

#[test]
fn every_milestone_gates_flaws_docs_evidence_and_stays_deterministic() {
    use ip_please_sync::endless::{generator_v3 as v3, state::Claim};
    let mut seen = std::collections::BTreeSet::new();
    for seed in 0..32 {
        for t in [
            0, 4, 5, 9, 10, 14, 15, 19, 20, 24, 25, 29, 30, 34, 35, 49, 50, 80, 120,
        ] {
            let g = v3::traveler(&[seed; 32], t, "ent_test");
            let again = v3::traveler(&[seed; 32], t, "ent_test");
            assert_eq!(g.public, again.public);
            assert_eq!(g.secret, again.secret);
            assert!(
                t >= 10
                    || !g
                        .public
                        .docs
                        .iter()
                        .any(|d| matches!(d, Doc::Account { .. }))
            );
            assert!(
                t >= 25
                    || !g
                        .public
                        .docs
                        .iter()
                        .any(|d| matches!(d, Doc::ModelPermit { .. }))
            );
            assert!(
                t >= 30
                    || !g
                        .public
                        .docs
                        .iter()
                        .any(|d| matches!(d, Doc::EntryPermit { .. }))
            );
            assert!(t >= 15 || g.public.xray.is_empty());
            assert!(t >= 35 || g.public.logins.is_empty());
            assert!(
                t >= 35
                    || (!g.secret.wanted
                        && !g.secret.bulletin
                        && v3::bulletin_at(&[seed; 32], t).is_none())
            );
            assert!(
                g.secret.flaws.len()
                    <= if t < 25 {
                        1
                    } else if t < 50 {
                        2
                    } else {
                        3
                    }
            );
            let active = v3::progression(t)["active_rules"]
                .as_array()
                .unwrap()
                .clone();
            for i in &g.secret.issues {
                seen.insert(i.kind.clone());
                for pair in &i.pairs {
                    for f in pair {
                        if let Some(k) = f.strip_prefix("rule.") {
                            assert!(active.contains(&serde_json::json!(k)), "hidden {f} at {t}");
                        }
                    }
                    let mut s = RunState::new(Mode::Endless, &[seed; 32], None);
                    s.current = Some(Current::Traveler(
                        ip_please_sync::endless::state::TravelerState {
                            entrant_id: "ent_test".into(),
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
                        s.inspect("ent_test", Claim::Fields(pair.clone())).unwrap()["match"],
                        true,
                        "{} {t}",
                        i.kind
                    );
                }
            }
        }
    }
    for kind in [
        "region",
        "photo",
        "tz",
        "lang",
        "virtual",
        "billing_region",
        "sms",
        "xray_cat",
        "passport_expired",
        "issuing_country",
        "model_registry",
        "permit_holder",
        "permit_expired",
        "hosting",
        "logins",
        "bulletin",
        "wanted",
    ] {
        assert!(seen.contains(kind), "missing {kind}");
    }
}

#[test]
fn v3_golden_and_full_daily_keep_40_travelers_with_wave_progress_separate() {
    use ip_please_sync::endless::{
        generator::{Slot, WaveSpec},
        generator_v3 as v3,
    };
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for t in 0..120 {
        let g = v3::traveler(&[13; 32], t, "ent_test");
        hash.update(serde_json::to_vec(&(&g.public, &g.secret)).unwrap());
    }
    assert_eq!(
        hex::encode(hash.finalize()),
        "7e32c9d12ddb9ab210c2ee9c4e2a509074d7af9b13c591043ff14b82862688ff"
    );
    let mut s = RunState::new(Mode::Daily, &[13; 32], Some("2026-11-09".into()));
    let mut now = 0;
    let mut order = vec![];
    while !s.ended() {
        s.next(now, &mut |p| format!("{p}_test")).unwrap();
        now += 100000;
        match s.current.clone().unwrap() {
            Current::Traveler(tr) => {
                order.push(tr.t);
                s.decide("ent_test", tr.secret.ok[0], now).unwrap();
            }
            Current::Wave(w) => {
                let before = s.view_summary()["progression"].clone();
                let payload = match w.spec {
                    WaveSpec::Rush { faces } => {
                        serde_json::json!({"picks":faces.iter().enumerate().map(|(i,f)|serde_json::json!({"i":i,"pick":f.ok,"rt_ms":500})).collect::<Vec<_>>()})
                    }
                    WaveSpec::Clones { runners } => {
                        serde_json::json!({"hits":runners.iter().enumerate().map(|(i,c)|serde_json::json!({"i":i,"t_ms":c.ts_ms+500})).collect::<Vec<_>>()})
                    }
                };
                s.wave_result(&w.wave_id, &payload, now).unwrap();
                assert_eq!(s.view_summary()["progression"], before);
            }
        }
        now += 100000;
    }
    assert_eq!(order, (0..40).collect::<Vec<_>>());
    assert_eq!(s.processed, 52);
    assert_eq!(s.travelers, 40);
    assert_eq!(v3::slot(14), Slot::Traveler(14));
    assert_eq!(v3::slot(15), Slot::Traveler(15));
    assert_eq!(v3::slot(23), Slot::Wave(0));
    assert_eq!(v3::slot(24), Slot::Traveler(23));
}

#[test]
fn all_new_visible_constitution_fields_accept_incorrect_comparisons() {
    use ip_please_sync::endless::state::Claim;
    let mut s = RunState::new(Mode::Endless, &[13; 32], None);
    s.slot = 37;
    s.travelers = 35;
    s.next(0, &mut |_| "ent_test".into()).unwrap();
    for key in ["rule.photo", "rule.wanted", "rule.bulletin"] {
        let response = s.inspect(
            "ent_test",
            Claim::Fields(vec![key.into(), "pp.name".into()]),
        );
        assert!(
            response.is_ok(),
            "visible constitution field {key}: {response:?}"
        );
        assert_eq!(response.unwrap()["match"], false);
    }
}
