//! 不连库的路由测试：所有在访问数据库之前就返回的路径，都必须是双信封。

mod common;

use axum::http::StatusCode;
use serde_json::json;

use common::*;

#[tokio::test]
async fn missing_token_is_detail_unauthorized() {
    let state = offline_state();
    let reply = call(&state, "GET", "/anthropic/v1/sync/save", None, None).await;
    assert_detail(&reply, StatusCode::UNAUTHORIZED, "Unauthorized");
}

#[tokio::test]
async fn bad_access_token_is_invalid_token() {
    let state = offline_state();
    let reply = call(&state, "GET", "/anthropic/v1/me", Some("not.a.jwt"), None).await;
    assert_auth_error(&reply, StatusCode::UNAUTHORIZED, "invalid_token");

    // IdP 签的 RS256 Token 不再被接受（只认本服务 HS256 AT）
    let idp_token =
        sign(&json!({"sub": "x", "iss": "https://idp.test/realms/t", "exp": now_secs() + 60}));
    let reply = call(
        &state,
        "GET",
        "/anthropic/v1/sync/save",
        Some(&idp_token),
        None,
    )
    .await;
    assert_auth_error(&reply, StatusCode::UNAUTHORIZED, "invalid_token");
}

#[tokio::test]
async fn malformed_json_is_detail_400() {
    let state = offline_state();
    let reply = call_raw(
        &state,
        "POST",
        "/anthropic/v1/auth/login",
        "application/json",
        b"{not json".to_vec(),
    )
    .await;
    assert_detail(&reply, StatusCode::BAD_REQUEST, "The request is invalid.");

    let reply = call(
        &state,
        "POST",
        "/anthropic/v1/auth/login",
        None,
        Some(json!({"login_challenge": "too-short"})),
    )
    .await;
    assert_detail(&reply, StatusCode::BAD_REQUEST, "The request is invalid.");
}

#[tokio::test]
async fn foreign_redirect_uri_is_rejected() {
    let state = offline_state();
    let reply = call(
        &state,
        "POST",
        "/anthropic/v1/auth/login",
        None,
        Some(json!({
            "login_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            "redirect_uri": "https://evil.test/",
        })),
    )
    .await;
    assert_detail(&reply, StatusCode::BAD_REQUEST, "The request is invalid.");
}

#[tokio::test]
async fn malformed_refresh_token_is_token_revoked() {
    let state = offline_state();
    let reply = call(
        &state,
        "POST",
        "/anthropic/v1/auth/refresh",
        None,
        Some(json!({"refresh_token": "junk"})),
    )
    .await;
    assert_auth_error(&reply, StatusCode::UNAUTHORIZED, "token_revoked");
}

#[tokio::test]
async fn backchannel_logout_rejects_junk() {
    let state = offline_state();
    let reply = call_raw(
        &state,
        "POST",
        "/anthropic/v1/auth/backchannel-logout",
        "application/x-www-form-urlencoded",
        b"logout_token=not.a.token".to_vec(),
    )
    .await;
    assert_detail(&reply, StatusCode::BAD_REQUEST, "The request is invalid.");

    let reply = call_raw(
        &state,
        "POST",
        "/anthropic/v1/auth/backchannel-logout",
        "application/x-www-form-urlencoded",
        b"something_else=1".to_vec(),
    )
    .await;
    assert_detail(&reply, StatusCode::BAD_REQUEST, "The request is invalid.");

    // 合法签名但事件不对
    let token = sign(&json!({
        "iss": "https://idp.test/realms/t", "aud": "app_test_client_0001",
        "iat": now_secs(), "sid": "kc-1",
    }));
    let reply = call_raw(
        &state,
        "POST",
        "/anthropic/v1/auth/backchannel-logout",
        "application/x-www-form-urlencoded",
        format!("logout_token={token}").into_bytes(),
    )
    .await;
    assert_detail(&reply, StatusCode::BAD_REQUEST, "The request is invalid.");
}

#[tokio::test]
async fn oversized_body_is_detail_413() {
    let state = offline_state();
    let big = vec![b'a'; 2 * 1024 * 1024];
    let reply = call_raw(
        &state,
        "POST",
        "/anthropic/v1/auth/login",
        "application/json",
        big,
    )
    .await;
    assert_detail(
        &reply,
        StatusCode::PAYLOAD_TOO_LARGE,
        "The request body is too large.",
    );
}

#[tokio::test]
async fn unknown_route_and_method() {
    let state = offline_state();
    let reply = call(&state, "GET", "/anthropic/v1/nope", None, None).await;
    assert_detail(
        &reply,
        StatusCode::NOT_FOUND,
        "The requested resource was not found.",
    );
    let reply = call(&state, "GET", "/anthropic/v1/auth/refresh", None, None).await;
    assert_detail(
        &reply,
        StatusCode::METHOD_NOT_ALLOWED,
        "Method not allowed.",
    );
}

#[tokio::test]
async fn rate_limit_carries_retry_after() {
    let state = offline_state();
    let mut last = None;
    for _ in 0..12 {
        last = Some(
            call(
                &state,
                "POST",
                "/anthropic/v1/auth/login",
                None,
                Some(json!({"login_challenge": "short"})),
            )
            .await,
        );
    }
    let reply = last.unwrap();
    assert_detail(
        &reply,
        StatusCode::TOO_MANY_REQUESTS,
        "Too many requests. Please retry later.",
    );
    assert!(reply.headers.get("retry-after").is_some());
}
