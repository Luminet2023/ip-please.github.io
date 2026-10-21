#!/usr/bin/env node
'use strict';
// Real Chromium playthrough. Game state is read for assertions/strategy; all
// gameplay uses Playwright mouse input. No case/ending functions are invoked.
// Install: npm install --no-save --package-lock=false playwright
// Run: node tools/browser_playthrough.js [--headed] [--lang=en]
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'test-results');
const language = process.argv.includes('--lang=en') ? 'en' : 'zh';
const focused = process.argv.includes('--regressions');
const report = { language, days: [], cases: [], evidence: [], errors: [], ending: null };
fs.mkdirSync(OUT, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser, page, server;
async function state() {
  return page.evaluate(() => ({ scene, day: S.day, elapsed: st(), now,
    ending: S.plot.final.ending, savings: S.savings, family: S.family,
    plot: S.plot, stats: S.stats,
    summary: typeof SUM !== 'undefined' && scene === 'summary' ? { boxes: SUM.boxes, rows: SUM.rows, on: SUM.on, balance: sumBalance() } : null,
    booth: B && { idx: B.idx, queue: B.queue.length, ending: B.ending,
      inspect: B.insp.on, tray: B.tray.open, trayX: trayX(), trayU: trayU(),
      evidence: B.evidence && { id: B.evidence.evId, labels: B.evidence.labels,
        ready: B.docs.some((d) => d.doc === B.evidence.doc) },
      keepable: B.keepable && !!B.keepable.inst, cut: !!B.cut, closeup: !!B.closeup,
      final: B.finalPhase && { index: B.finalIndex, papers: B.finalPapers },
      event: B.event && { type: B.event.type, i: B.event.i, lock: B.event.lock,
        ok: B.event.list?.[B.event.i]?.ok,
        clones: B.event.items?.filter((c) => c.state === 'run').map((c) => ({ x: clonePos(c)[0], y: c.y - 6 })) },
      docs: B.docs.map((d) => ({ key: d.key, owner: d.owner, x: d.x, y: d.y, big: d.big, w: d.doc.w, h: d.doc.h, fields: d.doc.fields, marks: d.marks })),
      ent: B.ent && { caseId: B.ent.spec.caseId, person: B.ent.spec.person,
        primary: B.ent.spec.primary, ok: B.ent.spec.ok, phase: B.ent.phase,
        handed: B.ent.handed, busyUntil: B.ent.busyUntil, decided: B.ent.decided, noJudge: !!B.ent.noJudge,
        issues: (B.ent.spec.issues || []).map((i) => ({ pairs: i.pairs, all: i.all, title: i.title })), found: B.ent.found.size,
        printedDocs: (B.ent.spec.printedDocs || []).map((d) => d.key),
      },
    },
  }));
}
async function point(x, y) {
  const r = await page.locator('#game').boundingBox();
  return { x: r.x + x * r.width / 640, y: r.y + y * r.height / 360 };
}
async function click(x, y) { const p = await point(x, y); await page.mouse.click(p.x, p.y); }
async function dragDoc(d, x, y) {
  const pick = await page.evaluate(({ key, owner }) => {
    const target = [...B.docs].reverse().find((p) => p.key === key && p.owner === owner);
    if (!target) return null;
    const items = [...B.docs].reverse();
    for (let y = target.y + 2; y < Math.min(318, target.y + (target.big ? target.doc.h : 12)); y += 3) {
      for (let x = target.x + 3; x < Math.min(636, target.x + (target.big ? target.doc.w : 18)); x += 4) {
        if (target.big && !inBox(x, y, DESK)) continue;
        const top = items.find((p) => inBox(x, y, p.big ? docBox(p) : [p.x, p.y, p.x + 18, p.y + 12]));
        if (top === target) return { x, y, dx: x - target.x, dy: y - target.y, big: target.big };
      }
    }
    return null;
  }, { key: d.key, owner: d.owner });
  if (!pick) throw new Error('Document is covered: ' + d.key);
  const from = await point(pick.x, pick.y);
  const to = await point(x + (pick.big ? pick.dx : Math.min(24, d.w / 2)), y + (pick.big ? pick.dy : 12));
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 3 }); await page.mouse.up();
}
async function waitFor(fn, label, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const s = await state(); if (fn(s)) return s; await delay(30); }
  throw new Error('Timeout: ' + label + '\n' + JSON.stringify(await state()));
}
async function inspectMode(on) {
  const s = await state(); if (s.booth.inspect !== on) await click(618, 338);
}
async function tray(on) {
  for (let i = 0; i < 80; i++) {
    const s = await state(), u = s.booth.trayU;
    if (s.booth.tray === on && (on ? u > 0.99 : u < 0.01)) return;
    if (u < 0.01 || u > 0.99) await click(s.booth.trayX - 7, 224);
    await delay(50);
  }
  throw new Error('Tray did not settle');
}
async function investigate(e) {
  for (const issue of e.issues) {
    const pair = issue.pairs?.find((p) => p.every((k) => k.includes('.') && !k.startsWith('rule.') || k === 'rule.body'));
    if (!pair) continue;
    const docKeys = [...new Set(pair.map((k) => k.split('.')[0]))];
    let s = await state();
    if (!docKeys.every((k) => s.booth.docs.some((d) => d.key === k))) continue;
    await inspectMode(false); await tray(false);
    for (let i = 0; i < docKeys.length; i++) {
      s = await state(); const d = s.booth.docs.find((d) => d.key === docKeys[i]);
      await dragDoc(d, 224 + i * 200, 172);
    }
    await inspectMode(true);
    for (const key of pair) {
      const p = await page.evaluate((key) => {
        // Locate a visible field through the same hit-test used by the UI.
        for (let y = 174; y < 316; y += 2) for (let x = 222; x < 636; x += 3) {
          const f = fieldAt(x, y); if (f?.key === key) return [x, y];
        }
        return null;
      }, key);
      if (!p) throw new Error('Field is unreachable: ' + e.caseId + ' ' + key);
      await click(...p);
    }
  }
  await inspectMode(false);
}
async function evidence(s) {
  const ev = s.booth.evidence;
  if (!ev.ready) { await delay(60); return; }
  // Let the printer's delayed tray-open finish before touching its handle.
  await delay(120);
  await inspectMode(false); await tray(true);
  const choice = ev.id === 'familyPass' || ev.id === 'sysLicense' ? 2 : 0;
  const current = await state();
  await click(current.booth.trayX + 34 + choice * 53, 224);
  const after = await state();
  if (after.booth.evidence?.id === ev.id) throw new Error('Evidence click failed: ' + ev.id);
  const expected = ['retained', 'submitted', 'destroyed'][choice];
  if (after.plot.evidenceHistory.at(-1)?.action !== expected) throw new Error('Wrong evidence button: ' + ev.id);
  report.evidence.push({ day: s.day, id: ev.id, choice: ev.labels?.[choice] || ['retained', 'submitted', 'destroyed'][choice] });
}
async function entrant(s) {
  const e = s.booth.ent;
  await waitFor((v) => v.booth.ent?.handed && v.booth.ent.phase === 'here' && v.now >= v.booth.ent.busyUntil, 'documents: ' + e.person);
  await waitFor((v) => v.booth.ent.printedDocs.every((key) => v.booth.docs.some((d) => d.key === key)), 'printed documents');
  if (e.caseId === 'D04-GROK') await page.screenshot({ path: path.join(OUT, language + '-grok-transparent.png') });
  await investigate((await state()).booth.ent);
  if (e.caseId === 'D02-QWEN') await page.screenshot({ path: path.join(OUT, language + '-qwen-papers.png') });
  s = await state();
  // An investigation may print a sheet while its applicant is still present.
  while (s.booth.evidence) { await evidence(s); await delay(80); s = await state(); }
  const note = s.booth.docs.find((d) => d.key === 'note');
  if (note) await dragDoc(note, 100, 280);
  // Decline the optional early exits so this route reaches day 14.
  const earlyExit = ['D13-RETIRE', 'D05-RELAY', 'D12-QWEN-DISPUTE'].includes(e.caseId);
  const decision = earlyExit ? 'deny' : e.ok.includes('approve') ? 'approve' : 'deny';
  await tray(false);
  // Return secondary papers, then position the stamped primary at the mark.
  for (const d of (await state()).booth.docs.filter((d) => d.owner === 'ent' && d.key !== e.primary && d.big)) {
    await dragDoc(d, 100, 280);
  }
  s = await state();
  const d = s.booth.docs.find((d) => d.owner === 'ent' && d.key === e.primary);
  if (!d) throw new Error('Missing primary: ' + e.caseId);
  const cx = decision === 'approve' ? 512 : 591;
  await dragDoc(d, cx - d.w + 20, Math.max(132, 249 - d.h));
  // Nested passports can fall onto the stamp position after first placement.
  await delay(100);
  const primary = (await state()).booth.docs.find((d) => d.owner === 'ent' && d.key === e.primary);
  await click(primary.x + 3, primary.y + 2);
  await tray(true); await click(decision === 'approve' ? 512 : 592, 224);
  await waitFor((v) => v.booth.ent?.decided === decision, 'stamp: ' + e.caseId);
  await delay(100); await tray(false);
  const stamped = (await state()).booth.docs.find((d) => d.owner === 'ent' && d.key === e.primary);
  await dragDoc(stamped, 100, 280);
  await waitFor((v) => !v.booth.ent || v.scene !== 'booth', 'return documents: ' + e.caseId);
  report.cases.push({ day: s.day, caseId: e.caseId || e.person, decision, investigated: s.booth.ent.found > 0 });
}
async function main() {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.resolve(ROOT, '.' + (rel === '/' ? '/index.html' : rel));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream'); res.end(data); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: !process.argv.includes('--headed') });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', timezoneId: 'Asia/Shanghai' });
  await context.addInitScript(() => {
    let seed = 713;
    Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => raf((ts) => callback(ts * 12));
  });
  page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => typeof scene !== 'undefined' && typeof canvasEl !== 'undefined' && canvasEl);
  if (focused) {
    await page.waitForFunction(() => !!ATLAS_IMG && !!FONT_IMG && !!WIN_IMG);
    report.checks = await require('./browser_regressions')({ page, state, click, dragDoc, waitFor, inspectMode, language, out: OUT });
    if (report.errors.length) throw new Error(report.errors.join('; '));
    console.log('PASS: ' + language + ' screenshot regressions (' + report.checks.length + ' checks)');
    return;
  }
  const until = Date.now() + 240000;
  let lastProgress = '', stallAt = Date.now();
  while (Date.now() < until) {
    const s = await state();
    const progress = [s.scene, s.day, s.booth?.idx, s.booth?.ent?.phase, s.booth?.evidence?.id, s.booth?.final?.index].join(':');
    if (progress !== lastProgress) { lastProgress = progress; stallAt = Date.now(); }
    if (Date.now() - stallAt > 20000) throw new Error('Playthrough stalled: ' + progress);
    if (s.scene === 'boot') { await click(language === 'en' ? 410 : 230, 170); }
    else if (s.scene === 'intro') await click(320, 300);
    else if (s.scene === 'title') await click(250, 305);
    else if (s.scene === 'news') await click(320, 310);
    else if (s.scene === 'summary') {
      if (!report.days.some((d) => d.day === s.day)) {
        await delay(300);
        const current = await state();
        report.days.push({ day: s.day, stats: s.stats, savings: current.summary.balance, family: s.family, plot: s.plot });
        await page.screenshot({ path: path.join(OUT, language + '-day-' + s.day + '.png') });
        console.log('DAY ' + s.day + ' complete; savings=' + current.summary.balance + '; cases=' + report.cases.length);
      }
      if (s.elapsed > 5) await click(500, 320);
    } else if (s.scene === 'ending') {
      report.ending = s.ending; report.final = s;
      await delay(350); await page.screenshot({ path: path.join(OUT, language + '-ending.png') });
      if (s.day !== 14 || s.ending !== 'E29') throw new Error('Unexpected ending: DAY ' + s.day + ' ' + s.ending);
      if (report.errors.length) throw new Error('Browser errors: ' + report.errors.join('; '));
      console.log('PASS: full 14-day browser playthrough, ' + report.cases.length + ' applicants, ending ' + s.ending);
      return;
    } else if (s.ending) await delay(60);
    else if (s.scene === 'booth') {
      const b = s.booth;
      if (b.event?.type === 'rush') { if (!b.event.lock && b.event.ok) await click(b.event.ok === 'approve' ? 325 : 515, 240); }
      else if (b.event?.type === 'clones') { for (const c of b.event.clones || []) await click(c.x, c.y); }
      else if (b.cut || b.closeup) await click(320, 300);
      else if (b.evidence) await evidence(s);
      else if (b.keepable) { const d = b.docs.find((d) => d.key === 'zticket'); if (d) await dragDoc(d, 228, 322); }
      else if (b.final) {
        const index = b.final.papers.findIndex((p) => p.ending === 'E29');
        if (index < 0) throw new Error('True ending paper unavailable: ' + JSON.stringify(s.plot));
        if (b.final.index !== index) await click(410, 336);
        else {
          await tray(false); const d = (await state()).booth.docs.find((d) => d.key === 'final');
          await dragDoc(d, 512 - d.w + 20, Math.max(132, 249 - d.h));
          await tray(true); await click(512, 224);
        }
      } else if (b.ent?.noJudge) await delay(60);
      else if (b.ent && !b.ending) await entrant(s);
      else if (!b.ending && b.idx < b.queue) await click(15, 298);
    }
    await delay(25);
  }
  throw new Error('Playthrough exceeded four minutes');
}
main().catch(async (error) => {
  report.failure = error.stack; console.error(error.stack);
  if (page) { report.failureState = await state().catch(() => null); await page.screenshot({ path: path.join(OUT, language + '-failure.png') }).catch(() => {}); }
  process.exitCode = 1;
}).finally(async () => {
  fs.writeFileSync(path.join(OUT, language + (focused ? '-regressions.json' : '-playthrough.json')), JSON.stringify(report, null, 2));
  await browser?.close(); server?.close();
});
