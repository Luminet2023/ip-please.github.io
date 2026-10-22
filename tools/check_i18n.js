#!/usr/bin/env node
// 查各语言缺哪些译文：扫根目录 JS 里所有含中文的字符串字面量，看 en.js / zh-hant.js / ja.js 里有没有对应的键。
//
//   node tools/check_i18n.js            # 查全部语言
//   node tools/check_i18n.js ja         # 只查日文
//
// - 地名这类“中国 · 浙江 · 电信”，每一段都有译文就算有
// - 'dv.归属' 这种检查模式的栏位引用不显示，跳过
// - 拼接出来的含中文模板字符串（`…${x}…`）翻不了，会单独列出来，改成 T('…{0}…', x)
// - i18n.js（开局多语言画面）、译文文件、assets.js 不扫
// - 顺便检查译文里的 {0} 占位符数量是否和原文一致（少一个运行时会漏字）
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['assets.js', 'en.js', 'zh-hant.js', 'ja.js', 'i18n.js']);
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;

const DICTS = {};
for (const [lang, file, name] of [['en', 'en.js', 'EN'], ['zh-hant', 'zh-hant.js', 'ZH_HANT'], ['ja', 'ja.js', 'JA']]) {
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), 'utf8') + `\nthis.D = typeof ${name} === 'undefined' ? {} : ${name};`, ctx);
  DICTS[lang] = ctx.D;
}

// 原文键：en.js 的键就是全部原文（其余语言以中文原句为键）
const KEYS = Object.keys(DICTS.en);

// 粗糙的 JS 词法：只为了拿到字符串字面量（跳过注释和正则）
function literals(src) {
  const out = [];
  let i = 0, line = 1, prev = '';
  const read = (q) => {
    let s = '', parts = [];
    const start = line;
    for (i++; i < src.length && src[i] !== q; i++) {
      if (src[i] === '\\') { s += src[i + 1]; i++; continue; }
      if (src[i] === '\n') line++;
      if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
        let depth = 1, j = i + 2;
        while (depth && j < src.length) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
        out.push(...literals(src.slice(i + 2, j - 1)).map((l) => ({ ...l, line: l.line + line - 1 })));
        parts.push(s); s = ''; i = j - 1;
        continue;
      }
      s += src[i];
    }
    parts.push(s);
    out.push({ s: parts.join('{…}'), line: start, tpl: parts.length > 1 });
    i++;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); line += src.slice(i, j).split('\n').length - 1; i = j + 2; continue; }
    if (c === '"' || c === "'" || c === '`') { read(c); prev = 'x'; continue; }
    if (c === '/' && /[(,=:[!&|?{};]|^$/.test(prev)) {
      for (i++; i < src.length && src[i] !== '/'; i++) if (src[i] === '\\') i++;
      i++; prev = 'x'; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

function placeholders(s) {
  return (String(s).match(/\{\d\}/g) || []).sort().join(',');
}

const want = process.argv[2];
const langs = want ? [want] : Object.keys(DICTS);
let bad = 0;

for (const lang of langs) {
  const dict = DICTS[lang] || {};
  const has = (s) => Object.prototype.hasOwnProperty.call(dict, s) || (s.includes(' · ') && s.split(' · ').every(has));
  const problems = [];

  // 1. 译文缺键
  let missing = 0;
  for (const f of fs.readdirSync(ROOT).filter((f) => f.endsWith('.js') && !SKIP.has(f)).sort()) {
    for (const { s, line, tpl } of literals(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
      if (!CJK.test(s) || /^[a-z0-9]+\.\S+$/.test(s)) continue;
      if (tpl) { problems.push(`${f}:${line}  拼接的中文（改成 T 模板）：${s}`); continue; }
      if (!has(s)) { missing++; problems.push(`${f}:${line}  缺译文：${s}`); }
    }
  }

  // 2. 占位符数量对不上（会漏字或原文露馅）
  let ph = 0;
  for (const k of KEYS) {
    if (!Object.prototype.hasOwnProperty.call(dict, k)) continue;
    if (placeholders(k) !== placeholders(dict[k])) {
      ph++;
      problems.push(`占位符不一致：${k}  →  ${dict[k]}`);
    }
  }

  if (problems.length) {
    console.log(`\n=== ${lang} ===`);
    for (const p of problems) console.log(p);
  }
  console.log(`${lang}: ${problems.length ? `${missing} 条缺译文，${ph} 条占位符不一致` : '译文齐全'}（共 ${KEYS.length} 条原文）`);
  bad += problems.length;
}

process.exit(bad ? 1 : 0);
