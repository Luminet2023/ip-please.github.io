-- Platform identities use a SHA-256 digest of the exact issuer/app/channel/sub tuple as key.
-- Local user IDs are separate from website accounts, including identical platform subjects.
CREATE TABLE IF NOT EXISTS ip_please_mapp_users (
    identity_key CHAR(64) NOT NULL,
    issuer VARCHAR(128) NOT NULL,
    app_id VARCHAR(255) NOT NULL,
    channel VARCHAR(16) NOT NULL,
    linuxdo_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(40) NOT NULL,
    created_at_ms BIGINT NOT NULL,
    PRIMARY KEY (identity_key),
    UNIQUE KEY uq_ip_please_mapp_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ip_please_mapp_run_sources (
    run_id VARCHAR(40) NOT NULL,
    identity_key CHAR(64) NOT NULL,
    scope_key CHAR(64) NOT NULL,
    PRIMARY KEY (run_id),
    KEY idx_mapp_source_scope (scope_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ip_please_mapp_leaderboard (
    scope_key CHAR(64) NOT NULL,
    board VARCHAR(16) NOT NULL,
    period VARCHAR(16) NOT NULL,
    user_id VARCHAR(40) NOT NULL,
    run_id VARCHAR(40) NOT NULL,
    score BIGINT NOT NULL,
    travelers INT NOT NULL,
    best_streak INT NOT NULL,
    achieved_at_ms BIGINT NOT NULL,
    PRIMARY KEY (scope_key, board, period, user_id),
    KEY idx_mapp_lb_rank (scope_key,board,period,score,achieved_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ip_please_mapp_receipts (
    user_id VARCHAR(40) NOT NULL,
    request_id VARCHAR(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    status INT NOT NULL,
    body MEDIUMTEXT NOT NULL,
    retry_after BIGINT NULL,
    created_at_ms BIGINT NOT NULL,
    PRIMARY KEY (user_id,request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
