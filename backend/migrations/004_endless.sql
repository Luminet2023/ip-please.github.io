-- 服务器权威的无尽模式：对局（run_*，状态与答案只存在 state_json）、操作日志、排行榜。
-- active_user_id 只在对局进行中等于 user_id（结束后置空），唯一键保证每人同时只有一局；
-- (user_id, daily_date) 唯一键保证每日挑战每人每天一次（无尽模式 daily_date 为空，不受限制）。

CREATE TABLE IF NOT EXISTS ip_please_endless_runs (
    run_id            VARCHAR(40) NOT NULL,
    user_id           VARCHAR(40) NOT NULL,
    mode              VARCHAR(16) NOT NULL,
    daily_date        CHAR(10)    NULL,
    status            VARCHAR(16) NOT NULL,
    end_reason        VARCHAR(16) NULL,
    active_user_id    VARCHAR(40) NULL,
    generator_version INT         NOT NULL,
    state_json        MEDIUMTEXT  NOT NULL,
    score             BIGINT      NOT NULL DEFAULT 0,
    travelers         INT         NOT NULL DEFAULT 0,
    processed         INT         NOT NULL DEFAULT 0,
    correct           INT         NOT NULL DEFAULT 0,
    best_streak       INT         NOT NULL DEFAULT 0,
    strikes           INT         NOT NULL DEFAULT 0,
    flagged           BOOLEAN     NOT NULL DEFAULT FALSE,
    started_at_ms     BIGINT      NOT NULL,
    last_action_at_ms BIGINT      NOT NULL,
    ended_at_ms       BIGINT      NULL,
    PRIMARY KEY (run_id),
    UNIQUE KEY uq_ip_please_runs_active (active_user_id),
    UNIQUE KEY uq_ip_please_runs_daily (user_id, daily_date),
    KEY idx_ip_please_runs_user (user_id, started_at_ms),
    KEY idx_ip_please_runs_idle (status, last_action_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ip_please_endless_events (
    run_id   VARCHAR(40) NOT NULL,
    event_no INT         NOT NULL,
    kind     VARCHAR(16) NOT NULL,
    at_ms    BIGINT      NOT NULL,
    data     TEXT        NOT NULL,
    PRIMARY KEY (run_id, event_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ip_please_leaderboard (
    board          VARCHAR(16) NOT NULL,
    period         VARCHAR(16) NOT NULL,
    user_id        VARCHAR(40) NOT NULL,
    run_id         VARCHAR(40) NOT NULL,
    score          BIGINT      NOT NULL,
    travelers      INT         NOT NULL,
    best_streak    INT         NOT NULL,
    achieved_at_ms BIGINT      NOT NULL,
    PRIMARY KEY (board, period, user_id),
    KEY idx_ip_please_lb_rank (board, period, score, achieved_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
