'use strict';
// 语言：开局选 简体中文 / 繁體中文 / 日本語 / English（选语言画面也在这个文件末尾）。
// 中文是原文，其余三种译文各一个文件，以中文原句为键：
//   en.js       英文
//   zh-hant.js  繁體中文（繁體字・道地譯法）
//   ja.js       日文
//   T('中文')           当前语言下查表；简体中文模式原样返回
//   T('模板 {0}', x)    先翻模板，再把每个参数也翻一遍填进去
// 查不到的中文会在控制台提示一次（也可以跑 node tools/check_i18n.js 一次查全）。

const LANG_KEY = STORAGE_KEYS.language;
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;

// 顺序即开局选语言卡片的顺序
const LANGS = ['zh', 'zh-hant', 'ja', 'en'];
const DICTS = { en: EN, 'zh-hant': ZH_HANT, ja: JA };
const HTML_LANG = { zh: 'zh-CN', 'zh-hant': 'zh-Hant', ja: 'ja', en: 'en' };
const LANG_LABEL = { zh: '中文', 'zh-hant': '繁中', ja: '日本語', en: 'EN' };   // 标题画面切换钮上的短名

// 标题画面：按顺序换到下一种语言
function cycleLang() { setLang(LANGS[(LANGS.indexOf(LANG) + 1) % LANGS.length]); }

// 折行时不能出现在行首的字符（简版行首禁则，gfx.js 的 wrap 用）
const NO_LINE_START = '、。，．・：；？！゛゜ヽヾゝゞ々ー）」』】〕》〉”’ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ,.;:!?)]}';

// 报纸译注 / 黑话注释：只有非中文玩家需要（简体中文原文不需要）
const NOTES_FOR = (l) => (l === 'en' ? EN_NOTES : l === 'ja' ? JA_NOTES : {});
const GLOSS_FOR = (l) => (l === 'en' ? EN_GLOSS : l === 'ja' ? JA_GLOSS : {});

let LANG = initialLang();

// 文档层会把已经翻过的句子再 T() 一遍（plot.js 先翻好、docs.js 渲染时又翻），
// 那些句子记在这里，第二次原样返回，免得控制台刷一堆假“缺译文”。
const produced = new Set();

function initialLang() {
  try {
    const l = localStorage.getItem(LANG_KEY);
    if (LANGS.includes(l)) return l;
  } catch (e) { /* 隐私模式等 */ }
  const nav = navigator.language || 'zh';
  if (/^ja/i.test(nav)) return 'ja';
  if (/^zh/i.test(nav)) return /(hant|tw|hk|mo)/i.test(nav) ? 'zh-hant' : 'zh';
  return 'en';
}

function T(s, ...args) {
  const d = DICTS[LANG];
  if (d && !produced.has(s)) {
    const out = tr(d, s);
    if (out !== s && produced.size < 4000) produced.add(out);
    s = out;
  }
  if (!args.length) return s;
  const filled = s.replace(/\{(\d)\}/g, (_, i) => T(String(args[i])));
  if (d && filled !== s && produced.size < 4000) produced.add(filled);
  return filled;
}

const untranslated = new Set();
function tr(d, s) {
  if (Object.prototype.hasOwnProperty.call(d, s)) return d[s];
  if (s.includes(' · ')) return s.split(' · ').map((p) => tr(d, p)).join(' · ');   // “中国 · 浙江 · 电信”逐段翻
  if (CJK.test(s) && !untranslated.has(LANG + s)) { untranslated.add(LANG + s); console.warn(`[i18n] 缺 ${LANG} 译文：`, s); }
  return s;
}

// 台词停留时长按字数算；拉丁字母的阅读量大约半个汉字
function readLen(s) {
  const chars = [...s];
  const wide = (ch) => CJK.test(ch);
  return LANG === 'en' ? chars.reduce((n, ch) => n + (wide(ch) ? 1 : 0.5), 0) : chars.length;
}

function setLang(l) {
  LANG = LANGS.includes(l) ? l : 'zh';
  produced.clear();
  untranslated.clear();
  try { localStorage.setItem(LANG_KEY, LANG); } catch (e) { /* 同上 */ }
  applyDomLang();
}

// 页面上的几个 HTML 按钮和提示（不在画布里）
function applyDomLang() {
  const root = document.documentElement;
  root.lang = HTML_LANG[LANG];
  document.title = T(MOD.title);
  for (const el of document.querySelectorAll('#full, #rotate div, #rotate small, #rotate button, noscript')) {
    if (el.dataset.zh === undefined) el.dataset.zh = el.textContent;
    el.textContent = T(el.dataset.zh);
  }
  const cv = document.getElementById('game');
  if (cv) cv.setAttribute('aria-label', T('IP, PLEASE：零号档案 游戏画面'));
  updateMuteLabel();
}

// ———————————————————— 开局：选语言 ————————————————————
// 选语言本身也是一次入境检查：看一眼玩家自己设备的时区和语言，对不上就开个玩笑（只在本地读，不上传）。

// 四张卡片横排（W 定义在 gfx.js 里，本文件先加载，所以坐标在调用时才算）
const CARD_W = 96, CARD_GAP = 10, CARD_Y0 = 124, CARD_Y1 = 190;
function langCardBox(l) {
  const i = Math.max(0, LANGS.indexOf(l));
  const total = CARD_W * LANGS.length + CARD_GAP * (LANGS.length - 1);
  const x0 = Math.round((W - total) / 2) + i * (CARD_W + CARD_GAP);
  return [x0, CARD_Y0, x0 + CARD_W, CARD_Y1];
}

const GAG_BOX = [120, 236, 520, 294];
let PICK = null;

// 卡片文案：语言自己的名字、代码、一句自夸
const CARD_TEXT = {
  zh: { name: '简体中文', code: 'zh-CN', line1: '原汁原味 · 梗最多', line2: 'Simplified Chinese' },
  'zh-hant': { name: '繁體中文', code: 'zh-Hant', line1: '繁體字・道地譯法', line2: 'Traditional Chinese' },
  ja: { name: '日本語', code: 'ja-JP', line1: '全文日本語訳', line2: 'Japanese' },
  en: { name: 'ENGLISH', code: 'en-US', line1: 'For REAL Americans', line2: '英文' },
};

const DEVICE = (() => {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* 老浏览器 */ }
  const off = -new Date().getTimezoneOffset() / 60;
  return { tz: tz || `UTC${off >= 0 ? '+' : ''}${off}`, lang: navigator.language || '?', utc8: off === 8 };
})();

// 选了和“设备所在地”不搭的语言：开个玩笑，但照样放行
function langGag(l) {
  const d = DEVICE;
  const nav = d.lang || '';
  if (l === 'en' && d.utc8) {
    return { sub: `TZ: ${d.tz}   VS   LANG: English`, quip: '“Hello, I am 美国人。”', note: 'Approved anyway. §12: we judge the region, not the language.' };
  }
  if (l === 'zh' && !d.utc8 && !/^zh/i.test(nav)) {
    return { sub: `时区 TZ: ${d.tz}   VS   语言 LANG: 中文`, quip: '“……我在学中文。”', note: '("…I\'m learning Chinese.") 准予入境。' };
  }
  if (l === 'ja' && d.utc8) {
    return { sub: `TZ: ${d.tz}   VS   LANG: 日本語`, quip: '「日本語を勉強しています。」', note: '（“I am studying Japanese.”）とはいえ §12：見るのは地域で、言語ではない。' };
  }
  if (l === 'zh-hant' && (d.utc8 || /^zh-(cn|sg|hans)/i.test(nav))) {
    return { sub: `時區 TZ: ${d.tz}   VS   語言 LANG: 繁體中文`, quip: '「……我在練習繁體字。」', note: '("…I am practising Traditional Chinese.") 准予入境。§12：看的是地區，不是字體。' };
  }
  return null;
}

function langClick(x, y) {
  if (PICK) { if (now > PICK.t0 + 0.5) go('intro'); return; }
  const l = LANGS.find((k) => inBox(x, y, langCardBox(k)));
  if (!l) return;
  chooseLang(l);
  PICK = { lang: l, t0: now, gag: langGag(l), buzzed: false };
  SFX.play('stamp_approve', 1, 0.03);
}

function updateLangPick() {
  if (!PICK) return;
  if (PICK.gag && !PICK.buzzed && now > PICK.t0 + 0.45) { PICK.buzzed = true; SFX.play('discrepancy'); }
  if (now > PICK.t0 + (PICK.gag ? 3.4 : 1.0)) go('intro');
}

function drawLangCard(l) {
  const box = langCardBox(l), [x0, y0, x1, y1] = box;
  const t = CARD_TEXT[l];
  const hover = !PICK && ptr.mouse && inBox(ptr.x, ptr.y, box);
  const up = hover ? 2 : 0, top = y0 - up, bot = y1 - up, cx = (x0 + x1) >> 1;
  const tint = l === 'zh' ? 'rgb(118,32,36)' : l === 'zh-hant' ? 'rgb(96,36,32)' : l === 'ja' ? 'rgb(52,44,62)' : K.NAVY;
  rect(x0 + 3, y0 + 3, x1 + 3, y1 + 3, K.INK);
  rect(x0, top, x1, bot, tint);
  outline(x0 + 4, top + 4, x1 - 4, bot - 4, hover ? K.CLAUDE_L : K.GOLD);
  txt(cx, top + 10, t.name, 12, K.GOLD, 'ma');
  txt(cx, top + 30, t.code, 8, K.GOLD, 'ma');
  txt(cx, y1 + 6, t.line1, 8, K.GREY, 'ma');
  txt(cx, y1 + 17, t.line2, 8, K.GREY_D, 'ma');
  if (!PICK) return;
  darken(PICK.lang === l ? 0.6 : 0.72, C.INK, [x0, top, x1 + 1, bot + 1]);
  if (PICK.lang !== l) return;
  const s = sprite('stamp:approve');
  const k = Math.min(2, (CARD_W - 8) / s[2]);
  G.drawImage(ATLAS_IMG, s[0], s[1], s[2], s[3], cx - (s[2] * k) / 2, ((top + bot) >> 1) - (s[3] * k) / 2 + 5, s[2] * k, s[3] * k);
}

function drawLangPick() {
  drawBg();
  darken(0.86);
  spr('title_emblem', 298, 12);
  bigText(W / 2, 64, 'IP, PLEASE', 12, 3, K.WHITE, K.INK);
  txt(W / 2, 106, T(MOD.subtitle) + ' · MOD', 10, K.CLAUDE_L, 'ma');
  for (const l of LANGS) drawLangCard(l);
  const gag = PICK && PICK.gag && now > PICK.t0 + 0.45;
  if (gag) {
    const [x0, y0] = GAG_BOX, cx = (GAG_BOX[0] + GAG_BOX[2]) >> 1;
    rect(...GAG_BOX, K.INK); outline(...GAG_BOX, K.RED);
    txt(cx, y0 + 6, T('信息不符  DISCREPANCY'), 12, K.RED_L, 'ma');
    txt(cx, y0 + 22, PICK.gag.sub, 10, K.WHITE, 'ma');
    txt(cx, y0 + 34, PICK.gag.quip, 10, K.CLAUDE_L, 'ma');
    txt(cx, y0 + 47, PICK.gag.note, 8, K.GREY, 'ma');
  } else {
    txt(W / 2, 232, T('你的设备 YOUR DEVICE    时区 TZ: {0}    语言 LANG: {1}', DEVICE.tz, DEVICE.lang), 8, K.GREY, 'ma');
    txt(W / 2, 244, T('* 切换语言不会改变你的 IP 归属 · Switching language does not change your IP'), 8, K.GREY_D, 'ma');
  }
  txt(W / 2, 302, T('建议横屏、打开声音 · 鼠标或手指拖动证件 · 全程约 30 分钟'), 8, K.GREY, 'ma');
  txt(W / 2, 332, T('致敬 Lucas Pope《Papers, Please》 · 画面音效均由程序生成'), 8, K.GREY_D, 'ma');
  if (LANG === 'zh') {   // 简体原文的这两行本来就是中英对照，其余语言各显示自己那一行就够
    txt(W / 2, 313, 'Landscape + sound on · Drag papers with mouse or finger · About 30 min', 8, K.GREY, 'ma');
    txt(W / 2, 343, "A tribute to Lucas Pope's Papers, Please · All art and sound made by code", 8, K.GREY_D, 'ma');
  }
}
