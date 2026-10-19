-- 推荐：给云同步单独建库 + 独立账号（最小权限），不要复用其它项目的密码。
-- 在服务器上以 MySQL 管理员身份执行：
--   mysql -uroot -p < deploy/init-db.sql
-- 然后把生成的账号填进 /opt/ip-please-sync/.env 的 SYNC_DATABASE_URL：
--   SYNC_DATABASE_URL=mysql://ip_please:<密码>@<主机>:3306/ip_please

CREATE DATABASE IF NOT EXISTS ip_please
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

-- 请替换成强随机密码；账号来源写 '%' 以便容器内访问，也可改成具体网段。
CREATE USER IF NOT EXISTS 'ip_please'@'%' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';

-- 服务启动时会幂等建 ip_please_* 三张表，因此需要 CREATE/INDEX/ALTER。
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER ON ip_please.* TO 'ip_please'@'%';

FLUSH PRIVILEGES;
