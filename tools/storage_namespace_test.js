'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const createRuntime = require('./test_runtime');
const { MOD, STORAGE_KEYS } = require('../config');
const { run } = createRuntime(713);

assert.equal(new Set(Object.values(STORAGE_KEYS)).size, 4);
assert.ok(Object.values(STORAGE_KEYS).every(key => key.startsWith('ip-please-file-zero-')));
run(`newGame(); S.day=6; var legacyState=JSON.stringify(S);
var legacy={
 'ip-please-save-v1':legacyState,
 'ip-please-endings-v1':'["E27"]',
 'ip-please-last-ending-v1':legacyState,
 'ip-please-lang':'en'
};
for(const [key,value] of Object.entries(legacy))localStorage.setItem(key,value);`);
assert.equal(run('loadSave()'), null);
assert.deepEqual(Array.from(run('unlockedEndings()')), []);
assert.equal(run('initialLang()'), 'zh');
console.log('✓ original/legacy save, archive and language cannot enter File Zero');

run('S.day=7;saveGame();');
assert.equal(run('loadSave().day'), 7);
assert.equal(run('JSON.parse(localStorage.getItem(STORAGE_KEYS.save)).day'), 7);
run('newGame();migrateSave(loadSave());');
assert.equal(run('S.day'), 7);
run(`setLang('en');archiveEnding('E29');scene='title';commitEnding('E27');`);
assert.equal(run('localStorage.getItem(STORAGE_KEYS.language)'), 'en');
assert.deepEqual(Array.from(run('unlockedEndings()')), ['E29', 'E27']);
assert.equal(run('JSON.parse(localStorage.getItem(STORAGE_KEYS.lastEnding)).plot.final.ending'), 'E27');
assert.equal(run('localStorage.getItem(STORAGE_KEYS.save)'), null);
assert.equal(run('Object.entries(legacy).every(([key,value])=>localStorage.getItem(key)===value)'), true);
console.log('✓ save/continue, clear, ending commits and language changes preserve every legacy key');

assert.equal(run('document.title'), 'IP, PLEASE: File Zero');
run(`var opened=null;window.open=(...args)=>opened=args;scene='ending';sceneT0=now-5;
sceneClick(...center(MOD_CREDIT_LINK));`);
assert.equal(run('opened[0]'), MOD.originalUrl);
assert.equal(run('opened[2]'), 'noopener,noreferrer');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
assert.ok(html.includes('<title>' + MOD.title + '</title>'));
// 云同步版部署在自己的站点，分享卡片（og:url / og:image）沿用本站设置，不指向 MOD.siteUrl
assert.ok(!html.includes(MOD.siteUrl));
assert.ok(html.indexOf('src="config.js') < html.indexOf('src="i18n.js'));
assert.ok(html.indexOf('src="config.js') < html.indexOf('src="cloud.js'));
console.log('✓ bilingual name and clickable original credit agree; sharing metadata stays on this site');
