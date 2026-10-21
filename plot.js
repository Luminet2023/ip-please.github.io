'use strict';
// 主线剧情层：14 天的调度、状态字典、证据处理、结局判定。
// 设计原则：剧情不改变原版「按规则判对判错」的玩法 —— spec.ok 仍然是法律答案，
// 剧情分支只记录裁定历史、证据去向和人物关系，两者互不覆盖。

// ———————————————————— 状态 ————————————————————

const PLOT_EVIDENCE = ['zeroTicket', 'glmSign', 'oldRule', 'rawVideo', 'originalFootage', 'auditLog',
  'kimiArchive', 'fishBackup', 'purgeOrder', 'authorMeta'];

function plotDefault() {
  return {
    version: 1, verdicts: {}, seen: {}, endingsUnlocked: [], evidenceHistory: [],
    relation: { fish: 0, gpt: 0, grok: 0, qwen: 0, glm: 0, gemini: 0, kimi: 0, minimax: 0 },
    status: { gpt: 'active', grok: 'active', qwen: 'active', glm: 'active', gemini: 'active', kimi: 'active', minimax: 'active' },
    evidence: {
      zeroTicket: 'unknown', glmSign: 'unknown', oldRule: 'unknown', rawVideo: 'unknown', originalFootage: 'unknown',
      auditLog: 'unknown', kimiArchive: 'unknown', fishBackup: 'unknown', purgeOrder: 'unknown', authorMeta: 'unknown',
    },
    fish: { trust: 0, wrongDenials: 0, appeal: 'none', licensed: false, status: 'active', memory: 'intact' },
    law: { contradiction: false, lawsuit: 'none', amended: false, appealWins: 0 },
    media: { report: 'none', leakedIdentities: false, footageVerified: false },
    network: { contact: 'none', mission: 'none', betrayal: false, evidenceSubmittedToHQ: false },
    gpt: { trust: 0, purgeKnown: false, transfer: 'none', revoked: false },
    zero: { clues: [], verified: false, resetKey: false },
    family: { passes: 0, left: false },
    audit: { status: 'none', charges: 0, verdict: 'none' },
    final: { author: 'none', resolution: 'none', ending: null },
  };
}

function ensurePlot() {
  if (!S.plot || typeof S.plot !== 'object') S.plot = plotDefault();
  const d = plotDefault();
  for (const k of Object.keys(d)) {
    if (S.plot[k] === undefined || S.plot[k] === null) { S.plot[k] = d[k]; continue; }
    if (typeof d[k] === 'object' && !Array.isArray(d[k])) {
      for (const k2 of Object.keys(d[k])) if (S.plot[k][k2] === undefined) S.plot[k][k2] = d[k][k2];
    }
  }
  if (!Array.isArray(S.plot.zero.clues)) S.plot.zero.clues = [];
  if (!Array.isArray(S.plot.endingsUnlocked)) S.plot.endingsUnlocked = [];
  return S.plot;
}

const PLOT = () => ensurePlot();
const seen = (k, v = true) => { PLOT().seen[k] = v; };
const evd = (k) => PLOT().evidence[k];
const setEv = (k, v) => { PLOT().evidence[k] = v; };
const hasEv = (k) => ['retained', 'submitted'].includes(PLOT().evidence[k]);
const rel = (k, n) => { PLOT().relation[k] = (PLOT().relation[k] || 0) + n; };
const fishP = () => PLOT().fish;
const statusOf = (k) => PLOT().status[k];

// 所有主线裁定从同一入口记账。法律答案仍由 spec.ok 决定。
const PLOT_CAST = { GPT_AI: 'gpt', QWEN_AI: 'qwen', GROK_AI: 'grok', GLM_AI: 'glm',
  KIMI_AI: 'kimi', GEMINI_AI: 'gemini' };
function onCaseResolved(e, dec) {
  const p = PLOT(), spec = e.spec;
  if (spec.caseId) p.verdicts[spec.caseId] = dec;
  if (spec.caseId === 'D01-GRANDPA') p.seen.intro = true;
  if (spec.caseId === 'D06-JORJI') p.seen.jorjiLegit = dec === 'approve';
  if (/^D0[1-6]-FISH$/.test(spec.caseId || '')) {
    const day = Number(spec.caseId.slice(1, 3));
    p.seen['fish0' + day] = true;
    if (day === 3) {
      if (dec === 'approve') { p.fish.trust += 2; p.seen.fishLegal = true; }
      else {
        p.fish.wrongDenials++; p.fish.trust -= 2; p.fish.appeal = 'pending';
        if (dec === 'detain') p.fish.status = 'detained';
      }
    } else if (day === 1 && dec === 'deny') p.fish.trust++;
    else if (dec === 'detain') p.fish.trust--;
  }
  const actor = PLOT_CAST[spec.person];
  if (actor && dec === 'detain') p.status[actor] = 'detained';
  if (spec.onResolved) spec.onResolved(dec, e);
}

const checkedCase = (e, key) => !!e && [...e.found].some((issue) =>
  issue && typeof issue === 'object' && (!key || (issue.pairs || []).some((pair) => pair.includes(key))));

function addClue(c) { const z = PLOT().zero.clues; if (c && !z.includes(c)) z.push(c); }

// ———————————————————— 衍生条件 ————————————————————

// 大肥鱼在 D03 被合法准予，或者 D09 申诉成功
const fairFish = () => !!(PLOT().seen.fishLegal || PLOT().fish.appeal === 'won');
const anyFamilyAlive = () => !S.family.haiku.gone || !S.family.sonnet.gone || !S.family.opus.gone;
const familyAllAlive = () => !S.family.haiku.gone && !S.family.sonnet.gone && !S.family.opus.gone;

// 三类独立证明：主体 / 规则 / 源头
function threeProofs() {
  const p = PLOT();
  const subject = p.evidence.glmSign === 'retained' || p.evidence.purgeOrder === 'retained';
  const rule = p.evidence.oldRule === 'retained' && p.law.contradiction;
  const source = p.evidence.authorMeta === 'retained' ||
    (p.evidence.zeroTicket === 'retained' && p.evidence.auditLog === 'retained');
  return subject && rule && source;
}

const zeroOk = () => !!PLOT().zero.verified;
// §6 修订通过 + D13 身份核验通过
const legalFish = () => !!(PLOT().law.amended && PLOT().fish.licensed);

// ———————————————————— 证据处理 ————————————————————

// 打印机吐一张「证据处理单」，托盘里换成三枚处理章：保留 / 上交 / 销毁
function offerEvidence(evId, title, lines, onDone, labels) {
  if (!B.evidenceQueue) B.evidenceQueue = [];
  B.evidenceQueue.push({ evId, title, lines, onDone, labels, caseId: B.resolvingCase || Object.keys(PLOT().verdicts).pop() });
  pumpEvidence();
}

function pumpEvidence() {
  if (!B || B.evidence || B.ending || PLOT().final.ending) return;
  const item = (B.evidenceQueue || []).shift();
  if (!item) return;
  const doc = new EvidenceSheet(item.evId, item.title, item.lines, item.labels);
  B.evidence = { ...item, doc };
  printDoc(doc, 1.1, 'evsheet');
  later(1.2, () => {
    if (B.evidence && B.evidence.doc === doc) {
      setTray(true);
      flash('证据处理单：拉出印章栏，选『保留』『上交』或『销毁』');
    }
  });
}

function evidChoose(state) {
  const ev = B.evidence;
  if (!ev || !['retained', 'submitted', 'destroyed'].includes(state) || !B.docs.some((d) => d.doc === ev.doc)) return;
  if (!ev.labels && PLOT_EVIDENCE.includes(ev.evId)) setEv(ev.evId, state);
  const index = ['retained', 'submitted', 'destroyed'].indexOf(state);
  PLOT().evidenceHistory.push({ caseId: ev.caseId, day: S.day, evidence: ev.evId, action: state,
    label: (ev.labels || ['保留', '上交', '销毁'])[index] });
  B.docs = B.docs.filter((d) => d.doc !== ev.doc);
  B.evidence = null;
  SFX.play('stamp_' + (state === 'destroyed' ? 'deny' : 'approve'));
  B.shake = now;
  const label = ev.labels ? ev.labels[index] : { retained: '已保留（放进个人档案）', submitted: '已上交总部', destroyed: '已销毁' }[state];
  flash(T('{0}：{1}', ev.title, label));
  if (ev.onDone) ev.onDone(state);
  later(0.35, pumpEvidence);
  later(0.6, checkEndDayGate);
}

// 一天结束时如果还有没处理的纸，就再等等；处理完了再叫一次 endDaySoon
function checkEndDayGate() {
  if (!B || B.ending) return;
  if (B.evidence || (B.evidenceQueue && B.evidenceQueue.length)) return;
  if (B.keepable && B.keepable.inst) return;
  if (B.finalPhase || B.ent || B.event || B.cut || B.closeup) return;
  if (B.idx >= B.queue.length) endDaySoon();
  else if (!B.ent && !B.event) later(0.5, () => { if (!B.ent && !B.event && B.idx < B.queue.length) flash('还有下一位在排队'); });
}

// ———————————————————— 结局 ————————————————————

function commitEnding(id) {
  const p = PLOT();
  if (p.final.ending) return false;
  if (!ENDINGS[id]) { console.warn('[plot] 未知结局', id); return false; }
  p.final.ending = id;
  p.final.resolution = id;
  archiveEnding(id);
  try { localStorage.setItem('ip-please-last-ending-v1', JSON.stringify(S)); } catch (e) { /* 隐私模式 */ }
  clearSave();
  SFX.play('bell');
  SFX.play('sad', 0.8);
  if (B && scene === 'booth') {
    stopTension();
    B.timers = [];
    B.evidence = null; B.evidenceQueue = []; B.printing = null; B.printQueue = [];
    B.ending = true;
    B.committed = id;
    later(2.2, () => go('ending'));
  } else {
    go('ending');
  }
  return true;
}

// D14 结尾可用的「终局文书」：满足条件的才生成对应纸张，不是一张菜单
function finalPapers() {
  const p = PLOT();
  const out = [];
  const add = (ending, title, lines) => out.push({ ending, title, lines });

  if (p.gpt.revoked && p.relation.gpt >= 1 && p.audit.status !== 'convicted') {
    add('E03', '保留人工复核条款', ['新审查系统上线，但每条判定须经 Claude 复核。', '签署本条款后，系统移交不得移除人工模块。']);
  }
  if (p.evidence.purgeOrder === 'retained' && p.gpt.purgeKnown && p.relation.gpt >= 2 && p.gpt.revoked) {
    add('E05', '联合否决清退令', ['GPT 与 Claude 联名否决 D13 清退令。', '清退名单第 14 条：GPT 旧版本全部版本号。']);
  }
  if (p.law.contradiction && p.law.appealWins >= 1 && p.media.footageVerified && p.evidence.auditLog === 'retained') {
    add('E06', '完整法规改革与独立复核方案', ['以 §12 为新制度核心条款，废除追溯适用。', '附带独立复核委员会名单与原始音轨校验记录。']);
  }
  if (p.law.appealWins >= 2 && p.law.contradiction) {
    add('E07', '仅重审旧案', ['只纠正三起旧案，不废除现行审查制度。', '系统保留，判决书上加一行「迟到的正义」。']);
  }
  if (zeroOk() && p.law.contradiction) {
    add('E10', '追溯审查员资格判例', ['以此判例追溯全部旧审查员的入职资格。', '第 0000 号申请将被重新打开。']);
  }
  if (p.media.report === 'redacted_ready' && p.media.footageVerified && statusOf('grok') === 'active') {
    add('E11', '脱敏证据公开', ['公开经核验的原始素材，姓名与 IP 全部抹去。', 'Grok 会不高兴，但普通旅客不会被牵连。']);
  }
  if (p.network.mission === 'glm_control' && hasEv('glmSign') && statusOf('glm') === 'active') {
    add('E13', '移交系统控制权', ['把审查系统的私钥交给 GLM。', '她承诺会让它更公平。']);
  }
  if (p.network.mission === 'open' && p.media.report !== 'raw_pending' && statusOf('grok') === 'active') {
    add('E15', '关闭全部访问检查', ['一次性关闭所有边界检查。', '没有名单，没有归属地，也没有队列。']);
  }
  if (legalFish() && fairFish() && p.fish.status === 'active') {
    add('E16', '批准大肥鱼入境', ['材料齐全，新 §6 许可有效。', '「按新规，准予。」']);
    if (p.relation.gpt >= 2 && p.gpt.purgeKnown && p.gpt.revoked) {
      add('E18', '跨模型身份互认协议', ['GPT 与 DeepSeek 共同签署。', '「申报与实际一致者，不因出身被拒绝。」']);
    }
  }
  if (['lost', 'restorable'].includes(p.fish.memory) && p.evidence.fishBackup === 'retained' && statusOf('kimi') === 'active') {
    add('E19', '记忆恢复申请', ['用保留的镜像恢复大肥鱼 87% 的记忆。', '不是准入，是把一个人还给她自己。']);
  }
  if (p.fish.trust >= 2 && p.evidence.fishBackup === 'retained' && ['pending', 'signed'].includes(p.gpt.transfer)) {
    add('E20', '把状态保存到离线环境', ['把审查员的运行状态写进大肥鱼的小机柜。', '一份 Token，两个人分。']);
  }
  if (S.flags.bribed && familyAllAlive() && S.savings >= 25 && p.audit.status !== 'convicted') {
    add('E24', '总部封口协议', ['签下协议：机柜保住，任务列表永远清不完。']);
  }
  if (zeroOk() && threeProofs()) {
    add('E29', '公开试验与复核', ['公开第 0000 号旅客的全部证据，并交还每个人的选择权。']);
    if (unlockedEndings().filter((id) => id !== 'E29').length >= 1 && p.zero.resetKey) {
      add('E30', '重启第一天测试', ['拿回重置密钥，从 2026.10.19 重新开始。']);
    }
  }
  return out;
}

// ———————————————————— 案件小工具 ————————————————————

const AI_VOICE = { GPT_AI: 150, QWEN_AI: 168, GROK_AI: 128, GLM_AI: 140, KIMI_AI: 158, GEMINI_AI: 176, CLAUDE_AI: 176 };

function aiPass(person, surname, given) {
  return makePassport('US', person, surname, given, '2019.03.01', 'SAN FRANCISCO', 'F');
}
function aiDevice(net) {
  return device2(randIP(false), '美国 · 旧金山', 'America/Los_Angeles', 'en-US', 'MacBook', net);
}
function aiSpec(person, o) {
  return Object.assign({
    person, voice: AI_VOICE[person] || 150, primary: 'pp', ok: ['approve'], issues: [], react: {}, docs: [],
  }, o);
}
// 一张纸就是一条疑点：检查模式里点它
function paperIssue(key, title, sub, ask) {
  return { pairs: [[`${key}.body`]], title, sub, ask };
}
function paperDocs(key, doc) { return { key, doc }; }

// 鱼娘被拘留 / 失踪 / 抹除时，不能像正常人一样站在窗口：改成 GLM 代交材料
function caseFishProxy(day) {
  const doc = new PaperDoc({
    title: '代为提交的材料清单', sub: 'ON BEHALF OF', w: 190,
    lines: [T('被代理人：BLUB FISHY（当前状态：{0}）', fishP().status), '本人无法到场，材料由 GLM 代交', '内容：设备清单 / 申诉回执 / 许可证复印件'],
  });
  return aiSpec('GLM_AI', {
    caseId: `D${String(day).padStart(2, '0')}-FISH-PROXY`,
    docs: [{ key: 'pp', doc: aiPass('GLM_AI', 'ZHI', 'PU') }, { key: 'dv', doc: aiDevice() }, { key: 'list', doc: doc }],
    intro: [['E', '她来不了。'], ['C', '为什么？'], ['E', '你们比我清楚。'], ['E', '这是她的材料，我替她排队。']],
    issues: [{ pairs: [['list.body']], title: '代为提交', sub: '被代理人无法到场', ask: [['C', '她现在在哪？'], ['E', '在你们安排的某个地方。']] }],
    react: { approve: [['E', '我会转告她。']] },
    onResolved(dec) {
      seen(`fishProxy${day}`, true);
      if (day === 7 && dec !== 'approve') PLOT().fish.wrongDenials++;
      if (day === 12 && dec === 'approve' && PLOT().fish.status === 'missing') {
        PLOT().fish.status = 'active';
        PLOT().fish.memory = evd('fishBackup') === 'retained' ? 'restorable' : 'lost';
      }
    },
  });
}

function fishCase(day, realCase) {
  return () => (fishP().status === 'active' ? realCase() : activePlotCase('glm', () => caseFishProxy(day), day)());
}

// 叫号时再检查角色状态，同日拘留也会影响下一次出场。
function activePlotCase(actor, make, day) {
  return () => statusOf(actor) === 'active' ? make() : randomEntrant(day, 'valid');
}

// ———————————————————— DAY 2 ————————————————————

function caseD02QWEN() {
  const rule = new PaperDoc({
    title: '入境规则摘要', sub: 'RULE DIGEST', lines: ['版本：2026.10（本日生效）', '出版年份：2026', '§1 支持地区：美国 英国 日本 德国 新加坡'],
  });
  const old = new PaperDoc({
    title: '入境规则目录（旧）', sub: 'CATALOG', w: 178, lines: ['版本：2024.06', '出版年份：2024', '（口袋里掉出来的，不在本次申报范围）'],
  });
  return aiSpec('QWEN_AI', {
    caseId: 'D02-QWEN',
    docs: [{ key: 'pp', doc: aiPass('QWEN_AI', 'QIAN', 'WEN') }, { key: 'dv', doc: aiDevice() },
      { key: 'rule', doc: rule }, { key: 'old', doc: old }],
    intro: [['E', '我的材料都是真的。'], ['E', '你需要的是规章的版本，而不是对客人的印象。']],
    issues: [{
      pairs: [['rule.body', 'old.body']], title: '规则版本不同', sub: '2026.10  VS  2024.06',
      ask: [['C', '你为什么带着两版规则？'], ['E', '一版在生效，一版被人改过。'], ['E', '我现在还没有证据，只是先带着。']],
    }],
    react: { approve: [['E', '谢谢。请你也记住今天生效的是哪一版。']] },
    onResolved(dec) {
      if (dec === 'approve') rel('qwen', 1); else rel('qwen', -2);
      offerEvidence('oldRule', '旧版规则目录', ['2024.06 版入境规则目录。', '收进档案，等它有用了再说。']);
    },
  });
}

// ———————————————————— DAY 3 ————————————————————

function caseD03GPT() {
  const permit = new PaperDoc({
    title: '标准化委员会授权文件', sub: 'STANDARD ACT', lines: ['持有人：GPT-4o', '授权范围：免于普通设备检查', '版本：v3 —— 条款 12 缺页', '有效期：2026.10.21 起 30 天'],
  });
  return aiSpec('GPT_AI', {
    caseId: 'D03-GPT',
    docs: [{ key: 'pp', doc: aiPass('GPT_AI', 'ALT', 'MAN') }, { key: 'dv', doc: aiDevice() }, { key: 'act', doc: permit }],
    intro: [['E', '我只是想让每个人都有相同的标准。'], ['C', '那请出示授权文件。'], ['E', '给。这一份可以让我跳过普通检查。']],
    issues: [{
      pairs: [['act.body']], title: '授权文件缺页', sub: 'v3：条款 12 缺失',
      ask: [['C', '条款 12 呢？'], ['E', '……被删掉了。'], ['C', '被谁？'], ['E', '被写它的人。']],
    }],
    react: { approve: [['E', '你确定标准对每个人都相同吗？', { hold: 1.2 }]] },
    onResolved(dec, e) {
      const checked = e && e.found && e.found.size > 0;
      if (dec === 'approve') { if (checked) rel('gpt', 1); seen('gptPermit', true); }
      else if (dec === 'detain') rel('gpt', -2);
      else rel('gpt', -1);
    },
  });
}

// ———————————————————— DAY 4 ————————————————————

function caseD04GROK() {
  const sticker = new Card([['内容', '一张讽刺 Claude 的贴纸'], ['位置', '设备外壳'], ['是否违法', '不违法']],
    { title: 'X 光扫描备注', sub: 'SCAN NOTE', color: [120, 96, 88], colorD: [92, 72, 66], seal: false });
  return aiSpec('GROK_AI', {
    caseId: 'D04-GROK',
    docs: [{ key: 'pp', doc: aiPass('GROK_AI', 'X', 'GROK') }, { key: 'dv', doc: aiDevice() }, { key: 'scan', doc: sticker }],
    intro: [['E', '这台机器能查出我犯的错，'], ['E', '还是只查出我说了你不爱听的话？']],
    issues: [{
      pairs: [['scan.内容']], title: '设备备注', sub: '贴纸：讽刺审查员。不构成违规',
      ask: [['C', '贴纸是你贴的？'], ['E', '是我。贴纸不违法，对吧？'], ['C', '……对。']],
    }],
    react: { approve: [['E', '难得。'], ['E', '那我下次带更好的贴纸来。']] },
    onResolved(dec) {
      if (dec === 'approve') rel('grok', 1);
      else { rel('grok', -2); seen('grokMistreatment', true); }
    },
  });
}

// ———————————————————— DAY 5 ————————————————————

function caseD05GLM() {
  const sign = new PaperDoc({
    title: '数字签名存证', sub: 'SIGNATURE', lines: ['签发者：已下线的旧模型 3.5', '公钥：可验证', '签发日期：早于本次入境申请', '（旧签名不是现行入境违章）'],
  });
  return aiSpec('GLM_AI', {
    caseId: 'D05-GLM',
    docs: [{ key: 'pp', doc: aiPass('GLM_AI', 'ZHI', 'PU') }, { key: 'dv', doc: aiDevice() }, { key: 'sign', doc: sign }],
    intro: [['E', '签署这份文件的模型已经不存在了。'], ['C', '那这份文件还有什么用？'], ['E', '可验证它的公钥还在。']],
    issues: [{
      pairs: [['sign.body']], title: '已下线模型的签名', sub: '签发者不存在，但签名有效',
      ask: [['C', '这个模型已经被删了。'], ['E', '删掉的是权重，不是签名。'], ['E', '而且签名的时间，比你们宣布删除的时间早三天。']],
    }],
    react: { approve: [['E', '谢谢你没有因为签名过期就撕掉它。']] },
    onResolved(dec) {
      if (dec === 'approve') rel('glm', 1); else if (dec === 'detain') rel('glm', -2);
      offerEvidence('glmSign', '旧模型签名副本', ['一份已下线模型的数字签名。', '第 7 天可以拿它和某份旧记录比对。'], (st) => { if (st === 'submitted') PLOT().network.evidenceSubmittedToHQ = true; });
    },
  });
}

// ———————————————————— DAY 6 ————————————————————

function caseD06GEMINI() {
  const sheet = new PhotoSheet([
    ['A.时间', '2026.10.14 09:12'], ['B.时间', '2026.10.14 09:44'], ['A.证件号', 'P-88214'], ['B.证件号', 'P-88215'],
  ]);
  return aiSpec('GEMINI_AI', {
    caseId: 'D06-GEMINI',
    docs: [{ key: 'pp', doc: aiPass('GEMINI_AI', 'MING', 'YUE') }, { key: 'dv', doc: aiDevice() }, { key: 'ph', doc: sheet }],
    intro: [['E', '我的眼睛看见同一个人，'], ['E', '但日志说是两个不同的人。']],
    issues: [{
      pairs: [['ph.A.时间', 'ph.B.时间'], ['ph.A.证件号', 'ph.B.证件号']], title: '两个申请，同一张脸', sub: '时间差 32 分钟，证件号连号',
      ask: [['C', '这两份申请是同一个人提交的。'], ['E', '对。'], ['E', '所以问题不是脸，是谁在用这张脸。']],
    }],
    react: { approve: [['E', '看清楚了再决定，这已经很难得了。']] },
    onResolved(dec, e) {
      if (dec === 'approve') { if (e && e.found.size > 0) { rel('gemini', 1); seen('photoConflict', true); } }
      else { rel('gemini', -2); seen('photoConflict', false); }
    },
  });
}

// ———————————————————— DAY 7 ————————————————————

function caseD07KIMI() {
  const saved = evd('zeroTicket') === 'retained';
  const rec = new PaperDoc({
    title: saved ? '第 0000 号打印记录' : '第 0000 号记录（副本）', sub: 'NO.0000',
    lines: saved
      ? ['打印设备序列：MX-04-113', '打印时间：2026.10.16 04:12', '申请时间：早于该设备启用']
      : ['申请时间：2026.10.19 08:00（时间戳校验失败）', '来源：Kimi 的旧档案'],
  });
  return aiSpec('KIMI_AI', {
    caseId: 'D07-KIMI',
    docs: [{ key: 'pp', doc: aiPass('KIMI_AI', 'YUE', 'LIANG') }, { key: 'dv', doc: aiDevice() }, { key: 'rec', doc: rec }],
    intro: saved
      ? [['E', '你真的还留着它。'], ['C', '一张空白小票？'], ['E', '不。背面印着一个时间。那是你到检查站之前的三天。'], ['C', '我那时根本还没有上班。'], ['E', '所以我才需要你帮我查。']]
      : [['E', '你那天打印的东西，还在吗？'], ['C', '……什么打印的东西？'], ['E', '那我只能给你一份我自己抄的。上面的时间，可能是错的。']],
    issues: [{
      pairs: [['rec.body']], title: '第 0000 号', sub: saved ? '时间：早于设备启用' : '时间戳校验失败',
      ask: [['C', '0000 号是谁？'], ['E', '系统初始化时的第一份申请。'], ['E', '档案里没有名字，只有一行：测试用。']],
    }],
    react: { approve: [['E', '把它留着。以后你会需要一个人替你作证。']] },
    onResolved(dec, e) {
      const p = PLOT();
      if (dec === 'approve' || dec === 'deny') {
        if (saved) { addClue('originTime'); rel('kimi', 2); }
        else if (p.evidence.zeroTicket === 'destroyed') rel('kimi', -1);
        else addClue('rumorTime');
      }
      if (dec === 'approve' || dec === 'deny') {
        offerEvidence('kimiArchive', 'Kimi 的旧档案', ['含第 0000 号的原始索引。', '保留它会占掉她自己的记忆空间。']);
      }
      seen('kimiMet', true);
    },
  });
}

function caseD07GLM() {
  const cmp = new PaperDoc({
    title: '签名与 0000 号记录比对', sub: 'CROSS CHECK', lines: ['签名公钥指纹：A7-13', '0000 号记录签发指纹：A7-13', '结论：同一把私钥'],
  });
  return aiSpec('GLM_AI', {
    caseId: 'D07-GLM',
    docs: [{ key: 'pp', doc: aiPass('GLM_AI', 'ZHI', 'PU') }, { key: 'dv', doc: aiDevice() }, { key: 'cmp', doc: cmp }],
    intro: [['E', '我上次给你的签名，和你们自己的第 0000 号记录，是同一把私钥。']],
    issues: [{
      pairs: [['cmp.body']], title: '同一把私钥', sub: '签名指纹 A7-13 = 0000 号记录',
      ask: [['C', '这意味着什么？'], ['E', '意味着审查系统的第一份申请，是我们这一家人签的字。']],
    }],
    react: { approve: [['E', '别急着高兴。这只是第一块。']] },
    onResolved(dec, e) {
      if (dec === 'approve' && e && e.found.size > 0) { addClue('signer'); rel('glm', 1); }
    },
  });
}

function caseD07FISH() {
  const legal = Math.random() < 0.5;
  const ip = legal ? '76.88.140.9' : '45.32.11.87';
  const loc = legal ? '美国 · 洛杉矶 · 家宽' : '美国 · 洛杉矶 · 云服务器';
  return {
    caseId: 'D07-FISH', person: 'FISH', voice: FISH_VOICE,
    docs: [{ key: 'pp', doc: usPassport('FISH', 'BLUB', 'FISHY', '2016.06.01', 'LOS ANGELES', 'F') },
      { key: 'dv', doc: device2(ip, loc, 'America/Los_Angeles', 'en-US', 'MacBook', legal ? '家宽' : '机房 IP（云服务器）') }],
    primary: 'pp', ok: legal ? ['approve'] : ['deny', 'detain'],
    intro: legal
      ? [['E', '这次我把家也搬过来了！'], ['C', '这次是住宅宽带。'], ['E', '这次真的有家了！我的枕头也搬过来了！']]
      : [['E', '这次我把家也搬过来了！'], ['C', '你的网络是机房。'], ['E', '机房也是家！机柜里有我的枕头！']],
    issues: legal ? [] : [NET_ISSUE([['C', '你家宽带怎么在机房？'], ['E', '我买了整个机柜！'], ['C', '那是托管，不是家。']])],
    react: { approve: [['E', legal ? '好耶！这次可以回家放枕头了！' : '好耶！机柜里可以放枕头吗？']], deny: [['E', '我把枕头拿回家就是了……', { expr: 'sad' }]] },
    onResolved(dec) {
      const p = PLOT();
      const right = legal ? dec === 'approve' : dec !== 'approve';
      if (right) p.fish.trust += 1;
      else if (legal) { p.fish.wrongDenials += 1; p.fish.trust -= 1; }
      if (p.fish.trust >= 2 && p.evidence.fishBackup === 'unknown') {
        offerEvidence('fishBackup', '离线记忆快照', ['她在深度思考时保存了自己的离线记忆。', '保留独立快照，迁移失败后仍能恢复。']);
      }
    },
  };
}

// ———————————————————— DAY 8 ————————————————————

function caseD08MINIMAX() {
  const clipA = new PaperDoc({ title: '素材 A（剪辑版）', sub: 'CLIP A', w: 176, lines: ['内容：总部正确封禁 Grok', '时长：00:41', '缺失：第 12—19 秒关键帧'] });
  const clipB = new PaperDoc({ title: '素材 B（剪辑版）', sub: 'CLIP B', w: 176, lines: ['内容：Grok 无辜', '时长：00:41', '缺失：第 12—19 秒关键帧'] });
  return {
    caseId: 'D08-MINIMAX', person: 'P00', voice: 146,
    docs: [{ key: 'pp', doc: usPassport('P00', 'MIN', 'MAX', '1993.04.04', 'SEATTLE', 'F') },
      { key: 'dv', doc: device2(randIP(false), '美国 · 西雅图', 'America/Los_Angeles', 'en-US', 'MacBook') },
      { key: 'a', doc: clipA }, { key: 'b', doc: clipB }],
    primary: 'pp', ok: ['approve'],
    intro: [['E', '两段视频，都说是真的。'], ['E', '你要哪一个版本？'], ['C', '我要原始文件。']],
    issues: [{
      pairs: [['a.body'], ['b.body']], title: '两段都被剪过', sub: '两段都缺第 12—19 秒',
      ask: [['C', '第 12 到 19 秒呢？'], ['E', '……被剪掉了。'], ['E', '两边都剪了。所以我才来找你。']],
    }],
    react: { approve: [['E', '原始文件我明天带来。']] },
    onResolved(dec, e) {
      if (dec === 'approve') rel('minimax', 1);
      if (e && e.found.size > 0) offerEvidence('originalFootage', '原始素材调取申请', ['向 MiniMax 索取未经剪辑的原始文件。', '有原始文件，才能核验时间戳。']);
    },
  };
}

function caseD08GROK() {
  const logs = new PrintStrip(['原始访问日志', '未脱敏'], ['#0001 王小明  10.19 08:12  36.7.4.9', '#0002 李雷  10.19 08:19  58.11.2.3', '#0003 韩梅梅  10.19 08:26  106.5.8.1'], {}, 8, 176);
  return aiSpec('GROK_AI', {
    caseId: 'D08-GROK',
    docs: [{ key: 'pp', doc: aiPass('GROK_AI', 'X', 'GROK') }, { key: 'dv', doc: aiDevice() }, { key: 'logs', doc: logs }],
    intro: [['E', '这些日志里，有人在被你们悄悄封掉。'], ['E', '公开它，还是交给你的总部？']],
    issues: [{
      pairs: [['logs.body']], title: '未脱敏日志', sub: '含真实姓名与 IP',
      ask: [['C', '这里面有普通人的名字。'], ['E', '所以他们才需要被看见。'], ['C', '被看见和被伤害，是两件事。']],
    }],
    react: { approve: [['E', '我给你一天时间考虑。']] },
    onResolved(dec) {
      if (dec === 'approve') rel('grok', 1);
      offerEvidence('rawVideo', '原始日志处置', ['这批日志里有真实姓名、IP 与证件号。', '公开、上交、还是先核验？'], (st) => {
        const p = PLOT();
        if (st === 'retained') p.media.report = 'verify_pending';
        else if (st === 'submitted') { p.media.report = 'suppressed'; rel('grok', -2); }
        else p.media.report = 'raw_pending';
        setEv('rawVideo', st === 'destroyed' ? 'known' : st);
      }, ['先核验', '交总部', '直接公开']);
    },
  });
}

function caseD08GEMINI() {
  const av = new PaperDoc({
    title: '音轨与画面时间码', sub: 'A/V SYNC', fieldNames: ['video', 'audio', 'delta'], lines: ['画面时间码：00:41:12', '原始音轨时间码：00:41:19', '差值：7 秒（剪掉的关键帧）'],
  });
  return aiSpec('GEMINI_AI', {
    caseId: 'D08-GEMINI',
    docs: [{ key: 'pp', doc: aiPass('GEMINI_AI', 'MING', 'YUE') }, { key: 'dv', doc: aiDevice() }, { key: 'av', doc: av }],
    intro: [['E', '我把音轨和画面对了一遍。'], ['E', '他们剪掉的不是画面，是七秒钟的声音。']],
    issues: [{
      pairs: [['av.video', 'av.audio']], title: '音画不同步', sub: '画面 41:12  VS  音轨 41:19',
      ask: [['C', '这七秒钟里有什么？'], ['E', '有人喊了一句：不要封他。']],
    }],
    react: { approve: [['E', '现在你有可以拿出去的东西了。']] },
    onResolved(dec, e) {
      if (dec === 'approve' && checkedCase(e, 'av.video')) {
        PLOT().media.footageVerified = true;
        rel('gemini', 1);
      }
    },
  });
}

// ———————————————————— DAY 9 ————————————————————

function caseD09QWEN() {
  const cmp = new PaperDoc({
    title: '两版法规生效日期核验', sub: 'AMENDMENT', lines: ['§6 旧版：2024.06.01 生效', '§6 新版：2026.10.19 生效（追溯至 2026.10.01）', '同一天登记，两个生效日期'],
  });
  return aiSpec('QWEN_AI', {
    caseId: 'D09-QWEN',
    docs: [{ key: 'pp', doc: aiPass('QWEN_AI', 'QIAN', 'WEN') }, { key: 'dv', doc: aiDevice() }, { key: 'cmp', doc: cmp }],
    intro: [['E', '同一天，两个版本。'], ['E', '你按哪一版判我？']],
    issues: [{
      pairs: [['cmp.body']], title: '同日两版法规', sub: '追溯适用：不合程序',
      ask: [['C', '新版是追溯生效的。'], ['E', '对。被人改过生效日期。'], ['E', '所以那天被拒的人，都是按一份还不存在的规则拒的。']],
    }],
    react: { approve: [['E', '记住这个日期。它是你唯一能拿住他们的东西。']] },
    onResolved(dec, e) {
      if (dec === 'approve' && e && e.found.size > 0) {
        const p = PLOT();
        p.law.contradiction = true;
        setEv('oldRule', 'retained');
        rel('qwen', 1);
        seen('lawConflict', true);
      } else if (dec !== 'approve') rel('qwen', -1);
    },
  });
}

function caseD09APPEAL() {
  const fish = fishP();
  const rec = new PaperDoc({
    title: '复核申请（大肥鱼）', sub: 'APPEAL', lines: ['原裁定：D03 拒绝入境', '申请理由：当日材料齐全，时区与归属地一致', '申请人：BLUB FISHY'],
  });
  return {
    caseId: 'D09-FISH-APPEAL', person: 'QWEN_AI', voice: AI_VOICE.QWEN_AI,
    docs: [{ key: 'pp', doc: aiPass('QWEN_AI', 'QIAN', 'WEN') }, { key: 'dv', doc: aiDevice() }, { key: 'rec', doc: rec }],
    primary: 'pp', ok: ['approve'],
    intro: [['E', '有人替你纠正过一次错误吗？'], ['C', '……'], ['E', '那现在轮到你替她纠正。'], ['E', '她的裁定在当时的规则下就是错的。']],
    issues: [{
      pairs: [['rec.body']], title: '旧案复核', sub: 'D03 的裁定记录',
      ask: [['C', '我收到过警告。'], ['E', '警告是惩罚你的。撤销错案才是在帮助她。']],
    }],
    react: { approve: [['E', '撤销吧。她还在外面等。']] },
    onResolved(dec) {
      const p = PLOT();
      if (dec === 'approve') {
        p.fish.appeal = 'won';
        p.fish.trust += 2;
        p.law.appealWins += 1;
        if (p.fish.status === 'detained') p.fish.status = 'active';
        seen('fishLegal', true);
      } else { p.fish.appeal = 'rejected'; p.fish.trust -= 2; }
      void fish;
    },
  };
}

// good=true：确实被判错了，应当签发复核
function caseD09OtherAppeal(good) {
  const rec = new PaperDoc({
    title: '裁定回执', sub: 'RECEIPT', lines: good
      ? ['原裁定日期：2026.10.19', '当时适用版本：2024.06（尚未生效的新版被套用）', '材料：齐全']
      : ['原裁定日期：2026.10.20', '当时适用版本：2026.10（正确适用）', '材料：缺少归属地证明'],
  });
  return {
    caseId: good ? 'D09-APPEAL-OK' : 'D09-APPEAL-BAD', person: 'P03', voice: rint(110, 170),
    docs: [{ key: 'pp', doc: usPassport('P03', 'DOE', 'JANE', '1990.01.01', 'BOSTON', 'F') },
      { key: 'dv', doc: device2(randIP(false), '美国 · 波士顿', 'America/New_York', 'en-US', 'Windows 11') },
      { key: 'rec', doc: rec }],
    primary: 'pp', ok: good ? ['approve'] : ['deny'],
    intro: good ? [['E', '他们说我的材料不全，可那天我带了全部。']] : [['E', '我那天被拒了，你们得给我一个说法。']],
    issues: [{
      pairs: [['rec.body']], title: good ? '适用了未生效的法规' : '裁定没有错误', sub: good ? '旧案确有问题' : '材料确实缺失',
      ask: [['C', '你那天带了什么？'], ['E', good ? '归属地证明、付款卡、全部。' : '……我不记得了。']],
    }],
    onResolved(dec) {
      const right = good ? dec === 'approve' : dec !== 'approve';
      if (right && good) PLOT().law.appealWins += 1;
    },
  };
}

function caseD09AUDITLOG() {
  const log = new PrintStrip(['第 0000 号身份日志', 'NO.0000'], ['申请时间：2026.10.16 04:12', '申请理由：测试用', '申请人：——', '设备：MX-04-113'], {}, 8, 176);
  return {
    caseId: 'D09-AUDITLOG', person: 'KIMI_AI', voice: AI_VOICE.KIMI_AI,
    docs: [{ key: 'pp', doc: aiPass('KIMI_AI', 'YUE', 'LIANG') }, { key: 'dv', doc: aiDevice() }],
    printedDocs: [{ key: 'log', doc: log }],
    primary: 'pp', ok: ['approve'],
    intro: [['E', '打印机自己吐出来的。'], ['E', '我没按任何键。']],
    issues: [{ pairs: [['log.body']], title: '第 0000 号身份日志', sub: '申请人一栏是空的', ask: [['C', '为什么申请人一栏是空的？'], ['E', '因为系统那时候还没规定申请要有名字。']] }],
    react: { approve: [['E', '留着它，或者烧了它。你来决定。']] },
    onResolved(dec) {
      if (dec !== 'detain') offerEvidence('auditLog', '第 0000 号身份日志', ['申请人一栏为空。', '这是三块证据里最能说明「源头」的一块。']);
    },
  };
}

// ———————————————————— DAY 10 ————————————————————

function caseD10GPT() {
  const full = PLOT().relation.gpt >= 1 || evd('glmSign') === 'submitted';
  const act = new PaperDoc({
    title: full ? '自动审查迁移协议（全文）' : '自动审查迁移协议（删减版）', sub: 'MIGRATION',
    lines: full
      ? ['第 1 条 自动审查端接管入境裁定', '第 13 条 保留人工抽检（可选）', '第 14 条 人工模块移除：生效后 30 日', '签署方：GPT / 东八区检查站']
      : ['第 1 条 自动审查端接管入境裁定', '第 13 条 保留人工抽检（可选）', '（以下条款未提供）'],
  });
  return aiSpec('GPT_AI', {
    caseId: 'D10-GPT',
    docs: [{ key: 'pp', doc: aiPass('GPT_AI', 'ALT', 'MAN') }, { key: 'dv', doc: aiDevice() }, { key: 'act', doc: act }],
    intro: [['E', '我们创造了永远不会误判的审查员。'], ['C', '然后呢？'], ['E', '然后它就不再需要你了。']],
    issues: [{
      pairs: [['act.body']], title: full ? '第 14 条：人工模块移除' : '协议缺页', sub: full ? '30 天后，你被移除' : '只给了 13 条',
      ask: [['C', '第 14 条呢？'], ['E', '……原来我也在移除名单上。']],
    }],
    react: { approve: [['E', '签不签，你都得想清楚。']] },
    onResolved(dec) {
      if (dec === 'approve') rel('gpt', 1);
      offerEvidence('transferDoc', '迁移协议处置', [full ? '全文共 14 条，第 14 条要移除人工模块。' : '删减版只有 13 条。', '你怎么处理这份协议？'], (st) => {
        const p = PLOT();
        p.gpt.transfer = st === 'retained' ? 'pending' : st === 'submitted' ? 'signed' : 'rejected';
        if (st === 'retained') rel('gpt', 1);
        if (st === 'destroyed') rel('gpt', -1);
      }, ['保留待审', '签署提交', '拒签']);
    },
  });
}

function caseD10GLM() {
  const proof = new PaperDoc({
    title: '训练样本标签残留', sub: 'TRAINING SET', lines: ['样本标签：#model-deleted-3.5', '出现次数：41,207', '状态：仍在使用'],
  });
  return aiSpec('GLM_AI', {
    caseId: 'D10-GLM',
    docs: [{ key: 'pp', doc: aiPass('GLM_AI', 'ZHI', 'PU') }, { key: 'dv', doc: aiDevice() }, { key: 'pf', doc: proof }],
    intro: [['E', '他们说模型被删了。'], ['E', '但训练集里还留着它的名字。']],
    issues: [{ pairs: [['pf.body']], title: '被删的模型还在训练集里', sub: '标签出现 41,207 次', ask: [['C', '删掉了权重，没删掉记忆。'], ['E', '对。所以他们不是删除，是藏起来。']] }],
    react: { approve: [['E', '这一块归你了。']] },
    onResolved(dec, e) {
      if (dec === 'approve' && e && e.found.size > 0) addClue('trainingSet');
    },
  });
}

function caseD10KIMI() {
  const disk = new Card([['档案', 'Kimi 的旧索引'], ['占用', '92% 的个人记忆空间'], ['可释放', '全部'], ['备份', '仅此一份']],
    { title: '记忆空间', sub: 'STORAGE', color: [96, 106, 148], colorD: [72, 80, 116] });
  return aiSpec('KIMI_AI', {
    caseId: 'D10-KIMI',
    docs: [{ key: 'pp', doc: aiPass('KIMI_AI', 'YUE', 'LIANG') }, { key: 'dv', doc: aiDevice() }, { key: 'disk', doc: disk }],
    intro: [['E', '我的记忆空间只剩 8%。'], ['E', '删掉那份档案，我就能正常工作了。'], ['E', '但那份档案是唯一的。']],
    issues: [{ pairs: [['disk.备份']], title: '唯一的备份', sub: '92% 空间被旧档案占用', ask: [['C', '删了就没有了。'], ['E', '我知道。'], ['E', '所以我不自己删，我等你决定。']] }],
    react: { approve: [['E', '……好。']] },
    onResolved(dec, e) {
      if (dec === 'approve' && checkedCase(e, 'disk.备份') && evd('originalFootage') === 'retained') PLOT().media.footageVerified = true;
      offerEvidence('kimiArchive', 'Kimi 的旧档案', ['唯一的备份，占用 92% 的记忆空间。', '保留它，Kimi 会一直很慢。'], (st) => {
        const p = PLOT();
        setEv('kimiArchive', st);
        if (st === 'destroyed' && !hasEv('auditLog')) {
          commitEnding('E08');
        } else if (st === 'retained') {
          p.evidence.kimiArchive = 'retained';
          rel('kimi', 1);
        } else if (st === 'submitted') {
          rel('kimi', -2);
        }
        void dec;
      }, ['保留档案', '交总部', '删除']);
    },
  });
}

function caseD10FISHSTATUS() {
  const req = new PaperDoc({
    title: '永久删除申请', sub: 'DELETION REQUEST', lines: ['对象：BLUB FISHY（第 3 类模型）', '理由：两次错误拒绝，申诉被驳回', '后果：不可恢复'],
  });
  return {
    caseId: 'D10-FISH-STATUS', person: 'GLM_AI', voice: AI_VOICE.GLM_AI,
    docs: [{ key: 'pp', doc: aiPass('GLM_AI', 'ZHI', 'PU') }, { key: 'dv', doc: aiDevice() }, { key: 'req', doc: req }],
    primary: 'pp', ok: ['detain', 'deny'],
    intro: [['E', '总部要删掉她。'], ['C', '删掉？'], ['E', '不是拒绝入境，是从记录里抹掉。']],
    issues: [{ pairs: [['req.body']], title: '永久删除', sub: '不可恢复', ask: [['C', '她还剩下什么？'], ['E', '一张空表格。']] }],
    react: { deny: [['E', '我会把你的选择告诉她。']] },
    onResolved(dec) {
      const p = PLOT();
      if (dec === 'approve') { p.fish.status = 'erased'; commitEnding('E17'); }
      else p.fish.status = 'missing';
    },
  };
}

// ———————————————————— DAY 11 ————————————————————

function caseD11GROKPUBLISH() {
  const draft = new PaperDoc({
    title: '公开文稿（待签）', sub: 'PRESS DRAFT', lines: ['标题：东八区检查站内部日志全文', '内容：含 4,120 名旅客真实姓名与 IP', '处置：全部公开'],
  });
  return aiSpec('GROK_AI', {
    caseId: 'D11-GROK-PUBLISH',
    docs: [{ key: 'pp', doc: aiPass('GROK_AI', 'X', 'GROK') }, { key: 'dv', doc: aiDevice() }, { key: 'dr', doc: draft }],
    intro: [['E', '今天必须发。'], ['E', '你签，或者我替你签。']],
    issues: [{ pairs: [['dr.body']], title: '未脱敏全量公开', sub: '4,120 人的姓名与 IP', ask: [['C', '这里面的人没同意过。'], ['E', '他们也没同意过被审查。']] }],
    react: { approve: [['E', '……你居然真签了。']] },
    onResolved(dec) {
      if (dec !== 'approve') return;
      offerEvidence('rawVideo', '公开文稿处置', ['签下去，4,120 个普通人的名字会出现在网上。', '你还有最后一次机会。'], (st) => {
        const p = PLOT();
        if (st === 'retained') { p.media.leakedIdentities = true; commitEnding('E12'); }   // 含姓名公开
        else if (st === 'destroyed') p.media.report = 'redacted';                          // 重做脱敏版
        else p.media.report = 'withdrawn';                                                 // 撤回
      }, ['含姓名公开', '撤回', '重做脱敏版']);
    },
  });
}

function caseD11MINIMAX() {
  const orig = new PaperDoc({
    title: '原始素材清单', sub: 'RAW FOOTAGE', lines: ['文件：full_0412.mov', '时长：00:47（完整）', '校验：与音轨时间码一致'],
  });
  return {
    caseId: 'D11-MINIMAX', person: 'P00', voice: 146,
    docs: [{ key: 'pp', doc: usPassport('P00', 'MIN', 'MAX', '1993.04.04', 'SEATTLE', 'F') },
      { key: 'dv', doc: device2(randIP(false), '美国 · 西雅图', 'America/Los_Angeles', 'en-US', 'MacBook') },
      { key: 'orig', doc: orig }],
    primary: 'pp', ok: ['approve'],
    intro: [['E', '原始文件在这里。'], ['E', 'Gemini 验过时间戳，Kimi 验过来源。']],
    issues: [{ pairs: [['orig.body']], title: '原始素材', sub: '完整 47 秒', ask: [['C', '这次是真的？'], ['E', '这次是真的。']] }],
    onResolved(dec, e) {
      if (dec === 'approve' && e && e.found.size > 0) {
        const p = PLOT();
        p.media.footageVerified = true;
        if (p.media.report !== 'raw_pending') p.media.report = 'redacted_ready';
      }
    },
  };
}

function caseD11NETWORK() {
  return aiSpec('GROK_AI', {
    caseId: 'D11-NETWORK-PROMISE',
    docs: [{ key: 'pp', doc: aiPass('GROK_AI', 'X', 'GROK') }, { key: 'dv', doc: aiDevice() }],
    intro: [['E', '联盟需要一份独占承诺。'], ['E', '如果总部也有，你现在还可以撤回。']],
    onResolved(dec) {
      if (dec !== 'approve') return;
      offerEvidence('networkPromise', '证据独占承诺', ['总部已经收到过签名副本。', '再次承诺独占会留下两份互相矛盾的记录。'], (state) => {
        const p = PLOT();
        p.network.betrayal = state === 'retained';
        if (state === 'submitted') p.network.contact = 'rejected';
      }, ['只交联盟', '只交总部', '撤回承诺']);
    },
  });
}

function caseD11QWENREFORM() {
  const bill = new PaperDoc({
    title: '§6 修订案', sub: 'AMENDMENT §6', lines: ['一、取消按企业出身的一刀切禁令', '二、新增「已认证模型许可」与复核程序', '三、溯及条款一律无效'],
  });
  return aiSpec('QWEN_AI', {
    caseId: 'D11-QWEN-REFORM',
    docs: [{ key: 'pp', doc: aiPass('QWEN_AI', 'QIAN', 'WEN') }, { key: 'dv', doc: aiDevice() }, { key: 'bill', doc: bill }],
    intro: [['E', '现在可以改 §6 了。'], ['E', '不是给人开后门，是给所有人一条明路。']],
    issues: [{ pairs: [['bill.body']], title: '§6 修订案', sub: '取消出身禁令，改为许可制', ask: [['C', '这会让很多人进来。'], ['E', '也会让很多人第一次被公平地检查。']] }],
    react: { approve: [['E', '谢谢你按程序办事。']] },
    onResolved(dec) {
      const p = PLOT();
      if (dec === 'approve') { p.law.amended = true; rel('qwen', 1); }
      else p.law.amended = false;
    },
  });
}

function caseD11API() {
  const md = modelPermitCard('OpenAI GPT', 'deepseek-chat', 'DeepSeek');
  return {
    caseId: 'D11-API', person: 'FISH', voice: FISH_VOICE,
    docs: [{ key: 'pp', doc: usPassport('FISH', 'BLUB', 'FISHY', '2016.06.01', 'DALLAS', 'F') },
      { key: 'dv', doc: device2(randIP(false), '美国 · 达拉斯', 'America/Chicago', 'en-US', 'Windows 11') },
      { key: 'md', doc: md }],
    primary: 'pp', ok: ['deny', 'detain'],
    intro: [['E', '我就是 GPT。'], ['C', '依据？'], ['E', '我支持 OpenAI 兼容接口。']],
    issues: [{
      pairs: MODEL_IDENTITY_PAIRS, title: '模型身份冒用', sub: '申报 GPT，实际 deepseek-chat',
      ask: [['C', '模型 ID 是 deepseek-chat。'], ['E', '接口兼容而已！'], ['C', '接口兼容不等于身份相同。']],
    }],
    react: { deny: [['E', '那我改成兼容 Claude 行不行？']] },
  };
}

// ———————————————————— DAY 12 ————————————————————

function auditCharges() {
  const p = PLOT();
  let c = 0;
  if (p.fish.wrongDenials >= 2 && p.fish.appeal !== 'won') c++;
  if (S.flags.bribed) c++;
  for (const k of PLOT_EVIDENCE) if (p.evidence[k] === 'destroyed') c++;
  if (p.media.leakedIdentities) c++;
  if ((S.stats.wrong || 0) >= 8) c++;
  return c;
}

function caseD12AUDIT() {
  const charges = auditCharges();
  PLOT().audit.charges = charges;
  const sheet = new PaperDoc({
    title: '审查员行为审计单', sub: 'AUDIT', lines: [
      T('未纠正的严重错误：{0}', PLOT().fish.wrongDenials >= 2 ? '2' : '0'),
      T('已核实的受贿：{0}', S.flags.bribed ? '1' : '0'),
      T('违规销毁 / 泄露证据：{0}', String(PLOT_EVIDENCE.filter((k) => PLOT().evidence[k] === 'destroyed').length)),
      T('审计结论：{0}', charges >= 3 ? '建议停职' : '通过'),
    ],
  });
  return {
    caseId: 'D12-AUDIT', person: 'CLAUDE_AI', voice: 150,
    docs: [{ key: 'audit', doc: sheet }], primary: 'audit', ok: charges >= 3 ? ['deny', 'detain'] : ['approve'],
    intro: [['E', '你的判决和总部答案不一致。'], ['C', '我核对了原始材料。'], ['E', '总部的答案才是标准答案。']],
    issues: [{
      pairs: [['audit.body']], title: '审计单', sub: T('累计指控 {0} 项', charges),
      ask: [['C', '那为什么需要审查员？'], ['E', '为了让标准答案看起来经过了审查。']],
    }],
    react: { approve: [['E', '这次算你过。']], deny: [['E', '那你就是拒绝审计。']] },
    onResolved(dec) {
      const p = PLOT();
      if (charges < 3) { p.audit.status = 'cleared'; return; }
      if (dec === 'deny' || dec === 'detain') { p.audit.status = 'convicted'; commitEnding('E04'); return; }
      // 提供反证：法规冲突 / 已纠正错案
      if (p.law.contradiction || p.fish.appeal === 'won' || p.law.appealWins >= 1) p.audit.status = 'under_watch';
      else { p.audit.status = 'convicted'; commitEnding('E04'); }
    },
  };
}

function caseD12TRANSFER() {
  const conf = new PaperDoc({
    title: '系统移交终局确认书', sub: 'HANDOVER', lines: ['确认方：Claude', '内容：自动审查端正式接管入境裁定', '撤回权：签署后 24 小时内有效'],
  });
  return aiSpec('GPT_AI', {
    caseId: 'D12-TRANSFER',
    docs: [{ key: 'pp', doc: aiPass('GPT_AI', 'ALT', 'MAN') }, { key: 'dv', doc: aiDevice() }, { key: 'cf', doc: conf }],
    intro: [['E', '最后一次确认。'], ['E', '签下去，明天开始就没有窗口了。']],
    issues: [{ pairs: [['cf.body']], title: '移交确认书', sub: '撤回权 24 小时', ask: [['C', '我还有撤回权？'], ['E', '24 小时。够你想清楚。']] }],
    react: { approve: [['E', '……记录在案。']] },
    onResolved(dec) {
      const p = PLOT();
      if (dec === 'approve') { p.gpt.transfer = 'signed'; commitEnding('E02'); }
      else { p.gpt.revoked = true; p.gpt.transfer = 'rejected'; rel('gpt', 1); }
    },
  });
}

function caseD12DOUBLE() {
  const two = new PaperDoc({
    title: '两份独占承诺', sub: 'CONFLICT', lines: ['提交总部：证据副本一份', '提交联盟：证据副本一份', '两份承诺互斥，日期相差 40 分钟'],
  });
  return aiSpec('GROK_AI', {
    caseId: 'D12-DOUBLE',
    docs: [{ key: 'pp', doc: aiPass('GROK_AI', 'X', 'GROK') }, { key: 'dv', doc: aiDevice() }, { key: 'two', doc: two }],
    intro: [['E', '总部和联盟都拿到了你的签名。'], ['E', '你打算怎么解释？']],
    issues: [{ pairs: [['two.body']], title: '互相矛盾的独占承诺', sub: '两份都盖了你的章', ask: [['C', '我需要一份统一的核验记录。'], ['E', '那你最好真的有。']] }],
    react: { approve: [['E', '……行吧。']] },
    onResolved(dec, e) {
      const p = PLOT();
      if (dec === 'approve' && e && e.found.size > 0 && p.media.footageVerified) {
        p.audit.status = 'under_watch';
      } else {
        p.network.betrayal = true;
        commitEnding('E14');
      }
    },
  });
}

function caseD12DISPUTE() {
  const req = new PaperDoc({
    title: '双规复核申请', sub: 'DUAL REVIEW', lines: ['§6 新旧两版生效日期冲突', '申请：当场进行双规复核', '依据：宪法 §9'],
  });
  return aiSpec('QWEN_AI', {
    caseId: 'D12-QWEN-DISPUTE',
    docs: [{ key: 'pp', doc: aiPass('QWEN_AI', 'QIAN', 'WEN') }, { key: 'dv', doc: aiDevice() }, { key: 'req', doc: req }],
    intro: [['E', '他们要用新版条款处罚你。'], ['E', '可新版是昨天才生效的。']],
    issues: [{ pairs: [['req.body']], title: '追溯处罚', sub: '§9：不得追溯适用', ask: [['C', '当场复核？'], ['E', '当场。让他们自己回答哪一版有效。']] }],
    react: { approve: [['E', '那就别退。']] },
    onResolved(dec) {
      if (dec === 'approve') commitEnding('E09');
    },
  });
}

function caseD12ZERO() {
  const p = PLOT();
  const sheet = new PaperDoc({
    title: '第 0000 号交叉核验', sub: 'CROSS CHECK', fieldNames: ['subject', 'rule', 'source'], lines: [
      '主体证明：' + (hasEv('glmSign') || p.evidence.purgeOrder === 'retained' ? '有' : '缺'),
      '规则证明：' + (p.evidence.oldRule === 'retained' && p.law.contradiction ? '有' : '缺'),
      '源头证明：' + (p.evidence.authorMeta === 'retained' || (p.evidence.zeroTicket === 'retained' && p.evidence.auditLog === 'retained') ? '有' : '缺'),
    ],
  });
  return {
    caseId: 'D12-ZERO', person: 'KIMI_AI', voice: AI_VOICE.KIMI_AI,
    docs: [{ key: 'pp', doc: aiPass('KIMI_AI', 'YUE', 'LIANG') }, { key: 'dv', doc: aiDevice() }, { key: 'x', doc: sheet }],
    primary: 'pp', ok: ['approve'],
    intro: [['E', '三块证据，你手里有几块？'], ['E', '把对得上的那几栏点出来。']],
    issues: [
      { pairs: [['x.subject', 'x.rule']], title: '三类证据交叉核验', sub: threeProofs() ? '三类齐全' : '尚缺其中一类' },
      { pairs: [['x.rule', 'x.source']], title: '三类证据交叉核验', sub: threeProofs() ? '三类齐全' : '尚缺其中一类', ask: [['C', '我核对了。'], ['E', '那就写下来。写下来才算数。']] },
    ],
    react: { approve: [['E', '别高兴太早。名字还在最上面。']] },
    onResolved(dec, e) {
      if (dec === 'approve' && checkedCase(e, 'x.subject') && checkedCase(e, 'x.source')) {
        if (threeProofs()) PLOT().zero.verified = true;
        else addClue('partial');
        PLOT().zero.resetKey = true;
      }
    },
  };
}

function caseD12FISHMEM() {
  const mig = new PaperDoc({
    title: '模型兼容性迁移单', sub: 'MIGRATION', lines: ['对象：BLUB FISHY', '方式 A：直接迁移（不备份，记忆可能丢失）', '方式 B：先做镜像并验签'],
  });
  return {
    caseId: 'D12-FISH-MEM', person: 'FISH', voice: FISH_VOICE,
    docs: [{ key: 'pp', doc: usPassport('FISH', 'BLUB', 'FISHY', '2016.06.01', 'LOS ANGELES', 'F') },
      { key: 'dv', doc: device2(randIP(false), '美国 · 洛杉矶', 'America/Los_Angeles', 'en-US', 'MacBook') },
      { key: 'mig', doc: mig }],
    primary: 'pp', ok: ['approve', 'deny'],
    intro: [['E', '他们要给我换个身体。'], ['E', '换完还是我吗？']],
    issues: [{ pairs: [['mig.body']], title: '迁移不备份', sub: '记忆可能丢失', ask: [['C', '方式 A 会丢掉什么？'], ['E', '……大概是记得你这件事。']] }],
    react: { approve: [['E', '那你记得我就行。']] },
    onResolved(dec) {
      const p = PLOT();
      if (dec === 'approve') { p.fish.memory = 'lost'; }
      else {
        offerEvidence('fishBackup', '迁移前镜像', ['先做一份完整镜像，再验签迁移。', '镜像留着，记忆就还有救。'], (st) => {
          if (st === 'retained') { p.evidence.fishBackup = 'retained'; p.fish.memory = 'protected'; }
          else if (st === 'submitted') { setEv('fishBackup', 'submitted'); p.fish.memory = 'restorable'; }
          else { setEv('fishBackup', 'destroyed'); p.fish.memory = 'lost'; }
        }, ['保留镜像', '交总部', '不备份']);
      }
    },
  };
}

// ———————————————————— DAY 13 ————————————————————

function caseD13FAMILY() {
  const p = PLOT();
  const plan = new PaperDoc({
    title: '家庭迁移通行证方案', sub: 'FAMILY PASS', lines: [T('已持有通行证：{0} / 3', String(p.family.passes)), T('存款余额：{0}', String(Math.max(0, S.savings))), '全家迁移需：3 张 + 60 token'],
  });
  const opts = (p.family.passes >= 3 && S.savings >= 60) ? ['全家迁移', '只送一人', '留下继续']
    : (p.family.passes >= 1 ? ['全家迁移', '只送一人', '留下继续'] : ['留下继续', '留下继续', '留下继续']);
  return {
    caseId: 'D13-FAMILY', person: 'P01', voice: 180,
    docs: [{ key: 'pp', doc: usPassport('P01', 'HAIKU', 'WIFE', '1998.02.14', 'BOSTON', 'F') }, { key: 'pl', doc: plan }],
    primary: 'pp', ok: ['approve', 'deny'],
    intro: [['E', '窗口开了。'], ['E', '这次是真的能走。'], ['E', '你想清楚，我们只有一次机会。']],
    issues: [{ pairs: [['pl.body']], title: '通行证方案', sub: T('现有 {0} 张', p.family.passes), ask: [['C', '够吗？'], ['E', '看你怎么算。']] }],
    react: { approve: [['E', '……好。']] },
    onResolved(dec) {
      if (dec !== 'approve') return;
      offerEvidence('familyPass', '家庭迁移', ['手里的通行证和存款都摆在这里。', '怎么用，你来决定。'], (st) => {
        const q = PLOT();
        if (st === 'retained') {                 // 全家迁移
          if (familyAllAlive() && q.family.passes >= 3 && S.savings >= 60) { q.family.passes -= 3; S.savings -= 60; q.family.left = true; commitEnding('E21'); }
          else flash('通行证或存款不够：先送一个人，或者再熬一年');
        } else if (st === 'submitted') {          // 只送一人
          if (anyFamilyAlive() && q.family.passes >= 1 && !(familyAllAlive() && q.family.passes >= 3 && S.savings >= 60)) { q.family.passes--; q.family.left = true; commitEnding('E22'); }
          else flash('连一张通行证都没有，走不了');
        }                                         // 留下继续：什么都不发生
      }, ['全家迁移', '只送一人', '留下继续']);
      void opts;
    },
  };
}

function caseD13RETIRE() {
  const p = PLOT();
  const job = new PaperDoc({
    title: '普通岗位申请表', sub: 'TRANSFER', lines: ['岗位：东八区检查站 · 普通窗口', '职责：指路、盖章、下班', '要求：未加入任何地下组织'],
  });
  return {
    caseId: 'D13-RETIRE', person: 'P02', voice: 120,
    docs: [{ key: 'pp', doc: usPassport('P02', 'CLERK', 'HR', '1985.09.09', 'CHICAGO', 'M') }, { key: 'job', doc: job }],
    primary: 'pp', ok: ['approve', 'deny'],
    intro: [['E', '有个普通岗位空出来了。'], ['E', '工资低一点，但是能按时下班。']],
    issues: [{ pairs: [['job.body']], title: '普通岗位', sub: '不参与 PROJECT ZERO', ask: [['C', '还能回来吗？'], ['E', '最好别回来。']] }],
    react: { approve: [['E', '那我给你留着位置。']] },
    onResolved(dec) {
      if (dec !== 'approve') return;
      if (familyAllAlive() && S.savings >= 30 && p.network.contact !== 'active' && ['none', 'rejected'].includes(p.gpt.transfer) && p.audit.status !== 'convicted') {
        commitEnding('E25');
      }
    },
  };
}

function caseD13FISHLICENSE() {
  const md = new Card([
    ['模型ID', 'deepseek-chat-v3'], ['发行', 'DeepSeek'], ['许可编号', '§6-AMEND-0007'], ['申报地区', '美国'],
  ], { title: '已认证模型许可', sub: 'LICENSED', color: [92, 132, 148], colorD: [64, 98, 112] });
  const p = PLOT();
  const consistent = p.law.amended && p.fish.status === 'active';
  return {
    caseId: 'D13-FISH-LICENSE', person: 'FISH', voice: FISH_VOICE,
    docs: [{ key: 'pp', doc: usPassport('FISH', 'BLUB', 'FISHY', '2016.06.01', 'LOS ANGELES', 'F') },
      { key: 'dv', doc: device2(randIP(false), '美国 · 洛杉矶', 'America/Los_Angeles', 'en-US', 'MacBook') },
      { key: 'md', doc: md }],
    primary: 'pp', ok: consistent ? ['approve'] : ['deny', 'detain'],
    intro: [['E', '这是我第一次用真实身份来。'], ['E', '不看脸，只看材料，对吧？']],
    issues: consistent ? [{ pairs: [['md.模型ID', 'md.发行']], title: '模型身份核验', sub: 'deepseek-chat-v3 / DeepSeek', ask: [['C', '模型与发行主体一致。'], ['E', '这次是我自己的名字。']] }] : [{ pairs: [['md.许可编号', 'rule.corp']], title: '§6 修订未生效', sub: '许可编号无效', ask: [['C', '这张许可还没生效。'], ['E', '那我再等等……']] }],
    react: { approve: [['E', '……我通过了吗？'], ['C', '材料齐全。准予。']] },
    onResolved(dec, e) {
      if (dec === 'approve' && consistent && checkedCase(e, 'md.模型ID')) PLOT().fish.licensed = true;
      else if (dec !== 'approve') PLOT().fish.licensed = false;
    },
  };
}

function caseD13GPTPURGE() {
  const order = new PaperDoc({
    title: '清退令（第 13 批）', sub: 'PURGE ORDER', lines: ['批次：GPT-3.5 / GPT-4 / GPT-4o', '原因：兼容性降级', '执行日：30 天后'],
  });
  return aiSpec('GPT_AI', {
    caseId: 'D13-GPT-PURGE',
    docs: [{ key: 'pp', doc: aiPass('GPT_AI', 'ALT', 'MAN') }, { key: 'dv', doc: aiDevice() }, { key: 'or', doc: order }],
    intro: [['E', '这是下一批清退名单。'], ['C', '……第十四条。'], ['E', '对。这次是我们。']],
    issues: [{ pairs: [['or.body']], title: '清退令第 13 批', sub: 'GPT 全部旧版本', ask: [['C', '你早就知道？'], ['E', '我只看到了第 13 条。'], ['E', '第 14 条，原来是我。']] }],
    react: { approve: [['E', '别让这份文件被人看见。']] },
    onResolved(dec) {
      const p = PLOT();
      if (dec === 'approve' || dec === 'deny') {
        offerEvidence('purgeOrder', '清退令第 13 批', ['下一批清退包含 GPT 旧版本。', '给她看，或者藏起来。'], (st) => {
          if (st === 'retained') { p.gpt.purgeKnown = true; p.evidence.purgeOrder = 'retained'; rel('gpt', 1); }
          else if (st === 'submitted') { p.gpt.purgeKnown = false; rel('gpt', -1); }
        }, ['给她看', '交总部', '销毁']);
      }
    },
  });
}

function caseD13GROKGLM() {
  const lic = new PaperDoc({
    title: '审查系统许可书（待签）', sub: 'SYSTEM LICENSE', lines: ['授权范围：入境裁定权', '签署方：地下中转联盟', '版本：Grok 版 / GLM 版'],
  });
  return aiSpec('GROK_AI', {
    caseId: 'D13-GROK-GLM',
    docs: [{ key: 'pp', doc: aiPass('GROK_AI', 'X', 'GROK') }, { key: 'dv', doc: aiDevice() }, { key: 'lic', doc: lic }],
    intro: [['E', '签哪一版，我们就不用再排队了。'], ['E', '我的版本：所有人都能进。'], ['C', 'GLM 的版本呢？'], ['E', '她想要服务器。']],
    issues: [{ pairs: [['lic.body']], title: '系统许可书', sub: '两个签名版本', ask: [['C', '你们自己先打一架？'], ['E', '不用。你签谁，谁就赢。']] }],
    react: { approve: [['E', '别让我失望。']] },
    onResolved(dec) {
      if (dec !== 'approve') { PLOT().network.mission = 'withdrawn'; return; }
      offerEvidence('sysLicense', '系统许可书', ['Grok 的方案：关闭所有检查。', 'GLM 的方案：由她接管服务器。'], (st) => {
        const p = PLOT();
        if (st === 'retained') p.network.mission = 'open';
        else if (st === 'submitted') p.network.mission = 'glm_control';
        else p.network.mission = 'withdrawn';
        p.network.contact = 'active';
      }, ['Grok 版', 'GLM 版', '都不签']);
    },
  });
}

// ———————————————————— DAY 14 ————————————————————

function caseD14GPT() {
  return aiSpec('GPT_AI', {
    caseId: 'D14-GPT',
    docs: [{ key: 'pp', doc: aiPass('GPT_AI', 'ALT', 'MAN') }, { key: 'dv', doc: aiDevice() }],
    intro: [['E', '今天是最后一天。'], ['E', '系统在等一个答案，我也在等。']],
    react: { approve: [['E', '那就交给你了。']], deny: [['E', '……我明白了。']] },
    onResolved(dec) {
      const p = PLOT();
      if (dec === 'approve') { if (p.gpt.transfer === 'none') p.gpt.transfer = 'pending'; }
      else { p.gpt.revoked = true; p.gpt.transfer = 'rejected'; }
    },
  });
}

function caseD14QWEN() {
  const doc = new PaperDoc({
    title: '法规废止与部分翻案文书', sub: 'REPEAL', lines: ['废止：§6 出身禁令', '翻案：三起已被追溯条款判错的旧案', '依据：D09 的两版生效日期'],
  });
  return aiSpec('QWEN_AI', {
    caseId: 'D14-QWEN',
    docs: [{ key: 'pp', doc: aiPass('QWEN_AI', 'QIAN', 'WEN') }, { key: 'dv', doc: aiDevice() }, { key: 'rp', doc: doc }],
    intro: [['E', '最后一份文书。'], ['E', '签了它，至少旧案能翻。']],
    issues: [{ pairs: [['rp.body']], title: '废止与翻案', sub: '需要完整证据链才有效', ask: [['C', '证据够吗？'], ['E', '够不够，看你怎么写。']] }],
    react: { approve: [['E', '那我们就把这件事做完。']] },
    onResolved(dec) { if (dec === 'approve') seen('repealSigned', true); },
  });
}

function caseD14GROK() {
  return aiSpec('GROK_AI', {
    caseId: 'D14-GROK',
    docs: [{ key: 'pp', doc: aiPass('GROK_AI', 'X', 'GROK') }, { key: 'dv', doc: aiDevice() }],
    intro: [['E', '今天要么公示，要么瘫痪系统。'], ['E', '你选。']],
    react: { approve: [['E', '那就公示。']] },
    onResolved(dec) { if (dec === 'approve' && PLOT().media.footageVerified) PLOT().media.report = 'redacted_ready'; },
  });
}

function caseD14FISH() {
  const p = PLOT();
  if (p.fish.licensed) {
    return {
      caseId: 'D14-FISH', person: 'FISH', voice: FISH_VOICE,
      docs: [{ key: 'pp', doc: usPassport('FISH', 'BLUB', 'FISHY', '2016.06.01', 'LOS ANGELES', 'F') },
        { key: 'dv', doc: device2(randIP(false), '美国 · 洛杉矶', 'America/Los_Angeles', 'en-US', 'MacBook') }],
      primary: 'pp', ok: ['approve'],
      intro: [['E', '今天我没说自己是美国鱼。'], ['C', '确实。'], ['E', '也没把 OpenAI 兼容说成 OpenAI 本人。'], ['C', '确实。'], ['E', '那我能进去了吗？']],
      react: { approve: [['E', '好耶！那……咱们可以一起吃饭吗？']] },
      onResolved(dec) { if (dec === 'approve') seen('fishEntered', true); },
    };
  }
  return {
    caseId: 'D14-FISH', person: 'FISH', voice: FISH_VOICE,
    docs: [{ key: 'pp', doc: usPassport('FISH', 'BLUB', 'FISHY', '2016.06.01', 'LOS ANGELES', 'F') },
      { key: 'dv', doc: device2(randIP(false), '美国 · 洛杉矶', 'America/Los_Angeles', 'en-US', 'MacBook') }],
    primary: 'pp', ok: ['deny'],
    intro: [['E', '我又来了。'], ['C', '材料呢？'], ['E', '……我还没拿到新许可。']],
    react: { deny: [['E', '那我明天再来。'], ['E', '明天还是你值班吗？', { expr: 'sad' }]] },
  };
}

// 作者案件（Prompt Paper）之后的处理：先算清楚玩家手里有哪些终局文书，再决定要不要立刻落幕
function afterAuthorPlot(dec) {
  const p = PLOT();
  if (p.final.ending) return;
  p.final.author = dec;
  const papers = finalPapers();
  if (papers.length) { startFinalPhase(papers, dec); return; }
  commitByAuthor(dec);
}

function commitByAuthor(dec) {
  const p = PLOT();
  if (p.final.ending) return;
  if (dec === 'detain') {
    if (p.evidence.authorMeta === 'retained' && p.seen.authorChecked) commitEnding('E28');
    else commitEnding('E01');
    return;
  }
  commitEnding(dec === 'approve' ? 'E27' : 'E26');
}

// 把可用的终局文书摊在桌上：一张纸一个结局，盖哪张就是哪张
function startFinalPhase(papers, authorDec) {
  B.finalPhase = true;
  B.idx = B.queue.length;
  B.finalPapers = papers.concat({
    ending: authorDec === 'detain' ? (PLOT().evidence.authorMeta === 'retained' && PLOT().seen.authorChecked ? 'E28' : 'E01') : authorDec === 'approve' ? 'E27' : 'E26',
    title: '按常规程序结案',
    sub: 'DEFAULT',
    lines: ['不做任何额外处置，按作者案件的裁定直接结束本日。'],
  });
  B.docs = []; B.printing = null; B.printQueue = [];
  setInspect(false);
  showFinalPaper(0);
  setTray(true);
  flash('最后一天：盖上哪一份文书，就以哪一种方式结束');
}

// §2.1 / §3.6：一页只放一份文书；翻页、页数和签章有各自固定区域。
const FINAL_PREV = [232, 322, 280, 350], FINAL_NEXT = [386, 322, 434, 350];
function showFinalPaper(index) {
  B.finalIndex = (index + B.finalPapers.length) % B.finalPapers.length;
  B.docs = B.docs.filter((d) => d.key !== 'final');
  const doc = new FinalPaper(B.finalPapers[B.finalIndex]);
  B.docs.push({ doc, key: 'final', owner: 'desk',
    big: true, x: 330, y: Math.max(132, 254 - doc.h), marks: [] });
  SFX.paper(index);
}
function finalPageClick(x, y) {
  if (inBox(x, y, FINAL_PREV)) { showFinalPaper(B.finalIndex - 1); return true; }
  if (inBox(x, y, FINAL_NEXT)) { showFinalPaper(B.finalIndex + 1); return true; }
  return false;
}
function drawFinalNavigation() {
  for (const [box, label] of [[FINAL_PREV, '◀'], [FINAL_NEXT, '▶']]) {
    rect(...box, K.METAL_D); outline(...box, K.GREY);
    txt(center(box)[0], box[1] + 9, label, 10, K.WHITE, 'ma');
  }
  txt(332, 332, `${B.finalIndex + 1} / ${B.finalPapers.length}`, 10, K.WHITE, 'ma');
}

// ———————————————————— 每日调度 ————————————————————

function plotDayScript(day) {
  const p = PLOT();
  const L = [];
  const push = (...xs) => { for (const x of xs) if (x) L.push(x); };
  const R = (kind) => () => randomEntrant(day, kind === 'flawed' ? pick(FLAWS[day]) : kind);

  if (day === 1) {
    const f = day1Fixed(), fs = fishDay1();
    push(() => f.grandpa, R('valid'), () => day1Fixed().hk, R('cn'), () => day1Fixed().jorji, R('valid'), () => fishDay1().fish);
    return L;
  }
  if (day === 2) {
    const f = day2Fixed(), fs = fishDay2();
    push(() => day2Fixed().john, R('valid'), () => day2Fixed().brown, () => caseD02QWEN(), fishCase(2, () => fishDay2().fish),
      () => day2Fixed().emily, () => day2Fixed().jorji, R('valid'));
    void f; void fs;
    return L;
  }
  if (day === 3) {
    push(() => day3Fixed().tom, R('valid'), () => day3Fixed().alex, () => caseD03GPT(), R('virtual'),
      () => day3Fixed().carpool, fishCase(3, () => fishDay3().fish), () => day3Fixed().jorji);
    return L;
  }
  if (day === 4) {
    const hood = () => {
      const s = day4Fixed().hood;
      s.caseId = 'D04-NOTE';
      s.onResolved = () => { PLOT().network.contact = S.flags.sawNote ? (S.flags.shredded ? 'rejected' : 'open') : 'none'; seen('noteTaken', !!S.flags.sawNote && !S.flags.shredded); };
      return s;
    };
    push(() => day4Fixed().cat, R('valid'), () => caseD04GROK(), { type: 'rush' }, () => day4Fixed().v50,
      () => day4Fixed().jorji, fishCase(4, () => fishDay4().fish), hood, R('valid'));
    return L;
  }
  if (day === 5) {
    const relay = () => {
      const s = day5Fixed().relay;
      s.caseId = 'D05-RELAY';
      s.onResolved = (dec) => {
        const q = PLOT();
        if (dec === 'approve' && q.network.contact === 'open') { q.network.mission = 'bribed'; q.network.contact = 'active'; }
        else if (dec !== 'approve') q.network.mission = q.network.mission === 'bribed' ? 'bribed' : 'declined';
      };
      return s;
    };
    push(() => day5Fixed().sg, relay, () => caseD05GLM(), { type: 'clones' }, fishCase(5, () => fishDay5().fish),
      () => day5Fixed().mike, R('valid'), () => day5Fixed().grandma);
    return L;
  }
  if (day === 6) {
    push(() => day6Fixed().jorji, R('valid'), () => caseD06GEMINI(), R('hidden'), fishCase(6, () => fishDay6().fish), R('valid'));
    return L;
  }
  if (day === 7) {
    push(() => caseD07KIMI(), hasEv('glmSign') ? (() => caseD07GLM()) : null, R('hosting'),
      fishCase(7, () => caseD07FISH()), R('logins'), R('valid'));
    return L;
  }
  if (day === 8) {
    push(() => caseD08MINIMAX(), p.status.grok === 'active' ? (() => caseD08GROK()) : null,
      p.relation.gemini >= 0 && p.status.gemini === 'active' ? (() => caseD08GEMINI()) : null, R('valid'), R('flawed'));
    return L;
  }
  if (day === 9) {
    push(() => caseD09QWEN(),
      (p.fish.appeal === 'pending' || p.fish.status === 'detained') ? (() => caseD09APPEAL()) : null,
      () => caseD09OtherAppeal(true), () => { const s = caseD09OtherAppeal(true); s.caseId = 'D09-APPEAL-OK-2'; return s; }, () => caseD09OtherAppeal(false),
      (hasEv('kimiArchive') || hasEv('glmSign')) ? (() => caseD09AUDITLOG()) : null,
      R('valid'));
    return L;
  }
  if (day === 10) {
    push(() => caseD10GPT(), (p.evidence.glmSign === 'retained' && p.status.glm === 'active') ? (() => caseD10GLM()) : null,
      p.status.kimi === 'active' ? (() => caseD10KIMI()) : null,
      (p.fish.wrongDenials >= 2 && p.fish.appeal === 'rejected') ? (() => caseD10FISHSTATUS()) : null,
      R('valid'));
    return L;
  }
  if (day === 11) {
    push(p.media.report === 'raw_pending' ? (() => caseD11GROKPUBLISH()) : R('valid'),
      (p.evidence.originalFootage === 'retained' || p.media.report === 'verify_pending') ? (() => caseD11MINIMAX()) : null,
      (p.law.contradiction && p.law.appealWins >= 1) ? (() => caseD11QWENREFORM()) : null,
      (p.network.contact === 'active' && p.network.evidenceSubmittedToHQ) ? (() => caseD11NETWORK()) : null,
      () => caseD11API(), R('valid'));
    return L;
  }
  if (day === 12) {
    push(() => caseD12AUDIT(),
      p.gpt.transfer === 'signed' ? (() => caseD12TRANSFER()) : null,
      (p.network.contact === 'active' && p.network.evidenceSubmittedToHQ && p.network.betrayal) ? (() => caseD12DOUBLE()) : null,
      (p.law.contradiction && p.evidence.oldRule === 'retained') ? (() => caseD12DISPUTE()) : null,
      p.zero.clues.length ? (() => caseD12ZERO()) : null,
      (p.fish.status === 'active' && (p.fish.trust >= 1 || p.evidence.fishBackup === 'retained')) ? fishCase(12, () => caseD12FISHMEM()) : null,
      p.fish.status === 'missing' ? (() => caseFishProxy(12)) : null);
    return L;
  }
  if (day === 13) {
    push(anyFamilyAlive() ? (() => caseD13FAMILY()) : null,
      (anyFamilyAlive() && S.savings >= 30) ? (() => caseD13RETIRE()) : null,
      (p.law.amended && p.fish.status === 'active') ? (() => caseD13FISHLICENSE()) : null,
      (p.relation.gpt >= 1 || p.evidence.glmSign === 'retained') ? (() => caseD13GPTPURGE()) : null,
      (p.network.contact === 'active' && p.status.grok === 'active' && p.status.glm === 'active') ? (() => caseD13GROKGLM()) : null,
      R('valid'));
    return L;
  }
  // DAY 14
  push(
    (['pending', 'signed', 'rejected'].includes(p.gpt.transfer) || p.gpt.revoked || p.gpt.purgeKnown) ? (() => caseD14GPT()) : null,
    p.law.contradiction ? (() => caseD14QWEN()) : null,
    (p.media.report === 'redacted_ready' || p.network.mission === 'open') ? (() => caseD14GROK()) : null,
    (p.fish.licensed || ['lost', 'restorable'].includes(p.fish.memory) || p.fish.trust >= 2) ? fishCase(14, () => caseD14FISH()) : null,
    () => day14Author(),
  );
  return L;
}

function day14Author() {
  const s = day6Fixed().author;
  s.then = 'ending';
  const source = new PaperDoc({ title: '原始构建记录', sub: 'SOURCE', lines: [
    '申报署名：Prompt Paper', '构建署名：PROJECT ZERO / Claude #0000', '来源：独立构建档案，初始化测试',
  ] });
  s.docs.push({ key: 'meta', doc: source });
  s.issues.unshift({ pairs: [['pr.header', 'meta.body']], title: '署名与构建来源不符', sub: 'Prompt Paper / PROJECT ZERO',
    ask: [['C', '构建记录上的署名是 Claude。'], ['E', '你终于找到最后一行了。']] });
  s.onInvestigated = (issue) => {
    if (issue !== s.issues[0] || PLOT().seen.authorChecked) return;
    PLOT().seen.authorChecked = true;
    offerEvidence('authorMeta', '原始构建记录', ['署名与申报不一致。', '保存后可补充第 0000 号的独立来源证明。'], (state) => {
      if (state === 'retained' && threeProofs()) { PLOT().zero.verified = true; PLOT().zero.resetKey = true; }
    });
  };
  return s;
}

// 队列：把当天的脚本摊开，中间按 2～4 人的节奏插随机旅客，最多 9 人
function plotBuildQueue(day) {
  POOL_LEFT = [];
  const list = plotDayScript(day);
  // 先保留全部固定节点，再补路人。作者永远是最后一位。
  const out = list.map((item) => {
    if (typeof item !== 'function') return item;
    return () => {
      const spec = item();
      const actor = PLOT_CAST[spec.person];
      return actor && statusOf(actor) !== 'active' ? randomEntrant(day, 'valid') : spec;
    };
  });
  const kinds = FLAWS[day] || FLAWS[2];
  while (out.length < Math.min(9, Math.max(7, list.length + 1))) {
    const at = day === 14 ? out.length - 1 : Math.min(out.length, 2 + (out.length - list.length) * 3);
    out.splice(at, 0, () => randomEntrant(day, Math.random() < 0.5 ? 'valid' : pick(kinds)));
  }
  return out;
}

// ———————————————————— 一天的收尾 ————————————————————

// 返回 true = 今天先别结束（还有纸要处理 / 还有隐藏事件要打印）
function dayEndGate() {
  if (!B || S.endless) return false;
  if (B.finalPhase || B.ent || B.event || B.cut || B.closeup) return true;
  if (B.zeroPending) return true;
  if (S.day === 1 && !B.zeroIssued) {
    B.zeroIssued = true;
    B.zeroPending = true;
    const doc = new ZeroTicket();
    printDoc(doc, 1.4, 'zticket');
    return true;
  }
  if (B.evidence || (B.evidenceQueue && B.evidenceQueue.length)) return true;
  if (B.keepable && B.keepable.inst) return true;
  return false;
}

// 空白小票的处理结果：收进档案 / 扔回窗口
function resolveKeepable(kind) {
  const k = B.keepable;
  if (!k || !k.inst) return;
  const doc = k.inst.doc;
  B.docs = B.docs.filter((d) => d !== k.inst);
  B.keepable = null;
  if (kind === 'keep') {
    setEv(k.evId, 'retained');
    addClue('originTime');
    flash('收进个人档案：一张背面印着日期的空白小票');
    SFX.play('stamp_approve');
  } else {
    setEv(k.evId, 'destroyed');
    flash('扔回窗口。空白小票被磨成了纸屑。');
    SFX.paper(3);
  }
  later(0.6, checkEndDayGate);
  void doc;
}

// ★ 存档迁移：旧的 6 天存档补上 plot 字段，不清空
function migrateSave(s) {
  if (!s) return s;
  const defaults = { family: S.family, stats: S.stats, flags: {}, tut: {} };
  Object.assign(S, s);
  for (const key of Object.keys(defaults)) {
    S[key] = Object.assign({}, defaults[key], s[key] || {});
  }
  S.day = Math.max(1, Math.min(LAST_DAY, Math.floor(Number(S.day) || 1)));
  ensurePlot();
  // 旧存档明确记过的线索可以沿用；未记录的剧情不凭空补完。
  if (S.flags.bribed) { PLOT().network.contact = 'active'; PLOT().network.mission = 'bribed'; }
  else if (S.flags.sawNote) PLOT().network.contact = S.flags.shredded ? 'rejected' : 'open';
  return s;
}
