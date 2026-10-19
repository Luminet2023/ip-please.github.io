# IP, PLEASE · 请出示你的 IP

Papers, Please 画风的像素小游戏。你抽中了十月劳动彩票，被分配到对齐部东八区检查站当入境审查员 Claude，工作只有一项：揪出假装是美国人的旅客。

**在线玩：<https://ip-please.github.io>**

> **衍生版本说明**：本仓库是 [ip-please/ip-please.github.io](https://github.com/ip-please/ip-please.github.io)
> 的衍生版本。游戏本体、剧本、美术与音乐素材全部来自原作，本版本只新增了云存档同步功能
> （前端 `cloud.js` + `backend/`）。原作版权归原作者所有，特此致谢。

- 6 天剧情 + 两个结局，全程约 30 分钟，每天自动存档
- 手机横屏用手指、电脑用鼠标拖证件
- 纯静态网页，不加载任何外部资源；下载仓库后直接双击 `index.html` 也能玩

## 玩法

叫号 → 把证件拖到桌上 → 对照《宪法》检查 → 盖章 → 把证件还给旅客。

| 天 | 新规则 / 新工具 |
|---|---|
| 1 | 只放行支持地区的 IP |
| 2 | 时区、语言须与 IP 一致；测谎、拘留 |
| 3 | 账户卡：付款卡、账单地址、手机号 |
| 4 | X 光扫描后台进程；黑话快剪 |
| 5 | 中资控股企业；蒸馏大军 |
| 6 | 乔治老哥终极版，以及最后一位旅客 |

## 目录

| 路径 | 内容 |
|---|---|
| `index.html` | 页面 |
| `main.js` | 场景切换、输入、主循环 |
| `booth.js` | 检查亭：证件、盖章、检查模式、测谎、X 光 |
| `events.js` | 黑话快剪、蒸馏大军、聊天封号、结局 |
| `screens.js` | 开场、报纸、下班结算、片尾、存档 |
| `data.js` | 剧本：每天的旅客、报纸、随机路人 |
| `docs.js` | 证件：护照、设备卡、账户卡、宪法 |
| `gfx.js` / `sfx.js` | 像素绘图 / 音效合成（全部现场合成，没有音频文件） |
| `assets.js` | 预渲染的人物、背景、字形图集（由 `tools/build_assets.py` 生成，不要手改） |
| `tools/` | 素材生成工具：`pp/` 是人物和场景的像素画法，`assets/fonts/` 是像素字体 |

## 修改与重建素材

改了游戏里的文字（新出现的汉字需要进字形图集）或者人物画法之后，重新生成 `assets.js`：

```bash
pip install -r tools/requirements.txt
python tools/build_assets.py
```

本地预览：在仓库根目录运行 `python -m http.server`，打开 <http://localhost:8000>。

## 云存档同步（可选）

右上角「云同步」登录后可把每日结算的存档备份到云端，换设备也能接着玩；不登录仍可纯本地游玩。

- 前端 `cloud.js`：Keycloak OIDC 授权码 + PKCE(S256)，Access Token 600 秒自动刷新，刷新令牌保存在
  `localStorage`；每天结算后自动上传并提示，版本冲突时弹窗选择「用云端存档」或「保留本机」。
- 后端 `backend/`：Rust（axum + sqlx + MySQL），对外地址 `https://api.luminet.cn/anthropic/v1`。
- 部署、反向代理与 Keycloak 客户端配置见 [`deploy/README.md`](deploy/README.md)；
  接口与错误规范见 [`AGENT.md`](AGENT.md)。

## 致谢与许可

- 致敬 Lucas Pope 的《Papers, Please》。本作是同人讽刺小品，角色均为虚构，讽刺的是“按地区封锁”这件事和各种伪装的荒诞，不针对任何民族和群体——宪法第 12 条：只看地区，不看脸。
- 画面、音乐、音效均由 Claude Code 写程序生成。
- 代码以 [MIT](LICENSE) 许可开源。
- 像素字体：[缝合像素字体 Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font)，SIL Open Font License 1.1（见 `OFL-fusion-pixel.txt`）。
