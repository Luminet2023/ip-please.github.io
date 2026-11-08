mod common;
use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use common::*;
use ip_please_sync::util::now_ms;
#[tokio::test]
async fn platform_endpoints_require_platform_bearer() {
    let state = offline_state();
    for (method, path) in [
        ("GET", "bootstrap"),
        ("GET", "query"),
        ("POST", "profile"),
        ("POST", "action"),
    ] {
        let r = call(
            &state,
            method,
            &format!("/anthropic/v1/mapp/{path}"),
            None,
            None,
        )
        .await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.text);
    }
}
use axum::{routing::get, Json, Router};
use ip_please_sync::{
    ids,
    mapp::auth::{Verifier, AUDIENCE},
    AppState,
};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
const PREFIX: &str = "/anthropic/v1/mapp";
async fn verifier() -> (Verifier, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let c = count.clone();
    let router = Router::new().route(
        "/jwks",
        get(move || {
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Json(
                    serde_json::from_str::<Value>(include_str!("fixtures/test_mapp_jwks.json"))
                        .unwrap(),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/jwks", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (Verifier::new(&url), count)
}
fn claims(method: &str, path: &str, sub: &str, channel: &str) -> Value {
    let now = now_secs();
    json!({"iss":"https://linux.do","aud":AUDIENCE,"app_id":"test-miniapp","channel":channel,"sub":sub,"version":"1.0.0","scopes":["network.request"],"iat":now,"nbf":now,"exp":now+300,"jti":"fixture_request_0123456789","htm":method,"htu":format!("{AUDIENCE}{PREFIX}/{path}"),"query_keys":["op","run_id","save_id","board","period","limit"]})
}
fn sign_mapp(c: &Value) -> String {
    let jwks: Value = serde_json::from_str(include_str!("fixtures/test_mapp_jwks.json")).unwrap();
    let mut h = Header::new(Algorithm::ES256);
    h.kid = Some(jwks["keys"][0]["kid"].as_str().unwrap().into());
    h.typ = Some("mini-app-access+jwt".into());
    jsonwebtoken::encode(
        &h,
        c,
        &EncodingKey::from_ec_pem(include_bytes!("fixtures/test_mapp_private.pem")).unwrap(),
    )
    .unwrap()
}
#[tokio::test]
async fn signed_numeric_claims_accept_integer_values_and_reject_invalid_values() {
    let (v, _) = verifier().await;
    let now = now_secs();
    let url = format!("{AUDIENCE}{PREFIX}/query?op=daily");
    for trust in [0.0, 1.0, 4.0] {
        let mut c = claims("GET", "query", "123", "sandbox");
        c["iat"] = json!(now as f64);
        c["nbf"] = json!(now as f64);
        c["exp"] = json!((now + 300) as f64);
        c["trust_level"] = json!(trust);
        assert!(
            v.verify(
                &format!("Bearer {}", sign_mapp(&c)),
                "test-miniapp",
                "GET",
                &url,
                now
            )
            .await
            .is_ok(),
            "integer-valued .0 claims, trust={trust}"
        );
    }
    for field in ["iat", "nbf", "exp", "trust_level"] {
        for bad in [
            Value::Null,
            json!("1"),
            json!(true),
            json!(1.5),
            json!(9007199254740992u64),
        ] {
            let mut c = claims("GET", "query", "123", "sandbox");
            c[field] = bad.clone();
            assert!(
                v.verify(
                    &format!("Bearer {}", sign_mapp(&c)),
                    "test-miniapp",
                    "GET",
                    &url,
                    now
                )
                .await
                .is_err(),
                "{field}={bad}"
            );
        }
    }
    for bad in [-1.0, 5.0, 256.0] {
        let mut c = claims("GET", "query", "123", "sandbox");
        c["trust_level"] = json!(bad);
        assert!(v
            .verify(
                &format!("Bearer {}", sign_mapp(&c)),
                "test-miniapp",
                "GET",
                &url,
                now
            )
            .await
            .is_err());
    }
}

#[tokio::test]
async fn signed_sdk_claims_and_query_binding() {
    let (v, count) = verifier().await;
    let c = claims("GET", "query", "123", "sandbox");
    let url = format!("{AUDIENCE}{PREFIX}/query?op=leaderboard&limit=10");
    let auth = format!("Bearer {}", sign_mapp(&c));
    for _ in 0..2 {
        assert!(v
            .verify(&auth, "test-miniapp", "GET", &url, now_secs())
            .await
            .is_ok());
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    for (key, bad) in [
        ("iss", json!("https://evil.test")),
        ("aud", json!("https://evil.test")),
        ("app_id", json!("other")),
        ("channel", json!("preview")),
        ("channel", Value::Null),
        ("sub", json!("0123")),
        ("sub", json!(123)),
        ("version", json!("bad version")),
        ("jti", json!("short")),
        ("scopes", json!(["network.websocket"])),
        ("scopes", json!(["network.request", "admin"])),
        ("iat", json!(now_secs() + 6)),
        ("nbf", json!(now_secs() + 6)),
        ("exp", json!(now_secs())),
        ("exp", json!(now_secs() + 901)),
        ("htm", json!("POST")),
        ("htu", json!(format!("{AUDIENCE}/other"))),
        ("trust_level", json!(5)),
        ("trust_level", Value::Null),
    ] {
        let mut bad_claims = c.clone();
        bad_claims[key] = bad;
        assert!(
            v.verify(
                &format!("Bearer {}", sign_mapp(&bad_claims)),
                "test-miniapp",
                "GET",
                &url,
                now_secs()
            )
            .await
            .is_err(),
            "{key}"
        );
    }
    for query in [
        "op=a&op=b",
        "unknown=x",
        "op=%61",
        "op=a%20b",
        "op=a~b",
        "op",
        "mini_app_token=foo",
    ] {
        assert!(
            v.verify(
                &auth,
                "test-miniapp",
                "GET",
                &format!("{AUDIENCE}{PREFIX}/query?{query}"),
                now_secs()
            )
            .await
            .is_err(),
            "{query}"
        );
    }
    for htu in [
        "https:/api.luminet.cn/anthropic/v1/mapp/query",
        "https://api.luminet.cn:0/anthropic/v1/mapp/query",
        "https://api.luminet.cn/a/../anthropic/v1/mapp/query",
    ] {
        let mut malformed = c.clone();
        malformed["htu"] = json!(htu);
        assert!(
            v.verify(
                &format!("Bearer {}", sign_mapp(&malformed)),
                "test-miniapp",
                "GET",
                &url,
                now_secs()
            )
            .await
            .is_err(),
            "{htu}"
        );
    }
    let mut fixed = c.clone();
    fixed["htu"] = json!(format!("{AUDIENCE}{PREFIX}/query?fixed=%20"));
    let a = format!("Bearer {}", sign_mapp(&fixed));
    assert!(v
        .verify(
            &a,
            "test-miniapp",
            "GET",
            &format!("{AUDIENCE}{PREFIX}/query?fixed=%20&op=a+b"),
            now_secs()
        )
        .await
        .is_ok());
    assert!(v
        .verify(
            &a,
            "test-miniapp",
            "GET",
            &format!("{AUDIENCE}{PREFIX}/query?fixed=+&op=a+b"),
            now_secs()
        )
        .await
        .is_err());
}
async fn db_mapp() -> AppState {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let (mut state, _) = db_state("https://idp.test/realms/t").await;
    let (v, _) = verifier().await;
    state.mapp = Arc::new(v);
    state
}
async fn platform(
    state: &AppState,
    method: &str,
    path: &str,
    sub: &str,
    channel: &str,
    body: Option<Value>,
) -> Reply {
    let route = path.split('?').next().unwrap();
    call(
        state,
        method,
        &format!("{PREFIX}/{path}"),
        Some(&sign_mapp(&claims(method, route, sub, channel))),
        body,
    )
    .await
}
fn action(op: &str, args: Value) -> Value {
    json!({"request_id":ids::generate("req"),"op":op,"args":args})
}
#[tokio::test]
#[ignore = "requires disposable MySQL"]
async fn atomic_actions_profile_and_channel_isolation() {
    let state = db_mapp().await;
    let sub = format!("{}", now_ms());
    let a = platform(&state, "GET", "bootstrap", &sub, "sandbox", None).await;
    assert_eq!(a.status, StatusCode::OK, "{}", a.text);
    assert_eq!(a.body["channel"], "sandbox");
    let uid = a.body["user"]["user_id"].as_str().unwrap();
    assert!(ids::is_valid(uid, "user"));
    assert_eq!(a.body["user"]["linuxdo_id"], sub);
    let b = platform(&state, "GET", "bootstrap", &sub, "production", None).await;
    assert_eq!(b.body["channel"], "production");
    assert_ne!(b.body["user"]["user_id"], uid);
    let p = platform(
        &state,
        "POST",
        "profile",
        &sub,
        "sandbox",
        Some(json!({"id":sub,"name":" x\u{202e} y ","username":"same"})),
    )
    .await;
    assert_eq!(p.status, StatusCode::OK, "{}", p.text);
    assert_eq!(p.body["display_name"], "x y");
    let p = platform(
        &state,
        "POST",
        "profile",
        &sub,
        "sandbox",
        Some(json!({"id":"1","username":"same","name":"x"})),
    )
    .await;
    assert_eq!(p.status, StatusCode::BAD_REQUEST);
    let p = platform(
        &state,
        "POST",
        "profile",
        &sub,
        "sandbox",
        Some(json!({"id":sub,"username":"same","name":"x","is_admin":true})),
    )
    .await;
    assert_eq!(p.status, StatusCode::BAD_REQUEST);
    let save = action(
        "save",
        json!({"day":2,"base_version":0,"payload":{"plot":"test"}}),
    );
    let (a, b) = tokio::join!(
        platform(
            &state,
            "POST",
            "action",
            &sub,
            "sandbox",
            Some(save.clone())
        ),
        platform(
            &state,
            "POST",
            "action",
            &sub,
            "sandbox",
            Some(save.clone())
        )
    );
    assert_eq!(a.status, StatusCode::OK, "{}", a.text);
    assert_eq!(a.body, b.body);
    assert_eq!(b.status, a.status);
    let lost = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(save.clone()),
    )
    .await;
    assert_eq!(lost.body, a.body);
    let mut changed = save.clone();
    changed["args"]["day"] = json!(3);
    let conflict = platform(&state, "POST", "action", &sub, "sandbox", Some(changed)).await;
    assert_eq!(conflict.status, StatusCode::CONFLICT);
    assert_eq!(
        conflict.body["detail"],
        "The request ID has already been used for a different action."
    );
    let badbase = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(action(
            "save",
            json!({"day":3,"base_version":0,"payload":{}}),
        )),
    )
    .await;
    assert_eq!(badbase.status, StatusCode::CONFLICT);
    let start = action(
        "run_start",
        json!({"mode":"endless","client_rules_version":2}),
    );
    let (a, b) = tokio::join!(
        platform(
            &state,
            "POST",
            "action",
            &sub,
            "sandbox",
            Some(start.clone())
        ),
        platform(
            &state,
            "POST",
            "action",
            &sub,
            "sandbox",
            Some(start.clone())
        )
    );
    assert_eq!(a.status, StatusCode::CREATED, "{}", a.text);
    assert_eq!(a.body, b.body);
    let run = a.body["run"]["run_id"].as_str().unwrap();
    let cross = platform(
        &state,
        "GET",
        &format!("query?op=run&run_id={run}"),
        &sub,
        "production",
        None,
    )
    .await;
    assert_eq!(cross.status, StatusCode::NOT_FOUND);
    let next = action("run_next", json!({"run_id":run}));
    let (a, b) = tokio::join!(
        platform(
            &state,
            "POST",
            "action",
            &sub,
            "sandbox",
            Some(next.clone())
        ),
        platform(
            &state,
            "POST",
            "action",
            &sub,
            "sandbox",
            Some(next.clone())
        )
    );
    assert_eq!(a.status, StatusCode::OK, "{}", a.text);
    assert_eq!(a.body, b.body);
    let end = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(action("run_abandon", json!({"run_id":run}))),
    )
    .await;
    assert_eq!(end.status, StatusCode::OK, "{}", end.text);
    assert!(end.body["final"]["ranks"]["endless"].is_number());
    let web: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ip_please_leaderboard WHERE run_id=?")
        .bind(run)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(web, 0);
    let board = platform(&state, "GET", "query?op=leaderboard", &sub, "sandbox", None).await;
    assert_eq!(board.status, StatusCode::OK, "{}", board.text);
    assert_eq!(board.body["me"]["linuxdo_id"], sub);
    let prod = platform(
        &state,
        "GET",
        "query?op=leaderboard",
        &sub,
        "production",
        None,
    )
    .await;
    assert!(prod.body["me"].is_null());
}
fn subject() -> String {
    format!("{}{:06}", now_ms(), rand::random::<u32>() % 1_000_000)
}
#[tokio::test]
#[ignore = "requires disposable MySQL"]
async fn receipts_rollback_business_effects_and_replay_all_game_actions() {
    use ip_please_sync::endless::store as runs;
    let mut state = db_mapp().await;
    // Trigger DDL takes table-wide metadata locks, even with a user-specific condition.
    // Isolate fault injection so CREATE/DROP cannot deadlock unrelated parallel routes.
    let admin_pool = state.pool.clone();
    let schema = format!("ip_please_mapp_fixture_{}", rand::random::<u64>());
    sqlx::raw_sql(&format!("CREATE DATABASE {schema}"))
        .execute(&admin_pool)
        .await
        .unwrap();
    let mut url = reqwest::Url::parse(&state.config.database_url).unwrap();
    url.set_path(&schema);
    state.pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(5)
        .connect(url.as_str())
        .await
        .unwrap();
    ip_please_sync::db::migrate(&state.pool).await.unwrap();
    let test_pool = state.pool.clone();
    let result = tokio::spawn(async move {
    let sub = subject();
    let boot = platform(&state, "GET", "bootstrap", &sub, "sandbox", None).await;
    let uid = boot.body["user"]["user_id"].as_str().unwrap();
    let trigger = format!("mapp_failure_{}", rand::random::<u32>());
    sqlx::raw_sql(&format!("CREATE TRIGGER {trigger} BEFORE INSERT ON ip_please_mapp_receipts FOR EACH ROW BEGIN IF NEW.user_id = '{uid}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture receipt failure'; END IF; END")).execute(&state.pool).await.unwrap();
    let save = action("save", json!({"day":1,"payload":{},"base_version":0}));
    let failed_save = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(save.clone()),
    )
    .await;
    let start = action(
        "run_start",
        json!({"mode":"endless","client_rules_version":2}),
    );
    let failed_start = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(start.clone()),
    )
    .await;
    sqlx::raw_sql(&format!("DROP TRIGGER {trigger}"))
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(failed_save.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(failed_start.status, StatusCode::INTERNAL_SERVER_ERROR);
    for table in [
        "ip_please_save_slots",
        "ip_please_save_snapshots",
        "ip_please_endless_runs",
        "ip_please_mapp_receipts",
    ] {
        let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE user_id=?"))
            .bind(uid)
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} must roll back with receipt failure");
    }
    assert_eq!(
        platform(&state, "POST", "action", &sub, "sandbox", Some(save))
            .await
            .status,
        StatusCode::OK
    );
    let started = platform(&state, "POST", "action", &sub, "sandbox", Some(start)).await;
    assert_eq!(started.status, StatusCode::CREATED, "{}", started.text);
    let id = started.body["run"]["run_id"].as_str().unwrap();
    let mut inspected = false;
    let mut wave_seen = false;
    for _ in 0..60 {
        let n = platform(
            &state,
            "POST",
            "action",
            &sub,
            "sandbox",
            Some(action("run_next", json!({"run_id":id}))),
        )
        .await;
        assert_eq!(n.status, StatusCode::OK, "{}", n.text);
        assert!(!n.text.contains("\"secret\""));
        assert!(!n.text.contains("\"liar\""));
        let mut r = runs::load(&state.pool, id).await.unwrap().unwrap();
        let current = r.state.current.as_mut().unwrap();
        let (op, args) = match current {
            ip_please_sync::endless::state::Current::Traveler(t) => {
                t.issued_at_ms = now_ms() - 3000;
                if !inspected {
                    if let Some(pair) = t
                        .secret
                        .issues
                        .iter()
                        .flat_map(|i| i.pairs.iter())
                        .find(|p| p.len() == 2)
                    {
                        let inspect = action(
                            "run_inspect",
                            json!({"run_id":id,"entrant_id":t.entrant_id,"fields":pair}),
                        );
                        let (x, y) = tokio::join!(
                            platform(
                                &state,
                                "POST",
                                "action",
                                &sub,
                                "sandbox",
                                Some(inspect.clone())
                            ),
                            platform(
                                &state,
                                "POST",
                                "action",
                                &sub,
                                "sandbox",
                                Some(inspect.clone())
                            )
                        );
                        assert_eq!(x.status, StatusCode::OK, "{}", x.text);
                        assert_eq!(x.body["match"], true);
                        assert_eq!(x.body, y.body);
                        let quiz =
                            action("run_quiz", json!({"run_id":id,"entrant_id":t.entrant_id}));
                        let (x, y) = tokio::join!(
                            platform(
                                &state,
                                "POST",
                                "action",
                                &sub,
                                "sandbox",
                                Some(quiz.clone())
                            ),
                            platform(
                                &state,
                                "POST",
                                "action",
                                &sub,
                                "sandbox",
                                Some(quiz.clone())
                            )
                        );
                        assert_eq!(x.status, StatusCode::OK, "{}", x.text);
                        assert_eq!(x.body, y.body);
                        assert_eq!(x.body["exposed"], t.secret.liar);
                        inspected = true;
                    }
                }
                (
                    "run_decision",
                    json!({"run_id":id,"entrant_id":t.entrant_id,"decision":t.secret.ok[0]}),
                )
            }
            ip_please_sync::endless::state::Current::Wave(w) => {
                w.issued_at_ms = now_ms() - 120_000;
                wave_seen = true;
                (
                    "wave_result",
                    json!({"run_id":id,"wave_id":w.wave_id,"picks":[],"hits":[]}),
                )
            }
        };
        // Age only server issuance time, preserving inspection and quiz writes.
        let aged = match current {
            ip_please_sync::endless::state::Current::Traveler(t) => t.issued_at_ms,
            ip_please_sync::endless::state::Current::Wave(w) => w.issued_at_ms,
        };
        sqlx::query("UPDATE ip_please_endless_runs SET state_json=JSON_SET(state_json,'$.current.issued_at_ms',?) WHERE run_id=?").bind(aged).bind(id).execute(&state.pool).await.unwrap();
        let mutation = action(op, args);
        let (x, y) = tokio::join!(
            platform(
                &state,
                "POST",
                "action",
                &sub,
                "sandbox",
                Some(mutation.clone())
            ),
            platform(
                &state,
                "POST",
                "action",
                &sub,
                "sandbox",
                Some(mutation.clone())
            )
        );
        assert_eq!(x.status, StatusCode::OK, "{}", x.text);
        assert_eq!(x.body, y.body);
        let event_no: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM ip_please_endless_events WHERE run_id=?")
                .bind(id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        let lost = platform(&state, "POST", "action", &sub, "sandbox", Some(mutation)).await;
        assert_eq!(lost.body, x.body);
        let after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM ip_please_endless_events WHERE run_id=?")
                .bind(id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(after, event_no);
        if inspected && wave_seen {
            break;
        }
    }
    assert!(inspected && wave_seen);
    }).await;
    test_pool.close().await;
    sqlx::raw_sql(&format!("DROP DATABASE {schema}"))
        .execute(&admin_pool)
        .await
        .unwrap();
    result.expect("isolated rollback/action test failed after schema cleanup");
}
#[tokio::test]
#[ignore = "requires disposable MySQL"]
async fn expiry_and_final_ranks_keep_website_history_and_platform_sources_separate() {
    use ip_please_sync::endless::{
        state::{Mode, RunState},
        store as runs,
    };
    let state = db_mapp().await;
    let sub = subject();
    let web_user = ids::generate("user");
    let mut game = RunState::new(Mode::Endless, &[3; 32], None);
    game.score = 987654321;
    let web = runs::create(&state.pool, &web_user, &game, now_ms())
        .await
        .unwrap();
    runs::mutate(&state.pool, &web, &web_user, now_ms(), "abandon", |s| {
        s.end("abandon");
        Ok(((), json!({})))
    })
    .await
    .unwrap();
    let web_before: Value = runs::final_view(
        &state.pool,
        &runs::load(&state.pool, &web).await.unwrap().unwrap(),
    )
    .await
    .unwrap();
    let mut ids_by_channel = vec![];
    for channel in ["sandbox", "production"] {
        let start = platform(
            &state,
            "POST",
            "action",
            &sub,
            channel,
            Some(action(
                "run_start",
                json!({"mode":"endless","client_rules_version":2}),
            )),
        )
        .await;
        assert_eq!(start.status, StatusCode::CREATED, "{}", start.text);
        let id = start.body["run"]["run_id"].as_str().unwrap().to_owned();
        sqlx::query("UPDATE ip_please_endless_runs SET state_json=JSON_SET(state_json,'$.score',?),last_action_at_ms=? WHERE run_id=?").bind(if channel=="sandbox"{1234567}else{777}).bind(now_ms()-16*60*1000).bind(&id).execute(&state.pool).await.unwrap();
        ids_by_channel.push(id);
    }
    runs::expire_stale(&state.pool, now_ms()).await.unwrap();
    for (channel, expected) in [("sandbox", 1234567), ("production", 777)] {
        let board = platform(&state, "GET", "query?op=leaderboard", &sub, channel, None).await;
        assert_eq!(board.status, StatusCode::OK, "{}", board.text);
        assert_eq!(board.body["me"]["score"], expected);
        assert_eq!(board.body["me"]["linuxdo_id"], sub);
    }
    for id in &ids_by_channel {
        let run = runs::load(&state.pool, id).await.unwrap().unwrap();
        assert!(run.state.ended());
        let view = runs::final_view(&state.pool, &run).await.unwrap();
        assert!(view["ranks"]["endless"].is_number());
        let n: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM ip_please_leaderboard WHERE run_id=?")
                .bind(id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(n, 0);
    }
    let after = runs::final_view(
        &state.pool,
        &runs::load(&state.pool, &web).await.unwrap().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(after, web_before);
    let board = runs::leaderboard(&state.pool, "endless", "all", 100, Some((&web_user, false)))
        .await
        .unwrap();
    assert!(!board.to_string().contains("linuxdo_id"));
    assert_eq!(board["me"]["score"], 987654321);
}
#[tokio::test]
async fn jwks_rotation_singleflight_cooldown_and_untrusted_headers() {
    use std::sync::Mutex;
    let count = Arc::new(AtomicUsize::new(0));
    let doc = Arc::new(Mutex::new(
        serde_json::from_str::<Value>(include_str!("fixtures/test_mapp_jwks.json")).unwrap(),
    ));
    let d = doc.clone();
    let c = count.clone();
    let app = Router::new().route(
        "/keys",
        get(move || {
            let d = d.clone();
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Json(d.lock().unwrap().clone())
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/keys", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let v = Arc::new(Verifier::new(&url));
    let good = claims("GET", "bootstrap", "12345", "production");
    let auth = format!("Bearer {}", sign_mapp(&good));
    let target = format!("{AUDIENCE}{PREFIX}/bootstrap");
    let mut tasks = vec![];
    for _ in 0..12 {
        let v = v.clone();
        let a = auth.clone();
        let t = target.clone();
        tasks.push(tokio::spawn(async move {
            v.verify(&a, "test-miniapp", "GET", &t, now_secs())
                .await
                .is_ok()
        }));
    }
    for t in tasks {
        assert!(t.await.unwrap());
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let old_jwks: Value =
        serde_json::from_str(include_str!("fixtures/test_mapp_jwks.json")).unwrap();
    let old_kid = old_jwks["keys"][0]["kid"].as_str().unwrap();
    for extra in [
        json!({"jku":url}),
        json!({"jwk":old_jwks["keys"][0]}),
        json!({"x5u":url}),
        json!({"crit":["custom"]}),
    ] {
        let mut h = json!({"alg":"ES256","typ":"mini-app-access+jwt","kid":old_kid});
        for (k, x) in extra.as_object().unwrap() {
            h[k] = x.clone();
        }
        let message = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(h.to_string()),
            URL_SAFE_NO_PAD.encode(good.to_string())
        );
        let signature = jsonwebtoken::crypto::sign(
            message.as_bytes(),
            &EncodingKey::from_ec_pem(include_bytes!("fixtures/test_mapp_private.pem")).unwrap(),
            Algorithm::ES256,
        )
        .unwrap();
        let token = format!("{message}.{signature}");
        assert!(v
            .verify(
                &format!("Bearer {token}"),
                "test-miniapp",
                "GET",
                &target,
                now_secs()
            )
            .await
            .is_err());
    }
    let rotated: Value =
        serde_json::from_str(include_str!("fixtures/test_mapp_rotated_jwks.json")).unwrap();
    let mut h = Header::new(Algorithm::ES256);
    h.typ = Some("mini-app-access+jwt".into());
    h.kid = Some(old_kid.into());
    let forged = jsonwebtoken::encode(
        &h,
        &good,
        &EncodingKey::from_ec_pem(include_bytes!("fixtures/test_mapp_rotated_private.pem"))
            .unwrap(),
    )
    .unwrap();
    assert!(v
        .verify(
            &format!("Bearer {forged}"),
            "test-miniapp",
            "GET",
            &target,
            now_secs()
        )
        .await
        .is_err());
    h.kid = Some(rotated["keys"][0]["kid"].as_str().unwrap().into());
    let token = jsonwebtoken::encode(
        &h,
        &good,
        &EncodingKey::from_ec_pem(include_bytes!("fixtures/test_mapp_rotated_private.pem"))
            .unwrap(),
    )
    .unwrap();
    let auth = format!("Bearer {token}");
    for _ in 0..10 {
        assert!(v
            .verify(&auth, "test-miniapp", "GET", &target, now_secs())
            .await
            .is_err());
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    *doc.lock().unwrap() = rotated;
    tokio::time::sleep(std::time::Duration::from_millis(5100)).await;
    let (x, y) = tokio::join!(
        v.verify(&auth, "test-miniapp", "GET", &target, now_secs()),
        v.verify(&auth, "test-miniapp", "GET", &target, now_secs())
    );
    assert!(x.is_ok());
    assert!(y.is_ok());
    assert_eq!(count.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn cors_errors_preflight_and_no_website_cookie_fallback() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    let state = offline_state();
    let web_token = state
        .tokens
        .issue(&ids::generate("user"), &ids::generate("sess"), now_secs())
        .0;
    for (method, auth, expected) in [
        ("OPTIONS", None, StatusCode::OK),
        ("GET", None, StatusCode::UNAUTHORIZED),
        ("GET", Some(web_token.as_str()), StatusCode::UNAUTHORIZED),
    ] {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("{PREFIX}/bootstrap"))
            .header("origin", "https://linux.do")
            .header("host", "evil.invalid")
            .header("x-forwarded-host", "evil.invalid")
            .header("cookie", format!("session={web_token}"));
        if method == "OPTIONS" {
            req = req
                .header("access-control-request-method", "GET")
                .header("access-control-request-headers", "authorization");
        }
        if let Some(auth) = auth {
            req = req.header("authorization", format!("Bearer {auth}"));
        }
        let res = ip_please_sync::build_app(state.clone())
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), expected);
        assert_eq!(
            res.headers()["access-control-allow-origin"],
            "https://linux.do"
        );
        if method != "OPTIONS" {
            assert_eq!(res.headers()["content-type"], "application/json");
            assert_eq!(res.headers()["cache-control"], "private, no-store");
        }
    }
}
#[tokio::test]
#[ignore = "requires disposable MySQL"]
async fn query_resources_daily_and_unprivileged_action_boundaries() {
    let state = db_mapp().await;
    let sub = subject();
    let other = subject();
    let save = action(
        "save",
        json!({"day":14,"payload":{"ending":"fixture"},"base_version":0}),
    );
    let saved = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(save.clone()),
    )
    .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text);
    let own = platform(&state, "GET", "query?op=save", &sub, "sandbox", None).await;
    assert_eq!(own.body["payload"]["ending"], "fixture");
    let snapshot = saved.body["save_id"].as_str().unwrap();
    let query = format!("query?op=snapshot&save_id={snapshot}");
    assert_eq!(
        platform(&state, "GET", &query, &sub, "sandbox", None)
            .await
            .status,
        StatusCode::OK
    );
    for (user, channel) in [(&other, "sandbox"), (&sub, "production")] {
        assert_eq!(
            platform(&state, "GET", &query, user, channel, None)
                .await
                .status,
            StatusCode::GONE
        );
        assert_eq!(
            platform(&state, "GET", "query?op=save", user, channel, None)
                .await
                .status,
            StatusCode::NOT_FOUND
        );
        // The same opaque request ID is independent across both authenticated users and channels.
        let independent =
            platform(&state, "POST", "action", user, channel, Some(save.clone())).await;
        assert_eq!(independent.status, StatusCode::OK, "{}", independent.text);
        assert_ne!(independent.body["save_id"], snapshot);
    }
    let list = platform(
        &state,
        "GET",
        "query?op=snapshots&limit=1",
        &sub,
        "sandbox",
        None,
    )
    .await;
    assert_eq!(list.body["snapshots"].as_array().unwrap().len(), 1);
    for query in [
        "query?op=admin",
        "query?op=announcements&role=admin",
        "query?op=run&run_id=123",
        "query?op=leaderboard&board=unknown",
    ] {
        let rejected = platform(&state, "GET", query, &sub, "sandbox", None).await;
        assert!(rejected.status.is_client_error(), "{}", rejected.text);
    }
    for invalid_args in [
        json!({"mode":"daily","client_rules_version":1}),
        json!({"mode":"daily","client_rules_version":2,"platform":"web"}),
        json!({"mode":"daily","client_rules_version":2,"user_id":saved.body["user_id"]}),
    ] {
        assert!(platform(
            &state,
            "POST",
            "action",
            &sub,
            "sandbox",
            Some(action("run_start", invalid_args))
        )
        .await
        .status
        .is_client_error());
    }
    let start = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(action(
            "run_start",
            json!({"mode":"daily","client_rules_version":2}),
        )),
    )
    .await;
    assert_eq!(start.status, StatusCode::CREATED, "{}", start.text);
    let run = start.body["run"]["run_id"].as_str().unwrap();
    for (user, channel) in [(&other, "sandbox"), (&sub, "production")] {
        assert_eq!(
            platform(
                &state,
                "POST",
                "action",
                user,
                channel,
                Some(action("run_next", json!({"run_id":run})))
            )
            .await
            .status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            platform(
                &state,
                "GET",
                &format!("query?op=run&run_id={run}"),
                user,
                channel,
                None
            )
            .await
            .status,
            StatusCode::NOT_FOUND
        );
    }
    let daily = platform(&state, "GET", "query?op=daily", &sub, "sandbox", None).await;
    assert_eq!(daily.body["played"], true);
    assert_eq!(daily.body["in_progress"], true);
    let current = platform(&state, "GET", "query?op=run_current", &sub, "sandbox", None).await;
    assert_eq!(current.body["run"]["run_id"], run);
    let abandon = action("run_abandon", json!({"run_id":run}));
    let ended = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(abandon.clone()),
    )
    .await;
    assert_eq!(ended.status, StatusCode::OK, "{}", ended.text);
    assert_eq!(
        platform(&state, "POST", "action", &sub, "sandbox", Some(abandon))
            .await
            .body,
        ended.body
    );
    let again = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(action(
            "run_start",
            json!({"mode":"daily","client_rules_version":2}),
        )),
    )
    .await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    let production = platform(
        &state,
        "POST",
        "action",
        &sub,
        "production",
        Some(action(
            "run_start",
            json!({"mode":"daily","client_rules_version":2}),
        )),
    )
    .await;
    assert_eq!(
        production.status,
        StatusCode::CREATED,
        "{}",
        production.text
    );
    let malformed = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(json!({"request_id":"123","op":"save","args":{"day":1,"payload":{}}})),
    )
    .await;
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);
}
#[tokio::test]
#[ignore = "requires disposable MySQL"]
async fn too_early_and_rate_limit_retry_same_request_without_poisoned_receipt() {
    let mut state = db_mapp().await;
    let sub = subject();
    let started = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(action(
            "run_start",
            json!({"mode":"endless","client_rules_version":2}),
        )),
    )
    .await;
    let run = started.body["run"]["run_id"].as_str().unwrap();
    let next = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(action("run_next", json!({"run_id":run}))),
    )
    .await;
    assert_eq!(next.status, StatusCode::OK, "{}", next.text);
    let entrant = next.body["item"]["entrant"]["entrant_id"].as_str().unwrap();
    let decision = action(
        "run_decision",
        json!({"run_id":run,"entrant_id":entrant,"decision":"approve"}),
    );
    let early = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(decision.clone()),
    )
    .await;
    assert_eq!(
        early.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        early.text
    );
    assert!(early.headers.contains_key("retry-after"));
    sqlx::query("UPDATE ip_please_endless_runs SET state_json=JSON_SET(state_json,'$.current.issued_at_ms',?) WHERE run_id=?").bind(now_ms()-3000).bind(run).execute(&state.pool).await.unwrap();
    let retried = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(decision.clone()),
    )
    .await;
    assert_eq!(
        retried.status,
        StatusCode::OK,
        "TooEarly must not poison the request receipt: {}",
        retried.text
    );
    assert_eq!(
        platform(&state, "POST", "action", &sub, "sandbox", Some(decision))
            .await
            .body,
        retried.body
    );
    // A dependency outage before acceptance must also leave this request reusable.
    let outage_save = action("save", json!({"day":1,"payload":{},"base_version":0}));
    let outage_sub = subject();
    let healthy_pool = state.pool.clone();
    state.pool = sqlx::mysql::MySqlPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(30))
        .connect_lazy("mysql://unused:unused@127.0.0.1:1/unavailable")
        .unwrap();
    let unavailable = platform(
        &state,
        "POST",
        "action",
        &outage_sub,
        "sandbox",
        Some(outage_save.clone()),
    )
    .await;
    assert_eq!(unavailable.status, StatusCode::SERVICE_UNAVAILABLE);
    state.pool = healthy_pool;
    assert_eq!(
        platform(
            &state,
            "POST",
            "action",
            &outage_sub,
            "sandbox",
            Some(outage_save)
        )
        .await
        .status,
        StatusCode::OK
    );
    let mut cfg = (*state.config).clone();
    cfg.rate_limit_seconds = 1;
    state.config = Arc::new(cfg);
    state.limiter = Arc::new(ip_please_sync::ratelimit::RateLimiter::new());
    let first = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(action(
            "save",
            json!({"day":1,"payload":{},"base_version":0}),
        )),
    )
    .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text);
    let save = action("save", json!({"day":2,"payload":{},"base_version":1}));
    let limited = platform(
        &state,
        "POST",
        "action",
        &sub,
        "sandbox",
        Some(save.clone()),
    )
    .await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let retry = platform(&state, "POST", "action", &sub, "sandbox", Some(save)).await;
    assert_eq!(retry.status, StatusCode::OK, "{}", retry.text);
    assert_eq!(retry.body["version"], 2);
}
#[tokio::test]
#[ignore = "requires disposable MySQL"]
async fn platform_best_scores_and_tie_order_match_website_semantics() {
    use ip_please_sync::{
        endless::{
            state::{Mode, RunState},
            store as runs,
        },
        mapp::{auth::Principal, store},
    };
    let state = db_mapp().await;
    let app = format!("rank-fixture-{}", subject());
    let mut accounts = vec![];
    for _ in 0..3 {
        let mut c = claims("GET", "query", &subject(), "sandbox");
        c["app_id"] = json!(app);
        let p: Principal = serde_json::from_value(c).unwrap();
        accounts.push(store::account(&state.pool, &p).await.unwrap());
    }
    let now = now_ms();
    let mut winning_run = String::new();
    // user 0's equal/lower later results must not replace the earliest 500-point run.
    for (i, score, time) in [
        (0, 500, now - 3000),
        (1, 500, now - 2000),
        (2, 200, now - 1000),
        (0, 500, now),
        (0, 100, now + 1),
    ] {
        let a = &accounts[i];
        let mut game = RunState::new(Mode::Endless, &[7; 32], None);
        game.score = score;
        let mut tx = state.pool.begin().await.unwrap();
        let id = runs::create(&mut *tx, &a.user_id, &game, now - 5000)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO ip_please_mapp_run_sources(run_id,identity_key,scope_key) VALUES (?,?,?)",
        )
        .bind(&id)
        .bind(&a.identity_key)
        .bind(&a.scope_key)
        .execute(&mut *tx)
        .await
        .unwrap();
        runs::mutate_tx(&mut tx, &id, &a.user_id, time, "abandon", |s| {
            s.end("abandon");
            Ok(((), json!({})))
        })
        .await
        .unwrap();
        tx.commit().await.unwrap();
        if winning_run.is_empty() {
            winning_run = id;
        }
    }
    let board = store::leaderboard(&state.pool, &accounts[1], "endless", "all", 100)
        .await
        .unwrap();
    let entries = board["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0]["linuxdo_id"], accounts[0].linuxdo_id);
    assert_eq!(entries[1]["linuxdo_id"], accounts[1].linuxdo_id);
    assert_eq!(board["me"]["rank"], 2);
    assert_eq!(board["me"]["score"], 500);
    let kept:String=sqlx::query_scalar("SELECT run_id FROM ip_please_mapp_leaderboard WHERE scope_key=? AND board='endless' AND period='all' AND user_id=?").bind(&accounts[0].scope_key).bind(&accounts[0].user_id).fetch_one(&state.pool).await.unwrap();
    assert_eq!(kept, winning_run);
    let weekly = store::leaderboard(
        &state.pool,
        &accounts[2],
        "weekly",
        &runs::iso_week(now),
        100,
    )
    .await
    .unwrap();
    assert_eq!(weekly["me"]["rank"], 3);
    assert_eq!(weekly["me"]["score"], 200);
}
#[tokio::test]
#[ignore = "requires disposable MySQL"]
async fn independent_users_can_create_first_receipts_saves_and_runs_concurrently() {
    let state = db_mapp().await;
    let mut tasks = vec![];
    for _ in 0..32 {
        let state = state.clone();
        let sub = subject();
        tasks.push(tokio::spawn(async move {
            let save = action("save", json!({"day":1,"payload":{},"base_version":0}));
            let first = platform(
                &state,
                "POST",
                "action",
                &sub,
                "sandbox",
                Some(save.clone()),
            )
            .await;
            let second = platform(&state, "POST", "action", &sub, "sandbox", Some(save)).await;
            let start = platform(
                &state,
                "POST",
                "action",
                &sub,
                "sandbox",
                Some(action(
                    "run_start",
                    json!({"mode":"endless","client_rules_version":2}),
                )),
            )
            .await;
            (first, second, start)
        }));
    }
    for task in tasks {
        let (a, b, c) = task.await.unwrap();
        assert_eq!(a.status, StatusCode::OK, "{}", a.text);
        assert_eq!(b.body, a.body);
        assert_eq!(c.status, StatusCode::CREATED, "{}", c.text);
    }
}
