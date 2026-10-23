//! 需要 MySQL 的集成测试（`#[ignore]`）：
//!
//! ```bash
//! TEST_DATABASE_URL=mysql://root:root@127.0.0.1:33306/ip_please_test cargo test -- --ignored
//! ```

mod common;

use std::collections::HashMap;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::*;
use ip_please_sync::util::{random_b64url, sha256_b64url};
use ip_please_sync::AppState;

const CLIENT_ID: &str = "app_test_client_0001";

struct Login {
    access_token: String,
    refresh_token: String,
    body: Value,
}

/// 走一遍完整登录：/auth/login → 模拟 IdP 发码 → /auth/callback。
async fn login(state: &AppState, idp: &MockIdp, subject: &str, sid: &str, roles: &[&str]) -> Login {
    let verifier = random_b64url(32);
    let reply = call(
        state,
        "POST",
        "/anthropic/v1/auth/login",
        None,
        Some(json!({"login_challenge": sha256_b64url(verifier.as_bytes())})),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    let url = reqwest::Url::parse(reply.body["authorize_url"].as_str().unwrap()).unwrap();
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(params["state"], reply.body["state"].as_str().unwrap());

    let code = format!("code-{}", random_b64url(6));
    idp.codes.lock().unwrap().insert(
        code.clone(),
        PendingCode {
            nonce: params["nonce"].clone(),
            code_challenge: params["code_challenge"].clone(),
            subject: subject.into(),
            sid: sid.into(),
            roles: roles.iter().map(|r| r.to_string()).collect(),
        },
    );
    let issuer = idp.issuer.lock().unwrap().clone();
    let reply = call(
        state,
        "POST",
        "/anthropic/v1/auth/callback",
        None,
        Some(json!({
            "code": code, "state": params["state"], "login_verifier": verifier, "iss": issuer,
        })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    Login {
        access_token: reply.body["access_token"].as_str().unwrap().to_string(),
        refresh_token: reply.body["refresh_token"].as_str().unwrap().to_string(),
        body: reply.body,
    }
}

fn unique(label: &str) -> String {
    format!("{label}-{}", random_b64url(6))
}

#[tokio::test]
#[ignore]
async fn migrations_are_idempotent() {
    let (issuer, _idp) = start_mock_idp(CLIENT_ID).await;
    let (_state, pool) = db_state(&issuer).await;
    ip_please_sync::db::migrate(&pool)
        .await
        .expect("second run");
    ip_please_sync::db::migrate(&pool).await.expect("third run");
}

#[tokio::test]
#[ignore]
async fn login_refresh_reuse_and_logout() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, pool) = db_state(&issuer).await;
    let subject = unique("kc-user");
    let first = login(&state, &idp, &subject, &unique("kc-sid"), &[]).await;

    let body = &first.body;
    assert_eq!(body["token_type"], "Bearer");
    assert_eq!(body["expires_in"], 600);
    assert!(body["session_id"].as_str().unwrap().starts_with("sess_"));
    // 名字与头像直接取自 IdP 的 ID Token
    assert_eq!(body["user"]["display_name"], format!("玩家 {subject}"));
    assert_eq!(
        body["user"]["avatar_url"],
        format!("https://avatars.test/{subject}.png")
    );
    assert!(body["user"].get("nickname").is_none());
    assert_eq!(body["user"]["is_admin"], false);
    assert_eq!(body["refresh_token"].as_str().unwrap().len(), 43);

    // 同一 IdP 用户再次登录 → 同一个 user_id、不同会话
    let second = login(&state, &idp, &subject, &unique("kc-sid"), &[]).await;
    assert_eq!(
        second.body["user"]["user_id"],
        first.body["user"]["user_id"]
    );
    assert_ne!(second.body["session_id"], first.body["session_id"]);

    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&first.access_token),
        None,
    )
    .await;
    assert_eq!(me.status, StatusCode::OK, "{}", me.text);
    assert_eq!(me.body["session"]["session_id"], first.body["session_id"]);
    assert_eq!(
        me.headers.get("cache-control").unwrap(),
        "private, no-store"
    );

    // 日终同步用新的 AT
    let save = call(
        &state,
        "POST",
        "/anthropic/v1/sync/save",
        Some(&first.access_token),
        Some(json!({"day": 2, "payload": {"day": 2, "plot": {}}, "base_version": 0})),
    )
    .await;
    assert!(
        save.status == StatusCode::OK || save.status == StatusCode::CONFLICT,
        "{}",
        save.text
    );

    // 刷新：拿到新 RT
    let refreshed = call(
        &state,
        "POST",
        "/anthropic/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": first.refresh_token})),
    )
    .await;
    assert_eq!(refreshed.status, StatusCode::OK, "{}", refreshed.text);
    let rotated = refreshed.body["refresh_token"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(rotated, first.refresh_token);

    // 宽限期内重放旧 RT → invalid_token（会话不吊销）
    let stale = call(
        &state,
        "POST",
        "/anthropic/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": first.refresh_token})),
    )
    .await;
    assert_auth_error(&stale, StatusCode::UNAUTHORIZED, "invalid_token");
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&first.access_token),
        None,
    )
    .await;
    assert_eq!(me.status, StatusCode::OK);

    // 把旧 RT 的使用时间改到宽限期之前 → 重放即泄露，吊销整个会话
    sqlx::query(
        "UPDATE ip_please_refresh_tokens SET used_at_ms = used_at_ms - 60000 WHERE token_hash = ?",
    )
    .bind(ip_please_sync::auth::tokens::refresh_token_hash(
        &first.refresh_token,
    ))
    .execute(&pool)
    .await
    .unwrap();
    let reuse = call(
        &state,
        "POST",
        "/anthropic/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": first.refresh_token})),
    )
    .await;
    assert_auth_error(&reuse, StatusCode::UNAUTHORIZED, "token_revoked");
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&first.access_token),
        None,
    )
    .await;
    assert_auth_error(&me, StatusCode::UNAUTHORIZED, "token_revoked");
    let after = call(
        &state,
        "POST",
        "/anthropic/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": rotated})),
    )
    .await;
    assert_auth_error(&after, StatusCode::UNAUTHORIZED, "token_revoked");

    // 另一个会话不受影响；登出后失效
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&second.access_token),
        None,
    )
    .await;
    assert_eq!(me.status, StatusCode::OK);
    let out = call(
        &state,
        "POST",
        "/anthropic/v1/auth/logout",
        None,
        Some(json!({"refresh_token": second.refresh_token})),
    )
    .await;
    assert_eq!(out.status, StatusCode::OK);
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&second.access_token),
        None,
    )
    .await;
    assert_auth_error(&me, StatusCode::UNAUTHORIZED, "token_revoked");
}

#[tokio::test]
#[ignore]
async fn callback_rejects_wrong_verifier_and_replayed_state() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, _pool) = db_state(&issuer).await;
    let verifier = random_b64url(32);
    let reply = call(
        &state,
        "POST",
        "/anthropic/v1/auth/login",
        None,
        Some(json!({"login_challenge": sha256_b64url(verifier.as_bytes())})),
    )
    .await;
    let url = reqwest::Url::parse(reply.body["authorize_url"].as_str().unwrap()).unwrap();
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    idp.codes.lock().unwrap().insert(
        "code-x".into(),
        PendingCode {
            nonce: params["nonce"].clone(),
            code_challenge: params["code_challenge"].clone(),
            subject: unique("kc"),
            sid: unique("sid"),
            roles: vec![],
        },
    );
    // 拿到 code+state 但没有浏览器的 verifier → 拒绝，且 state 已作废
    let stolen = call(
        &state,
        "POST",
        "/anthropic/v1/auth/callback",
        None,
        Some(json!({"code": "code-x", "state": params["state"], "login_verifier": random_b64url(32)})),
    )
    .await;
    assert_detail(
        &stolen,
        StatusCode::BAD_REQUEST,
        "The login attempt is invalid or has expired.",
    );
    let replay = call(
        &state,
        "POST",
        "/anthropic/v1/auth/callback",
        None,
        Some(json!({"code": "code-x", "state": params["state"], "login_verifier": verifier})),
    )
    .await;
    assert_detail(
        &replay,
        StatusCode::BAD_REQUEST,
        "The login attempt is invalid or has expired.",
    );
}

#[tokio::test]
#[ignore]
async fn backchannel_logout_revokes_matching_idp_session() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, _pool) = db_state(&issuer).await;
    let subject = unique("kc-user");
    let sid_a = unique("kc-sid");
    let a = login(&state, &idp, &subject, &sid_a, &[]).await;
    let b = login(&state, &idp, &subject, &unique("kc-sid"), &[]).await;

    let token = sign(&json!({
        "iss": issuer, "aud": CLIENT_ID, "iat": now_secs(), "jti": unique("jti"),
        "sub": subject, "sid": sid_a,
        "events": { "http://schemas.openid.net/event/backchannel-logout": {} },
    }));
    let reply = call_raw(
        &state,
        "POST",
        "/anthropic/v1/auth/backchannel-logout",
        "application/x-www-form-urlencoded",
        format!("logout_token={token}").into_bytes(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    assert_eq!(
        reply.headers.get("cache-control").unwrap(),
        "private, no-store"
    );

    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&a.access_token),
        None,
    )
    .await;
    assert_auth_error(&me, StatusCode::UNAUTHORIZED, "token_revoked");
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&b.access_token),
        None,
    )
    .await;
    assert_eq!(
        me.status,
        StatusCode::OK,
        "other IdP session stays logged in"
    );

    // 只有 sub：吊销该用户全部会话
    let token = sign(&json!({
        "iss": issuer, "aud": CLIENT_ID, "iat": now_secs(), "jti": unique("jti"),
        "sub": subject,
        "events": { "http://schemas.openid.net/event/backchannel-logout": {} },
    }));
    let reply = call_raw(
        &state,
        "POST",
        "/anthropic/v1/auth/backchannel-logout",
        "application/x-www-form-urlencoded",
        format!("logout_token={token}").into_bytes(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&b.access_token),
        None,
    )
    .await;
    assert_auth_error(&me, StatusCode::UNAUTHORIZED, "token_revoked");
}

#[tokio::test]
#[ignore]
async fn admin_role_and_profile() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, _pool) = db_state(&issuer).await;
    let admin = login(
        &state,
        &idp,
        &unique("kc-admin"),
        &unique("sid"),
        &["ip-please-admin"],
    )
    .await;
    assert_eq!(admin.body["user"]["is_admin"], true);
    let player = login(
        &state,
        &idp,
        &unique("kc-player"),
        &unique("sid"),
        &["other"],
    )
    .await;
    assert_eq!(player.body["user"]["is_admin"], false);

    // 非管理员不能强制下线
    let target = player.body["user"]["user_id"].as_str().unwrap().to_string();
    let denied = call(
        &state,
        "POST",
        "/anthropic/v1/admin/sessions/revoke",
        Some(&player.access_token),
        Some(json!({"user_id": target})),
    )
    .await;
    assert_auth_error(&denied, StatusCode::FORBIDDEN, "insufficient_scope");

    // /me 带 IdP 的名字与头像；自定义昵称接口已取消
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&player.access_token),
        None,
    )
    .await;
    assert_eq!(me.status, StatusCode::OK, "{}", me.text);
    assert!(me.body["display_name"]
        .as_str()
        .unwrap()
        .starts_with("玩家 "));
    assert!(me.body["avatar_url"]
        .as_str()
        .unwrap()
        .starts_with("https://avatars.test/"));
    let gone = call(
        &state,
        "POST",
        "/anthropic/v1/me/profile",
        Some(&player.access_token),
        Some(json!({"nickname": "小鱼干"})),
    )
    .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);

    // 管理员强制下线
    let revoked = call(
        &state,
        "POST",
        "/anthropic/v1/admin/sessions/revoke",
        Some(&admin.access_token),
        Some(json!({"user_id": target})),
    )
    .await;
    assert_eq!(revoked.status, StatusCode::OK, "{}", revoked.text);
    assert_eq!(revoked.body["revoked"], 1);
    let me = call(
        &state,
        "GET",
        "/anthropic/v1/me",
        Some(&player.access_token),
        None,
    )
    .await;
    assert_auth_error(&me, StatusCode::UNAUTHORIZED, "token_revoked");
}

#[tokio::test]
#[ignore]
async fn announcements_lifecycle() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, _pool) = db_state(&issuer).await;
    let admin = login(
        &state,
        &idp,
        &unique("kc-admin"),
        &unique("sid"),
        &["ip-please-admin"],
    )
    .await;
    let player = login(&state, &idp, &unique("kc-player"), &unique("sid"), &[]).await;
    let title = format!("<b>维护</b> {}", random_b64url(4));

    let denied = call(
        &state,
        "POST",
        "/anthropic/v1/admin/announcements",
        Some(&player.access_token),
        Some(json!({"title": title, "body": "x"})),
    )
    .await;
    assert_auth_error(&denied, StatusCode::FORBIDDEN, "insufficient_scope");

    let created = call(
        &state,
        "POST",
        "/anthropic/v1/admin/announcements",
        Some(&admin.access_token),
        Some(json!({"title": title, "body": "今晚 22:00\n停机维护", "level": "maintenance"})),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    let id = created.body["announcement_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(id.starts_with("ann_"));
    assert_eq!(
        created.body["title"], title,
        "stored verbatim; the client renders text"
    );

    let public = call(&state, "GET", "/anthropic/v1/announcements", None, None).await;
    assert_eq!(public.status, StatusCode::OK);
    assert_eq!(
        public.headers.get("cache-control").unwrap(),
        "private, no-store"
    );
    let listed = public.body["announcements"].as_array().unwrap();
    let found = listed
        .iter()
        .find(|item| item["announcement_id"] == id.as_str())
        .expect("listed");
    assert!(
        found.get("created_by").is_none(),
        "public view hides admin fields"
    );

    let bad = call(
        &state,
        "POST",
        "/anthropic/v1/admin/announcements",
        Some(&admin.access_token),
        Some(json!({"title": "t", "body": "b", "level": "urgent"})),
    )
    .await;
    assert_detail(&bad, StatusCode::BAD_REQUEST, "The request is invalid.");

    let retired = call(
        &state,
        "POST",
        &format!("/anthropic/v1/admin/announcements/{id}/retire"),
        Some(&admin.access_token),
        None,
    )
    .await;
    assert_eq!(retired.status, StatusCode::OK, "{}", retired.text);
    assert!(retired.body["retired_at"].is_string());

    let public = call(&state, "GET", "/anthropic/v1/announcements", None, None).await;
    assert!(!public.body["announcements"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["announcement_id"] == id.as_str()));

    let admin_list = call(
        &state,
        "GET",
        "/anthropic/v1/admin/announcements?include_retired=1",
        Some(&admin.access_token),
        None,
    )
    .await;
    assert!(admin_list.body["announcements"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["announcement_id"] == id.as_str()));

    let missing = call(
        &state,
        "POST",
        "/anthropic/v1/admin/announcements/ann_doesnotexist0000000000/retire",
        Some(&admin.access_token),
        None,
    )
    .await;
    assert_detail(
        &missing,
        StatusCode::NOT_FOUND,
        "The requested resource was not found.",
    );
    let malformed = call(
        &state,
        "POST",
        "/anthropic/v1/admin/announcements/12345/retire",
        Some(&admin.access_token),
        None,
    )
    .await;
    assert_detail(
        &malformed,
        StatusCode::NOT_FOUND,
        "The requested resource was not found.",
    );
}

// ———————————————————— 无尽模式 ————————————————————

/// 读服务器里的答案（只有测试能这样做）。
async fn current_answer(pool: &sqlx::MySqlPool, run_id: &str) -> Value {
    let text: String =
        sqlx::query_scalar("SELECT state_json FROM ip_please_endless_runs WHERE run_id = ?")
            .bind(run_id)
            .fetch_one(pool)
            .await
            .unwrap();
    serde_json::from_str::<Value>(&text).unwrap()["current"].clone()
}

/// 把当前项目的出现时间往前拨，跳过最短判定时间 / 波次时长。
async fn age_current_item(pool: &sqlx::MySqlPool, run_id: &str) {
    sqlx::query(
        "UPDATE ip_please_endless_runs
         SET state_json = JSON_SET(state_json, '$.current.issued_at_ms', 0) WHERE run_id = ?",
    )
    .bind(run_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn start_run(state: &AppState, token: &str, mode: &str) -> Value {
    let reply = call(
        state,
        "POST",
        "/anthropic/v1/endless/runs",
        Some(token),
        Some(json!({ "mode": mode })),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text);
    reply.body
}

/// 推进一格：旅客按 `correct` 判对 / 判错，波次一个都不点。返回响应。
async fn play_slot(
    state: &AppState,
    pool: &sqlx::MySqlPool,
    token: &str,
    run_id: &str,
    correct: bool,
) -> Value {
    let next = call(
        state,
        "POST",
        &format!("/anthropic/v1/endless/runs/{run_id}/next"),
        Some(token),
        None,
    )
    .await;
    assert_eq!(next.status, StatusCode::OK, "{}", next.text);
    let item = next.body["item"].clone();
    age_current_item(pool, run_id).await;
    if item["item_type"] == "traveler" {
        let text = item.to_string();
        for leaked in ["\"secret\"", "\"ok\"", "\"liar\"", "\"issues\""] {
            assert!(!text.contains(leaked), "{leaked} leaked: {text}");
        }
        let answer = current_answer(pool, run_id).await;
        let ok = answer["secret"]["ok"][0].as_str().unwrap().to_string();
        let decision = if correct {
            ok
        } else if ok == "approve" {
            "deny".to_string()
        } else {
            "approve".to_string()
        };
        let reply = call(
            state,
            "POST",
            &format!("/anthropic/v1/endless/runs/{run_id}/decision"),
            Some(token),
            Some(json!({ "entrant_id": item["entrant"]["entrant_id"], "decision": decision })),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        assert_eq!(reply.body["correct"], correct);
        reply.body
    } else {
        let wave = &item["wave"];
        let payload = if wave["type"] == "rush" {
            json!({ "picks": [] })
        } else {
            json!({ "hits": [] })
        };
        let reply = call(
            state,
            "POST",
            &format!(
                "/anthropic/v1/endless/runs/{run_id}/waves/{}/result",
                wave["wave_id"].as_str().unwrap()
            ),
            Some(token),
            Some(payload),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        reply.body
    }
}

#[tokio::test]
#[ignore]
async fn endless_run_to_three_strikes_and_leaderboard() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, pool) = db_state(&issuer).await;
    let player = login(&state, &idp, &unique("kc-endless"), &unique("sid"), &[]).await;
    let token = player.access_token.clone();

    let unauth = call(
        &state,
        "POST",
        "/anthropic/v1/endless/runs",
        None,
        Some(json!({"mode": "endless"})),
    )
    .await;
    assert_detail(&unauth, StatusCode::UNAUTHORIZED, "Unauthorized");

    let started = start_run(&state, &token, "endless").await;
    let run_id = started["run"]["run_id"].as_str().unwrap().to_string();
    assert!(run_id.starts_with("run_"));
    assert_eq!(started["run"]["status"], "active");
    assert_eq!(started["run"]["next_kind"], "traveler");

    // 同一时间只能有一局
    let again = call(
        &state,
        "POST",
        "/anthropic/v1/endless/runs",
        Some(&token),
        Some(json!({"mode": "endless"})),
    )
    .await;
    assert_detail(
        &again,
        StatusCode::CONFLICT,
        "An endless run is already in progress.",
    );

    // 刷新页面后接着玩：current 返回同一个待处理旅客
    let next = call(
        &state,
        "POST",
        &format!("/anthropic/v1/endless/runs/{run_id}/next"),
        Some(&token),
        None,
    )
    .await;
    let entrant_id = next.body["item"]["entrant"]["entrant_id"]
        .as_str()
        .unwrap()
        .to_string();
    let current = call(
        &state,
        "GET",
        "/anthropic/v1/endless/runs/current",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(
        current.body["item"]["entrant"]["entrant_id"],
        entrant_id.as_str()
    );

    // 太快判定 → 429
    let early = call(
        &state,
        "POST",
        &format!("/anthropic/v1/endless/runs/{run_id}/decision"),
        Some(&token),
        Some(json!({"entrant_id": entrant_id, "decision": "approve"})),
    )
    .await;
    assert_detail(
        &early,
        StatusCode::TOO_MANY_REQUESTS,
        "Too many requests. Please retry later.",
    );
    assert!(early.headers.get("retry-after").is_some());

    // 判对几位，得分只增不减
    let first = play_slot(&state, &pool, &token, &run_id, true).await;
    assert!(first["points"].as_i64().unwrap() >= 60);
    assert_eq!(first["run"]["streak"], 1);
    for _ in 0..3 {
        play_slot(&state, &pool, &token, &run_id, true).await;
    }

    // 判错三次：调离岗位
    let mut last = Value::Null;
    let mut strikes = 0;
    while strikes < 3 {
        let reply = play_slot(&state, &pool, &token, &run_id, false).await;
        if reply.get("correct") == Some(&json!(false)) {
            strikes += 1;
            assert!(reply["citation"]["kind"].is_string());
        }
        last = reply;
    }
    assert_eq!(last["run"]["status"], "ended");
    assert_eq!(last["run"]["end_reason"], "strikes");
    let final_view = &last["final"];
    assert!(final_view["score"].as_i64().unwrap() > 0);
    assert_eq!(
        final_view["ranks"]["endless"].as_i64().map(|r| r >= 1),
        Some(true)
    );

    // 结束后不能再操作；重发最后一次判定仍返回原结果（幂等）
    let after = call(
        &state,
        "POST",
        &format!("/anthropic/v1/endless/runs/{run_id}/next"),
        Some(&token),
        None,
    )
    .await;
    assert_detail(
        &after,
        StatusCode::CONFLICT,
        "The endless run state has changed. Please reload.",
    );
    let none = call(
        &state,
        "GET",
        "/anthropic/v1/endless/runs/current",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(none.status, StatusCode::NOT_FOUND);

    // 排行榜：显示 IdP 名字与头像，不显示 user_id；登录后带「我的排名」
    let board = call(
        &state,
        "GET",
        "/anthropic/v1/endless/leaderboard?board=endless",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(board.status, StatusCode::OK, "{}", board.text);
    let mine = board.body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["me"] == true)
        .expect("my entry is listed")
        .clone();
    assert!(mine["display_name"].as_str().unwrap().starts_with("玩家 "));
    assert!(mine["avatar_url"]
        .as_str()
        .unwrap()
        .starts_with("https://avatars.test/"));
    assert!(mine.get("user_id").is_none());
    assert_eq!(board.body["me"]["score"], final_view["score"]);
    let public = call(
        &state,
        "GET",
        "/anthropic/v1/endless/leaderboard?board=weekly",
        None,
        None,
    )
    .await;
    assert_eq!(public.status, StatusCode::OK);
    assert_eq!(public.body["me"], Value::Null);
    let bad = call(
        &state,
        "GET",
        "/anthropic/v1/endless/leaderboard?board=daily&period=yesterday",
        None,
        None,
    )
    .await;
    assert_detail(&bad, StatusCode::BAD_REQUEST, "The request is invalid.");

    // 新开一局：上一局已结束，可以开
    let second = start_run(&state, &token, "endless").await;
    let second_id = second["run"]["run_id"].as_str().unwrap().to_string();
    let abandoned = call(
        &state,
        "POST",
        &format!("/anthropic/v1/endless/runs/{second_id}/abandon"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(abandoned.status, StatusCode::OK, "{}", abandoned.text);
    assert_eq!(abandoned.body["run"]["end_reason"], "abandon");
}

#[tokio::test]
#[ignore]
async fn inspect_and_quiz_through_the_api() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, pool) = db_state(&issuer).await;
    let player = login(&state, &idp, &unique("kc-inspect"), &unique("sid"), &[]).await;
    let token = player.access_token.clone();
    let started = start_run(&state, &token, "endless").await;
    let run_id = started["run"]["run_id"].as_str().unwrap().to_string();

    // 找到一位有「两个字段」破绽的旅客
    for _ in 0..60 {
        let next = call(
            &state,
            "POST",
            &format!("/anthropic/v1/endless/runs/{run_id}/next"),
            Some(&token),
            None,
        )
        .await;
        let item = next.body["item"].clone();
        age_current_item(&pool, &run_id).await;
        let answer = current_answer(&pool, &run_id).await;
        if item["item_type"] != "traveler" {
            let payload = if item["wave"]["type"] == "rush" {
                json!({"picks": []})
            } else {
                json!({"hits": []})
            };
            call(
                &state,
                "POST",
                &format!(
                    "/anthropic/v1/endless/runs/{run_id}/waves/{}/result",
                    item["wave"]["wave_id"].as_str().unwrap()
                ),
                Some(&token),
                Some(payload),
            )
            .await;
            continue;
        }
        let entrant_id = item["entrant"]["entrant_id"].as_str().unwrap().to_string();
        let pair = answer["secret"]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|i| i["pairs"].as_array().unwrap().clone())
            .find(|p| p.as_array().unwrap().len() == 2);
        let Some(pair) = pair else {
            let ok = answer["secret"]["ok"][0].clone();
            call(
                &state,
                "POST",
                &format!("/anthropic/v1/endless/runs/{run_id}/decision"),
                Some(&token),
                Some(json!({"entrant_id": entrant_id, "decision": ok})),
            )
            .await;
            continue;
        };

        let path = format!("/anthropic/v1/endless/runs/{run_id}/inspect");
        let quiz_path = format!("/anthropic/v1/endless/runs/{run_id}/quiz");
        let too_soon = call(
            &state,
            "POST",
            &quiz_path,
            Some(&token),
            Some(json!({"entrant_id": entrant_id})),
        )
        .await;
        assert_detail(
            &too_soon,
            StatusCode::BAD_REQUEST,
            "The request is invalid.",
        );
        let miss = call(
            &state,
            "POST",
            &path,
            Some(&token),
            Some(json!({"entrant_id": entrant_id, "fields": ["pp.DOB", "pp.EXP"]})),
        )
        .await;
        assert_eq!(miss.body["match"], false, "{}", miss.text);
        let hit = call(
            &state,
            "POST",
            &path,
            Some(&token),
            Some(json!({"entrant_id": entrant_id, "fields": pair})),
        )
        .await;
        assert_eq!(hit.body["match"], true, "{}", hit.text);
        assert!(hit.body["issue"]["kind"].is_string());
        let junk = call(
            &state,
            "POST",
            &path,
            Some(&token),
            Some(json!({"entrant_id": entrant_id, "fields": ["<script>", "pp.DOB"]})),
        )
        .await;
        assert_detail(&junk, StatusCode::BAD_REQUEST, "The request is invalid.");
        let quiz = call(
            &state,
            "POST",
            &quiz_path,
            Some(&token),
            Some(json!({"entrant_id": entrant_id})),
        )
        .await;
        assert_eq!(quiz.status, StatusCode::OK, "{}", quiz.text);
        assert_eq!(quiz.body["exposed"], answer["secret"]["liar"]);

        // 指认过再拒绝：拿到指认加分
        let decided = call(
            &state,
            "POST",
            &format!("/anthropic/v1/endless/runs/{run_id}/decision"),
            Some(&token),
            Some(json!({"entrant_id": entrant_id, "decision": "deny"})),
        )
        .await;
        assert_eq!(decided.body["correct"], true, "{}", decided.text);
        assert_eq!(decided.body["breakdown"]["pointing"], 50);
        // 别人的对局不能碰
        let other = login(&state, &idp, &unique("kc-other"), &unique("sid"), &[]).await;
        let stranger = call(
            &state,
            "POST",
            &format!("/anthropic/v1/endless/runs/{run_id}/next"),
            Some(&other.access_token),
            None,
        )
        .await;
        assert_detail(
            &stranger,
            StatusCode::NOT_FOUND,
            "The requested resource was not found.",
        );
        return;
    }
    panic!("no traveler with a two-field discrepancy in 60 slots");
}

#[tokio::test]
#[ignore]
async fn daily_challenge_is_shared_and_once_per_day() {
    let (issuer, idp) = start_mock_idp(CLIENT_ID).await;
    let (state, pool) = db_state(&issuer).await;
    let a = login(&state, &idp, &unique("kc-daily-a"), &unique("sid"), &[]).await;
    let b = login(&state, &idp, &unique("kc-daily-b"), &unique("sid"), &[]).await;

    let daily = call(
        &state,
        "GET",
        "/anthropic/v1/endless/daily",
        Some(&a.access_token),
        None,
    )
    .await;
    assert_eq!(daily.body["played"], false);
    assert_eq!(daily.body["travelers"], 40);

    let run_a = start_run(&state, &a.access_token, "daily").await["run"]["run_id"]
        .as_str()
        .unwrap()
        .to_string();
    let run_b = start_run(&state, &b.access_token, "daily").await["run"]["run_id"]
        .as_str()
        .unwrap()
        .to_string();
    let first = |token: String, run: String| {
        let state = state.clone();
        async move {
            call(
                &state,
                "POST",
                &format!("/anthropic/v1/endless/runs/{run}/next"),
                Some(&token),
                None,
            )
            .await
            .body["item"]["entrant"]["docs"]
                .clone()
        }
    };
    let docs_a = first(a.access_token.clone(), run_a.clone()).await;
    let docs_b = first(b.access_token.clone(), run_b.clone()).await;
    assert_eq!(docs_a, docs_b, "everyone sees the same daily travelers");

    let played = call(
        &state,
        "GET",
        "/anthropic/v1/endless/daily",
        Some(&a.access_token),
        None,
    )
    .await;
    assert_eq!(played.body["played"], true);
    assert_eq!(played.body["in_progress"], true);

    // 打满 40 位（全部判对）→ 下班
    let mut last = Value::Null;
    for _ in 0..60 {
        last = play_slot(&state, &pool, &a.access_token, &run_a, true).await;
        if last["run"]["status"] == "ended" {
            break;
        }
    }
    assert_eq!(last["run"]["end_reason"], "shift_done");
    assert_eq!(last["run"]["travelers"], 40);
    assert!(last["final"]["ranks"]["daily"].as_i64().is_some());

    let replay = call(
        &state,
        "POST",
        "/anthropic/v1/endless/runs",
        Some(&a.access_token),
        Some(json!({"mode": "daily"})),
    )
    .await;
    assert_detail(
        &replay,
        StatusCode::CONFLICT,
        "Today's daily challenge has already been played.",
    );
    let board = call(
        &state,
        "GET",
        "/anthropic/v1/endless/leaderboard?board=daily",
        None,
        None,
    )
    .await;
    assert!(!board.body["entries"].as_array().unwrap().is_empty());
}
