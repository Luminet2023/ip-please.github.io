-- 本服务自己的会话（sess_*）、Refresh Token 与玩家资料。
-- 哈希列存小写十六进制，默认排序规则即可（不要用 *_bin，见 001_init.sql 的说明）。
-- 只新增表、不改已有表：迁移每次启动全部重跑，没有版本表。

CREATE TABLE IF NOT EXISTS ip_please_login_attempts (
    state_hash      CHAR(64)     NOT NULL,
    login_challenge VARCHAR(64)  NOT NULL,
    code_verifier   VARCHAR(128) NOT NULL,
    nonce           VARCHAR(64)  NOT NULL,
    redirect_uri    VARCHAR(255) NOT NULL,
    created_at_ms   BIGINT       NOT NULL,
    expires_at_ms   BIGINT       NOT NULL,
    PRIMARY KEY (state_hash),
    KEY idx_ip_please_login_attempts_exp (expires_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ip_please_sessions (
    session_id          VARCHAR(40)  NOT NULL,
    user_id             VARCHAR(40)  NOT NULL,
    subject             VARCHAR(255) NOT NULL,
    idp_sid             VARCHAR(255) NULL,
    is_admin            BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at_ms       BIGINT       NOT NULL,
    last_refresh_at_ms  BIGINT       NOT NULL,
    idle_expires_at_ms  BIGINT       NOT NULL,
    expires_at_ms       BIGINT       NOT NULL,
    revoked_at_ms       BIGINT       NULL,
    revoke_reason       VARCHAR(24)  NULL,
    PRIMARY KEY (session_id),
    KEY idx_ip_please_sessions_user (user_id),
    KEY idx_ip_please_sessions_subject (subject),
    KEY idx_ip_please_sessions_sid (idp_sid),
    KEY idx_ip_please_sessions_exp (expires_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ip_please_refresh_tokens (
    token_hash    CHAR(64)    NOT NULL,
    session_id    VARCHAR(40) NOT NULL,
    created_at_ms BIGINT      NOT NULL,
    expires_at_ms BIGINT      NOT NULL,
    used_at_ms    BIGINT      NULL,
    PRIMARY KEY (token_hash),
    KEY idx_ip_please_refresh_session (session_id),
    KEY idx_ip_please_refresh_exp (expires_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ip_please_profiles (
    user_id       VARCHAR(40) NOT NULL,
    nickname      VARCHAR(64) NOT NULL,
    nickname_set  BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_at_ms BIGINT      NOT NULL,
    PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
