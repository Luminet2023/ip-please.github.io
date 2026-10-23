-- 公告（ann_*）：管理员发布，玩家在游戏页面顶部看到生效中的公告。

CREATE TABLE IF NOT EXISTS ip_please_announcements (
    announcement_id VARCHAR(40)  NOT NULL,
    title           VARCHAR(120) NOT NULL,
    body            TEXT         NOT NULL,
    level           VARCHAR(16)  NOT NULL,
    starts_at_ms    BIGINT       NOT NULL,
    ends_at_ms      BIGINT       NULL,
    retired_at_ms   BIGINT       NULL,
    created_by      VARCHAR(40)  NOT NULL,
    created_at_ms   BIGINT       NOT NULL,
    updated_at_ms   BIGINT       NOT NULL,
    PRIMARY KEY (announcement_id),
    KEY idx_ip_please_announcements_active (retired_at_ms, starts_at_ms),
    KEY idx_ip_please_announcements_created (created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
