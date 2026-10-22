<p align="center">
  <a href="https://ip-please-zero.azurpilot.com/"><img src="media/logo.png" width="160" alt="IP, PLEASE：零号档案"></a>
</p>

<h1 align="center">IP, PLEASE：零号档案 · File Zero</h1>

> 基于 [IP, PLEASE](https://ip-please.github.io/) 修改的剧情 Mod。原作：ctnyanya；Mod：茗（[wess09](https://github.com/wess09)）。本版本增加 14 天剧情、证据分支与 30 个结局。

<p align="center">
  <b>简体中文</b> · <a href="README.en.md">English</a>
</p>

<p align="center">
  Papers, Please 画风的像素小游戏。<br>
  你抽中了十月劳动彩票，被分配到对齐部东八区检查站当入境审查员 Claude，工作只有一项：揪出假装是美国人的旅客。
</p>

<p align="center">
  <a href="https://ip-please-zero.azurpilot.com/"><b>▶ 在线玩：零号档案 / File Zero</b></a>
</p>

<p align="center">
  <img src="media/gameplay-zh.gif" width="640" alt="游戏画面：旅客说“Hello, I am 美国人。”，检查发现他的时区是北京时间；测谎时他脱口接上“一百八一杯”，盖上拒绝章后墨镜滑了下来">
  <br>
  <sub>Day 2：“Hello, I am 美国人。”</sub>
</p>

- **14 天剧情 + 30 个结局**，每天自动存档；结局会收进标题画面的「结局收藏」
- 九位 AI 娘旅客：GPT、Qwen、Grok、GLM、Kimi、Gemini、MiniMax、大肥鱼，以及作者本人
- **简体中文 / 繁體中文 / 日本語 / English** 四种语言，开局选择，标题画面右下角随时切换（英文和日文版里本地玩家不熟的梗，在每天报纸的译注里解释）
- 手机横屏用手指、电脑用鼠标拖证件
- 纯静态网页，不加载任何外部资源；下载仓库后直接双击 `index.html` 也能玩

## 英文版

```text
英文版已严肃上线，游戏开局可选择语言。
The English version is now seriously online. Choose your language at the start of the game.
https://ip-please-zero.azurpilot.com/
@DarioAmodei @claudeai @AnthropicAI @dukope
```

## 玩法

叫号 → 把证件拖到桌上 → 对照《宪法》检查 → 盖章 → 把证件还给旅客。

| 天 | 新规则 / 新工具 |
|---|---|
| 1 | 只放行支持地区的 IP |
| 2 | 时区、语言须与 IP 一致；测谎、拘留 |
| 3 | 账户卡：付款卡、账单地址、手机号 |
| 4 | X 光扫描后台进程；黑话快剪 |
| 5 | 中资控股企业；蒸馏大军 |
| 6 | 乔治老哥终极版；模型身份卡 |
| 7 | 不存在的旅客：机房 IP、登录记录 |
| 8 | 两段同样真实的视频：时间码比对 |
| 9 | 被改写的宪法：同日两版法规、申诉复核 |
| 10 | 替代者：《自动审查迁移协议》 |
| 11 | 公开还是保护：脱敏、法规修订 |
| 12 | 审查员的审查：审计单、双规复核 |
| 13 | 只剩一张通行证：家庭迁移、清退令 |
| 14 | 最后一位旅客：终局文书，盖上哪一张就以哪种方式结束 |

### 三个新交互

- **证据处理单**：打印机吐出一张纸，托盘换成三枚「处理章」（默认是 保留 / 上交 / 销毁，也可以被案件改成三个自定义选项）。选完才真正写入 `S.plot.evidence`。
- **个人档案槽**：D1 结束前会多出一张空白小票，拖进桌面左下角的档案槽就收起来，拖回窗口就销毁。第 7 天 Kimi 会因为你当时的选择说不同的话。
- **终局文书**：D14 结束时，满足条件的剧情会把几张写着不同结局的公文摊在桌上，用「准予」章盖哪一份，就走哪一个结局。
- **正式裁定文书**：申诉回执、迁移协议、删除申请、审计、移交、授权和家庭迁移等 18 类事件，必须在对应文书上盖「准予」或「拒绝」章。只盖护照不能结束该事件。证据处理单必须明确选择；条件不足的迁移选项会提示原因并保留处理单。

## 目录

| 路径 | 内容 |
|---|---|
| `index.html` | 页面 |
| `config.js` | Mod 名称、署名、原作链接与独立存储键 |
| `main.js` | 场景切换、输入、主循环 |
| `booth.js` | 检查亭：证件、盖章、检查模式、测谎、X 光 |
| `events.js` | 黑话快剪、蒸馏大军、聊天封号、结局 |
| `screens.js` | 开场、报纸、下班结算、片尾、存档 |
| `i18n.js` | 语言切换 `T()`、折行与行首禁则，以及开局选语言的画面 |
| `en.js` | 英文译文（以中文原句为键）、报纸上的译注、黑话注释 |
| `ja.js` | 日文译文、日文版报纸译注与黑话注释 |
| `zh-hant.js` | 繁體中文译文（繁體字・道地譯法），由 `tools/gen_zh_hant.py` 从 `en.js` 的键自动转出 |
| `data.js` | 剧本：每天的旅客、报纸、随机路人 |
| `plot.js` | 14 天调度、`S.plot` 状态字典、证据处理、结局判定（新增） |
| `endings.js` | 30 个结局的文本与演出、结局收藏画面（新增） |
| `docs.js` | 证件：护照、设备卡、账户卡、宪法、公文/证据单/终局文书 |
| `gfx.js` / `sfx.js` | 像素绘图 / 音效合成（全部现场合成，没有音频文件） |
| `assets.js` | 预渲染的人物、背景、字形图集（由 `tools/build_assets.py` 生成，不要手改） |
| `tools/` | 素材生成工具：`pp/` 是人物和场景的像素画法，`assets/fonts/` 是像素字体；`import_aicast.py` 处理 AI 娘立绘；`check_i18n.js` 一次查四种语言的漏翻、`gen_zh_hant.py` 生成繁體中文譯文、`check_plot_en.js` 查剧情漏翻；`smoke_test.js` 无头跑完 14 天与全部结局判定 |
| `media/` | README 用的 logo、游戏动图，以及本 Mod 的链接分享卡片 `og-file-zero.png` |

## 修改与重建素材

本 Mod 按照原作者的 [CONTRIBUTING.md](https://github.com/ip-please/ip-please.github.io/blob/main/CONTRIBUTING.md) 使用独立名称及存储键。`config.js` 统一定义：

| 数据 | 存储键 |
| --- | --- |
| 剧情存档 | `ip-please-file-zero-save-v1` |
| 结局收藏 | `ip-please-file-zero-endings-v1` |
| 结局快照 | `ip-please-file-zero-last-ending-v1` |
| 语言设置 | `ip-please-file-zero-lang` |

版本不会自动读取或迁移原版及此前共用旧键的数据，旧键数据保留。完成一局、清空当前存档或切换语言都只操作本 Mod 的键。改动存储流程后运行 `node tools/storage_namespace_test.js` 验证隔离。

建议仓库名为 `ip-please-file-zero`。本 Mod 使用 Cloudflare Workers，站点地址为 `https://ip-please-zero.azurpilot.com/`。更换域名时，同步更新 `config.js` 的 `siteUrl`、`index.html` 的 `og:url` / `og:image` 和 README 的游玩链接。

改了游戏里的文字（新出现的汉字需要进字形图集）或者人物画法之后，重新生成 `assets.js`：

```bash
pip install -r tools/requirements.txt
python tools/build_assets.py
```

改了中文台词，要同步改 `en.js` / `ja.js` 里对应的键（中文原句一字不差）。繁體是自动转的，重跑一次生成脚本即可。漏没漏一次查全：

```bash
python tools/gen_zh_hant.py     # 重新生成 zh-hant.js（需要 opencc-python-reimplemented）
node tools/check_i18n.js        # 四种语言：漏翻 + {0} 占位符是否对得上
node tools/check_i18n.js ja     # 只看某一种语言
```

新增的日文假名、繁體字同样要进字形图集，所以改完译文记得重跑 `python tools/build_assets.py`。

提供原图的七位 AI 娘使用 `Ai 资源` 中的立绘，由脚本保留透明通道、裁切并量化成 180×128 的像素立绘和 40×50 的证件照，不重绘。其他角色沿用现有人物素材：

```bash
python tools/import_aicast.py --src "<你存放原图的目录>" --map tools/aicast_expr_map.json
```

剧情改动之后，跑一遍无头冒烟测试（会走完 14 天的队列、所有裁定、证据选择和结局映射）：

```bash
node tools/smoke_test.js
node tools/plot_regression_test.js
```

完整浏览器通关测试使用真实鼠标点击、拖放、检查和盖章，从第一天走到第十四天的 E29 结局；独立浏览器会话不会改动玩家的存档。Windows 默认使用已安装的 Microsoft Edge：

```bash
npm install --no-save --package-lock=false playwright
node tools/browser_playthrough.js --speed=12
node tools/browser_playthrough.js --lang=en --speed=12
node tools/browser_playthrough.js --regressions --speed=12
```

加 `--headed` 可观看自动游玩。每日截图、结局截图和 JSON 报告输出到 `tools/test-results/`。非 Windows 环境先运行 `npx playwright install chromium`。

`--regressions` 用独立场景复现卡片排版、发行主体与宪法比对、对白逐字动画、网络信息、打印来源和人物一致性，可与 `--lang=en` 组合检查英文画面。

**观看全部 30 个结局**：Windows 双击根目录的 `观看所有结局.cmd`。默认不倍速，保留游戏原始时钟、对白与打印动画，结局展示后另停留 8 秒。脚本会依次打开 Edge，使用独立测试存档，从第 1 天开始真实操作到每个结局。每条路线会实际检查、拖放证件、处理证据、裁定文书、购买通行证及签署终局文书。每轮继承本次脚本实际解锁的结局收藏；不写入剧情条件、不调用结局函数。终端按 Ctrl+C 可停止。

```bash
# 默认打开可观看浏览器，以正常速度依次完成全部结局
node tools/browser_all_endings.js
# 只观看一条路线，正常速度；在每位旅客前额外停顿 800 毫秒
node tools/browser_all_endings.js --ending=E21 --pause=800
# 后台并行验收全部结局
node tools/browser_all_endings.js --headless --jobs=4
```

完整通关需要走完各路线的天数，耗时显著多于读取结局预设。结果写到 `tools/test-results/all-endings.html`、`all-endings.json`，每条路线另有 `E01-playthrough.json` 和 `E01-ending.png` 等文件。报告包含沿途裁定、证据选择、日终状态和浏览器异常。`--ending=E30` 会先实际完成 E27 以满足收藏前置条件。

开发验收还应运行 `node tools/source_audit_test.js`。`plot_regression_test.js` 中的 30 组固定状态用例用于单独验证结局判定，`browser_all_endings.js` 用于验证从头游玩的可达性，二者的起点不同。

剧情主角、审计员、家属和 MiniMax 使用固定身份；普通排队旅客才从随机池生成。八位 AI 娘（GPT、Qwen、Grok、GLM、Kimi、Gemini、Claude、MiniMax）使用外部生成并本地裁切的立绘；妻子 Haiku、女儿 Sonnet、岳母 Opus 三位家属是照 Claude 的设计血统重新生成的 6 岁 / 13 岁 / 17 岁版本，各 8 个表情，抠图走 `tools/prep_gen_aicast.py`（棋盘格识别、围洞清理、边缘内收、颜色外扩防白边）。素材导入保留 PNG 透明通道；浏览器回归会检查图集中 88 个 AI 表情，并输出 `zh-all-cast.png` / `en-all-cast.png`。

导入透明立绘后可运行 `python tools/test_aicast.py`，确认透明通道和深色人物细节被保留。

本地预览：在仓库根目录运行 `python -m http.server`，打开 <http://localhost:8000>。

## 致谢与许可

- 基于 [IP, PLEASE](https://ip-please.github.io/) 修改；原作：ctnyanya。Mod：茗（wess09）。
- 致敬 Lucas Pope 的《Papers, Please》。本作是同人讽刺小品，角色均为虚构，讽刺的是“按地区封锁”这件事和各种伪装的荒诞，不针对任何民族和群体——宪法第 12 条：只看地区，不看脸。
- 画面、音乐、音效均由 Claude Code 写程序生成。
- 代码以 [MIT](LICENSE) 许可开源。
- 像素字体：[缝合像素字体 Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font)，SIL Open Font License 1.1（见 `OFL-fusion-pixel.txt`）。
- 大肥鱼形象授权为 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)：可自由共享与改编，须署名、不得用于商业用途、衍生作品以相同方式共享。
- AI 娘立绘 ZipZipPipe
