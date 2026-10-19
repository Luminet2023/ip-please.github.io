-- ip-please 云同步表结构。全部表以 ip_please_ 前缀命名，避免与服务器上其他业务表冲突。
-- 所有对外标识符遵循 AGENT.md 的 Prefix Registry：user_* 为用户，save_* 为云存档快照。
--
-- 注意：不要给这些列加 *_bin 排序规则。MySQL 会把 _bin 列标记为 BINARY 标志，
-- sqlx 会据此把它当作 VARBINARY，导致读取 String 失败。标识符本身是随机后缀，
-- 依赖唯一索引即可，无需大小写敏感排序。

CREATE TABLE IF NOT EXISTS ip_please_users (
    subject       VARCHAR(255) NOT NULL,
    user_id       VARCHAR(40)  NOT NULL,
    created_at_ms BIGINT       NOT NULL,
    PRIMARY KEY (subject),
    UNIQUE KEY uq_ip_please_users_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ip_please_save_slots (
    user_id       VARCHAR(40) NOT NULL,
    save_id       VARCHAR(40) NOT NULL,
    version       BIGINT      NOT NULL,
    day           INT         NOT NULL,
    payload       LONGTEXT    NOT NULL,
    updated_at_ms BIGINT      NOT NULL,
    PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ip_please_save_snapshots (
    save_id       VARCHAR(40) NOT NULL,
    user_id       VARCHAR(40) NOT NULL,
    version       BIGINT      NOT NULL,
    day           INT         NOT NULL,
    payload       LONGTEXT    NOT NULL,
    created_at_ms BIGINT      NOT NULL,
    PRIMARY KEY (save_id),
    UNIQUE KEY uq_ip_please_snapshots_user_version (user_id, version),
    KEY idx_ip_please_snapshots_user_day (user_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
