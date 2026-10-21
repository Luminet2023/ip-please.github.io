'use strict';
const fs = require('node:fs');
const path = require('node:path');
const escape = value => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function renderEndingReport(file) {
  const { results, started, mode } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const passed = results.filter(r => r.ok).length;
  const cards = [...results].sort((a,b) => a.id.localeCompare(b.id)).map(r => `
    <article>
      <h2>${escape(r.id)} · ${r.ok ? '通过' : '失败'}</h2>
      <p>第 ${r.day || '?'} 天 · ${r.cases || 0} 位旅客 · 浏览器异常 ${r.errors?.length || 0}</p>
      <a href="${r.id}-playthrough.json">完整操作记录</a>
      <img loading="lazy" src="${r.id}-${r.ok ? 'ending' : 'failure'}.png" alt="${r.id} 实测截图">
      ${r.failure ? '<pre>' + escape(r.failure.slice(0, 500)) + '</pre>' : ''}
    </article>`).join('');
  const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IP PLEASE · 全结局实测</title>
<style>
body { background:#24211f; color:#eee; font:16px/1.6 system-ui; margin:32px }
main { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr)); gap:20px }
article { background:#42372f; padding:16px } h2 { margin:0 }
img { display:block; width:100%; image-rendering:pixelated; margin-top:12px }
a { color:#eab87c } pre { white-space:pre-wrap; overflow-wrap:anywhere }
</style>
<h1>${passed}/${results.length} 个结局通过</h1>
<p>每条路线从第 1 天开始，使用浏览器鼠标操作。E30 沿用本次实测解锁的结局收藏。</p>
<p>开始时间 ${escape(started)} · ${escape(mode)}</p>
<main>${cards}</main></html>`;
  const output = path.join(path.dirname(file), 'all-endings.html');
  fs.writeFileSync(output, html);
  return output;
}
module.exports = renderEndingReport;
if (require.main === module) console.log(renderEndingReport(process.argv[2] || path.join(__dirname, 'test-results', 'all-endings.json')));
