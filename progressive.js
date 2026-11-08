'use strict';
// Only server-published rules grant skills. Legacy saved runs keep their full rulebook.
function endlessSkill(key) {
  const p = S.endless && window.Endless && Endless.run()?.progression;
  return !p || p.active_rules.includes(key);
}
const ConstitutionGuide = (() => {
  let runId = null, progression = null, acknowledged = -1, announced = -1, started = 0, saving = false;
  const key = () => 'ip-please-endless-rules-v3:' + runId;
  function reset(run) {
    runId = run?.run_id; progression = run?.progression || null;
    acknowledged = -1; announced = -1; saving = false;
    if (progression) {
      try { const value = JSON.parse(gameStorage.getItem(key()) || '-1'); if (Number.isInteger(value)) acknowledged = value; }
      catch (_) { /* A new review remains available if storage is unreadable. */ }
    }
  }
  function sync(run) {
    if (runId !== run.run_id) reset(run);
    progression = run.status === 'ended' ? null : run.progression || null;
  }
  function unread() { return !!(S.endless && progression && acknowledged < progression.stage); }
  function idle() { return B && !B.ent && !B.event && !B.cut && !B.closeup && !drag; }
  function refreshBook(focus) {
    if (!B?.ruleInst) return;
    const old = B.ruleInst.doc;
    const book = new Rulebook(S.day);
    book.page = focus ? book.pages.findIndex(p => progression.new_rules.some(k => p.fields[k])) : Math.min(old.page, book.npages - 1);
    if (book.page < 0) book.page = 0;
    B.ruleInst.doc = book;
  }
  function update() {
    if (!unread() || !idle() || announced === progression.stage) return;
    announced = progression.stage; started = now;
    refreshBook(true);
    flash(T('新章 {0}：打开宪法查看 NEW 条款', progression.stage + 1));
  }
  async function opened() {
    if (!unread() || saving || !B?.ruleInst) return;
    refreshBook(true);
    const id = runId, stage = progression.stage;
    saving = true;
    try {
      gameStorage.setItem(key(), JSON.stringify(stage));
      if (window.GameHost) await GameHost.flush();
      if (runId === id) {acknowledged = stage; saving = false; if (window.Endless) Endless.reviewed();}
    } catch (_) {
      if (runId === id) {saving = false; flash('规则阅读记录未保存，请重试打开宪法');}
    }
  }
  function click(x, y) {
    if (!unread() || !idle() || !inBox(x, y, BOOK_BOX)) return false;
    if (!B.ruleInst) toggleRules(); else opened();
    return true;
  }
  function draw() {
    if (!unread() || !idle()) return;
    update();
    const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const age = now - started;
    // Two brief page strokes; the final clear outline remains steady until reviewed.
    const pulse = !reduced && age < 1.4 ? Math.sin(age * Math.PI * 3) * 2 : 0;
    outline(BOOK_BOX[0]-3-pulse, BOOK_BOX[1]-3-pulse, BOOK_BOX[2]+3+pulse, BOOK_BOX[3]+3+pulse, K.CLAUDE_L);
    rect(526, 282+pulse, 530, 289+pulse, K.CLAUDE_L);
    for (let i=0;i<5;i++) rect(523+i, 289+i+pulse, 533-i, 289+i+pulse, K.CLAUDE_L);
    if (!reduced && age < 0.8) {
      const x = 514 + age * 20;
      outline(x, 316, x+19, 343, K.PAPER);
    }
    txt(528, 297, 'NEW', 8, K.CLAUDE_L, 'ma');
  }
  return {reset, sync, unread, update, opened, click, draw};
})();
