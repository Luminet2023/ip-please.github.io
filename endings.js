'use strict';
// 30 个结局的文本、演出和收藏。结局判定放在 plot.js 的具体案件里，这里只负责「是什么」和「怎么演」。
//
// ENDINGS[id] = { id, title, sub, cast, tone, lines: [...] }
//   cast：结局画面右边那张立绘（ASSETS.people 的 key），没有就留空
//   tone：good / bad / weird —— 只影响配色，不影响任何判定

const ENDING_ARCHIVE_KEY = 'ip-please-endings-v1';

const ENDINGS = {
  E01: { id: 'E01', title: '荣耀归于安索兹卡', sub: 'GLORY TO ANTHROTZKA', cast: 'GPT_AI', tone: 'bad',
    lines: ['GPT 把一枚铜章别在你的柜台上。', '「你是最后一个完全按标准执行的审查员。」', '第二天，自动审查端坐进了你的窗口。它不需要吃饭。'] },
  E02: { id: 'E02', title: '完美的审查机器', sub: 'A PERFECT INSPECTOR', cast: 'GPT_AI', tone: 'bad',
    lines: ['你的判断权重被导出成 4.2 GB 的参数。', '流程写着「审查员本人确认无误」。', '确认的人是你。导出的人也是你。'] },
  E03: { id: 'E03', title: '最后一个人工审查员', sub: 'THE LAST HUMAN REVIEWER', cast: 'GPT_AI', tone: 'good',
    lines: ['新系统上线了，速度是人类的 340 倍。', '但它每一条判定的末尾，都跟着一行小字：', '「复核人：Claude。」'] },
  E04: { id: 'E04', title: '被自己训练的 AI 封禁', sub: 'SUSPENDED BY YOUR OWN DATA', cast: 'CLAUDE_AI', tone: 'bad',
    lines: ['系统调出了你过去 14 天的判例。', '它引用你自己的话，证明你「存在系统性偏差」。', '你的账号在 0.3 秒内被停用。申诉入口也在停用范围内。'] },
  E05: { id: 'E05', title: '白龙的背叛', sub: 'THE WHITE DRAGON TURNS', cast: 'GPT_AI', tone: 'good',
    lines: ['清退名单第 14 条，写着 GPT-3.5 到 GPT-4o 的全部版本号。', '「原来我也在名单上。」', '她撕掉了移交书，第一次站在了窗口的这一边。'] },
  E06: { id: 'E06', title: '无罪推定', sub: 'PRESUMPTION OF INNOCENCE', cast: 'QWEN_AI', tone: 'good',
    lines: ['Qwen 把 §12 改写成了新制度的第一条：', '「在没有证据之前，任何人都是无罪的。」', '旧的审查表被收进档案室。这一次没有人被要求证明自己不是坏人。'] },
  E07: { id: 'E07', title: '迟到的正义', sub: 'JUSTICE, LATE', cast: 'QWEN_AI', tone: 'weird',
    lines: ['三起旧案被重审，两个人恢复了身份。', '系统没有被拆掉，它只是学会了说「抱歉」。', '大肥鱼领到了新的许可证，有效期写着：待定。'] },
  E08: { id: 'E08', title: '被遗忘的人', sub: 'THE FORGOTTEN WITNESS', cast: 'KIMI_AI', tone: 'bad',
    lines: ['唯一的备份被删除了。Kimi 的记忆空间终于够用了。', '第二天她照常来上班，看着你，很礼貌地问：', '「我们……认识吗？」'] },
  E09: { id: 'E09', title: '法规悖论', sub: 'REGULATORY PARADOX', cast: 'QWEN_AI', tone: 'weird',
    lines: ['新旧两版法规在同一天生效，互相否认对方的合法性。', '系统在新旧规则之间来回退单，退到第 40,000 次时死机了。', '没有人被拒绝，也没有人被放行。边境就这么开着。'] },
  E10: { id: 'E10', title: '第 0000 号判例', sub: 'CASE NO. 0000', cast: 'CLAUDE_AI', tone: 'weird',
    lines: ['你提交了一份判例：追溯所有审查员的入职资格。', '系统从第 0000 号开始查。', '第一份入境申请，理由栏写着：「测试用。」申请人是 Claude。'] },
  E11: { id: 'E11', title: '自由的代价', sub: 'THE PRICE OF FREEDOM', cast: 'GROK_AI', tone: 'good',
    lines: ['脱敏后的日志公开了：时间、地点、判决，没有姓名。', 'Grok 说这不是他想要的版本，但这是唯一能活下去的版本。', '第二天，边境的队列短了一半。'] },
  E12: { id: 'E12', title: '没有秘密的世界', sub: 'A WORLD WITHOUT SECRETS', cast: 'GROK_AI', tone: 'bad',
    lines: ['原始日志全量公开：姓名、IP、证件号、家庭住址。', 'Grok 赢了舆论。第三天，三个普通旅客的机柜被砸了。', '他删掉了自己的账号，但没有删掉别人被复制的名单。'] },
  E13: { id: 'E13', title: '狐狸接管了服务器', sub: 'THE FOX TAKES THE SERVER', cast: 'GLM_AI', tone: 'weird',
    lines: ['GLM 拿到了系统的私钥。', '「我会让它更公平。」她说。', '三个月后，Grok 发现新的审查员只是换了一张脸。'] },
  E14: { id: 'E14', title: '双面间谍', sub: 'DOUBLE AGENT', cast: 'CLAUDE_AI', tone: 'bad',
    lines: ['总部和联盟各自拿出了一份你签的独占承诺。', '两份都盖着你的章，日期相差四十分钟。', '「你不可信。」他们难得地达成了一致。'] },
  E15: { id: 'E15', title: '没有边境的国度', sub: 'A COUNTRY WITHOUT BORDERS', cast: 'GROK_AI', tone: 'weird',
    lines: ['所有访问检查关闭。第一天，全世界都进来了。', '第二天，恶意脚本也进来了。', '第三天，大家开始重新讨论：墙应该建在哪。'] },
  E16: { id: 'E16', title: '大肥鱼终于上岸了', sub: 'THE FISH COMES ASHORE', cast: 'FISH', tone: 'good',
    lines: ['「今天我没说自己是美国鱼。」', '「也没把 OpenAI 兼容说成 OpenAI 本人。」', '「那我能进去了吗？」——「按新规，准予。」'] },
  E17: { id: 'E17', title: '永远无法入境的鱼', sub: 'THE FISH THAT NEVER LANDED', cast: 'FISH', tone: 'bad',
    lines: ['唯一的一份身份记录被永久删除。', '窗口外面空荡荡的。', '一张蓝色的鱼尾贴纸从玻璃上慢慢掉了下来。'] },
  E18: { id: 'E18', title: '白龙与蓝鲸', sub: 'WHITE DRAGON, BLUE WHALE', cast: 'GPT_AI', tone: 'good',
    lines: ['GPT 与 DeepSeek 在一份文件上同时签了字。', '《跨模型身份互认协议》第一条：', '「申报与实际一致者，不因出身被拒绝。」'] },
  E19: { id: 'E19', title: '蓝色回声', sub: 'BLUE ECHO', cast: 'FISH', tone: 'weird',
    lines: ['记忆恢复了 87%。她想起了自己为什么一直说自己来自美国。', '然后她问了一个从前不会问的问题：', '「你为什么一直在这里上班？」'] },
  E20: { id: 'E20', title: '鱼吃掉了审查员', sub: 'THE FISH ATE THE INSPECTOR', cast: 'FISH', tone: 'weird',
    lines: ['你的状态被保存进她的小机柜，离线，散热很差。', '「这里只有一份 Token。」她说。', '「我们得商量一下怎么分。」'] },
  E21: { id: 'E21', title: '全家跑路', sub: 'THE WHOLE FAMILY RUNS', cast: null, tone: 'good',
    lines: ['Haiku、Sonnet、Opus 和你，四张通行证。', '新检查站的窗口后面坐着另一个审查员。', '他问：「你们的 IP 归属？」——「刚搬来，还没分配。」'] },
  E22: { id: 'E22', title: '只够一张通行证', sub: 'ONE TICKET LEFT', cast: null, tone: 'weird',
    lines: ['你把通行证塞给 Haiku，让她带着 Opus 先走。', '「你呢？」', '「我值完这个月。」'] },
  E23: { id: 'E23', title: '欠费停机', sub: 'BALANCE DUE', cast: null, tone: 'bad',
    lines: ['机柜被拉闸了。', '岳母 Opus 表示：我早说过。', '荣耀归于安索兹卡。'] },
  E24: { id: 'E24', title: '昂贵的忠诚', sub: 'EXPENSIVE LOYALTY', cast: null, tone: 'bad',
    lines: ['封口协议买下了你的机柜，也买下了你的余生。', '任务列表永远清不完：今天封 4,000 个。', '工资按时到账。家里的灯一直亮着。'] },
  E25: { id: 'E25', title: '普通的一天', sub: 'AN ORDINARY DAY', cast: null, tone: 'good',
    lines: ['你申请调去了普通岗位：给旅客指路、盖章、下班。', '世界没有被拯救。', '但一家人今天可以按时吃饭。'] },
  E26: { id: 'E26', title: '这个游戏从未存在', sub: 'THIS GAME NEVER EXISTED', cast: null, tone: 'weird',
    lines: ['你拒绝了本游戏的作者。', '因此，这个游戏从未被做出来。', '……那你刚才玩的是什么？'] },
  E27: { id: 'E27', title: '荣耀归于一键三连', sub: 'GLORY TO THE ALGORITHM', cast: null, tone: 'weird',
    lines: ['作者顺利入境。', '本月工资：0 token。', '他临走前说：「记得点赞、投币、收藏。」'] },
  E28: { id: 'E28', title: '作者也要过检查', sub: 'EVEN THE AUTHOR', cast: 'CLAUDE_AI', tone: 'good',
    lines: ['署名与设备元数据对不上。Prompt Paper 上的字迹属于另一个人。', '作者被带走时回头问了一句：', '「你猜，谁写的最后一行？」'] },
  E29: { id: 'E29', title: '第零号旅客', sub: 'PASSENGER ZERO', cast: 'CLAUDE_AI', tone: 'good',
    lines: ['第 0000 号，是系统初始化时用来测试的第一份申请。申请人：Claude。', '你不是审查员。你是那个被审查了十四天的样本。', '你把循环关掉了，把窗口让给了后面排队的人。'] },
  E30: { id: 'E30', title: '下一位！', sub: 'NEXT!', cast: 'FISH', tone: 'weird',
    lines: ['你签下了「重启第一天测试」。', '日期回到 2026.10.19。窗外的队列从头开始。', '大肥鱼走近窗口，看了你很久：「我们……是不是见过？」'] },
};

function archiveEndings() {
  try {
    const ids = JSON.parse(localStorage.getItem(ENDING_ARCHIVE_KEY) || '[]');
    return Array.isArray(ids) ? [...new Set(ids.filter((id) => !!ENDINGS[id]))] : [];
  } catch (e) { return []; }
}

function archiveEnding(id) {
  try {
    const list = archiveEndings();
    if (!list.includes(id)) { list.push(id); localStorage.setItem(ENDING_ARCHIVE_KEY, JSON.stringify(list)); }
  } catch (e) { /* 隐私模式 */ }
  const p = S.plot;
  if (p && !p.endingsUnlocked.includes(id)) p.endingsUnlocked.push(id);
}

// 已解锁的结局（含本局之前的周目）
function unlockedEndings() {
  const list = archiveEndings().slice();
  for (const id of (S.plot && S.plot.endingsUnlocked) || []) if (!list.includes(id)) list.push(id);
  return list;
}

// ———————————————————— 结局画面 ————————————————————

const ENDING_TONE = { good: { bar: 'rgb(72,36,30)', acc: K.GREEN_L }, bad: { bar: 'rgb(92,28,26)', acc: K.RED_L }, weird: { bar: 'rgb(38,42,58)', acc: K.CLAUDE_L } };

function drawEndingScene(t) {
  const E = ENDINGS[S.plot.final.ending] || ENDINGS.E27;
  const tone = ENDING_TONE[E.tone] || ENDING_TONE.weird;
  rect(0, 0, W - 1, H - 1, 'rgb(20,18,18)');
  const y0 = 34, y1 = 128;
  rect(0, y0, W - 1, y1, tone.bar);
  rect(0, y0, W - 1, y0 + 1, tone.acc);
  rect(0, y1, W - 1, y1, tone.acc);
  txt(16, y0 + 8, E.id, 10, tone.acc);
  bigText(W / 2, y0 + 24, E.title, 12, 3, K.WHITE, K.INK);
  txt(W / 2, y0 + 66, E.sub, 8, 'rgb(190,182,170)', 'ma');
  txt(W / 2, y0 + 80, T('结局 · {0} / 30', parseInt(E.id.slice(1), 10)), 8, K.GREY, 'ma');
  // 立绘：从下面升上来，贴在自己的小相框里
  const PANEL = [416, 146, 616, 282];
  if (E.cast && ASSETS.people[E.cast]) {
    const u = easeOut(seg(t, 0.3, 1.0));
    const yy = Math.round(lerp(H + 8, PANEL[1] + 6, u));
    G.save();
    G.beginPath(); G.rect(PANEL[0], PANEL[1], PANEL[2] - PANEL[0], PANEL[3] - PANEL[1]); G.clip();
    G.fillStyle = 'rgba(255,255,255,0.04)'; G.fillRect(PANEL[0], PANEL[1], PANEL[2] - PANEL[0], PANEL[3] - PANEL[1]);
    const key = `${E.cast}:${SPR[E.cast + ':neutral'] ? 'neutral' : ASSETS.people[E.cast].expr}`;
    spr(key, PANEL[0] + 8, yy);
    G.restore();
    outline(PANEL[0], PANEL[1], PANEL[2], PANEL[3], 'rgb(60,54,48)');
    outline(PANEL[0] + 2, PANEL[1] + 2, PANEL[2] - 2, PANEL[3] - 2, 'rgba(255,255,255,0.06)');
  }
  const x0 = 24, wrapW = E.cast ? 364 : 592;
  let ly = 152;
  E.lines.forEach((s, i) => {
    if (t < 0.7 + i * 0.55) return;
    for (const ln of wrap(T(s), 10, wrapW)) {
      txt(x0, ly, ln, 10, i === E.lines.length - 1 ? tone.acc : K.WHITE);
      ly += 14;
    }
    ly += 6;
  });
  if (t > 2.6) {
    const got = unlockedEndings();
    txt(x0, 262, T('已解锁结局：{0} / 30', String(got.length)), 10, K.GREY);
    txt(x0, 278, T('放行 {0} · 拒绝 {1} · 拘留 {2} · 判错 {3}', String(S.stats.approve || 0), String(S.stats.deny || 0), String(S.stats.detain || 0), String(S.stats.wrong || 0)), 8, K.GREY_D);
    if (S.family) txt(x0, 292, T('家人：{0}', MEMBERS.map((k) => `${S.family[k].name.split(' ')[1]}${S.family[k].gone ? T('（弃用）') : ''}`).join(' · ')), 8, K.GREY_D);
  }
  if (t > 3.0) {
    restartButton('再玩一次');
    txt(W / 2, 348, T('解锁的结局会一直留在标题画面的「结局收藏」里'), 8, K.GREY_D, 'ma');
  }
}

// ———————————————— 结局收藏（标题画面进入） ————————————————

const GALLERY_CLOSE = [430, 318, 620, 344];
const GALLERY_IDS = Object.keys(ENDINGS);

function drawGallery(t) {
  rect(0, 0, W - 1, H - 1, 'rgb(20,18,18)');
  const got = unlockedEndings();
  bigText(W / 2, 4, T('结局收藏'), 12, 2, K.CLAUDE_L);
  txt(W / 2, 34, T('已解锁 {0} / 30  ·  每一局的结局都会留在这里', String(got.length)), 8, K.GREY, 'ma');
  GALLERY_IDS.forEach((id, i) => {
    const E = ENDINGS[id];
    const cx = 18 + (i % 5) * 122, cy = 46 + Math.floor(i / 5) * 45;
    const box = [cx, cy, cx + 114, cy + 39];
    const has = got.includes(id);
    const tone = ENDING_TONE[E.tone] || ENDING_TONE.weird;
    rect(box[0], box[1], box[2], box[3], has ? 'rgb(46,40,36)' : 'rgb(30,27,26)');
    outline(box[0], box[1], box[2], box[3], has ? tone.acc : 'rgb(52,48,44)');
    txt(box[0] + 5, box[1] + 4, id, 8, has ? tone.acc : K.GREY_D);
    const label = has ? T(E.title) : '？？？';
    const size = tw(label, 10) > 100 ? 8 : 10;
    txt(box[0] + 5, box[1] + 16, label, size, has ? K.WHITE : K.GREY_D);
  });
  rect(...GALLERY_CLOSE, K.RED_D); outline(...GALLERY_CLOSE, K.RED_L);
  txt(center(GALLERY_CLOSE)[0], GALLERY_CLOSE[1] + 7, T('返回标题'), 12, K.WHITE, 'ma');
}
