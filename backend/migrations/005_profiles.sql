-- 玩家展示资料：名字与头像来自 IdP 的 ID Token（name / picture），每次登录覆盖。
-- 取代 002 早期版本里的 ip_please_profiles（自定义昵称已取消，那张表不再读写，可手动删除）。

CREATE TABLE IF NOT EXISTS ip_please_player_profiles (
    user_id       VARCHAR(40)  NOT NULL,
    display_name  VARCHAR(64)  NOT NULL,
    avatar_url    VARCHAR(512) NULL,
    updated_at_ms BIGINT       NOT NULL,
    PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
