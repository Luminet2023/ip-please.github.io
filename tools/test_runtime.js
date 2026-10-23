// Shared, deterministic runtime for story regression tests. No browser APIs are replaced in the game itself.
'use strict';
module.exports = function createRuntime(seed = 20261021) {
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function makeCtx() {
  const c = {
    canvas: null, imageSmoothingEnabled: false, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    globalCompositeOperation: 'source-over', font: '',
  };
  const noop = () => {};
  for (const m of ['fillRect', 'clearRect', 'strokeRect', 'drawImage', 'beginPath', 'rect', 'clip', 'save', 'restore',
    'translate', 'scale', 'moveTo', 'lineTo', 'stroke', 'fill', 'arc', 'ellipse', 'closePath', 'fillText',
    'createLinearGradient', 'setTransform', 'putImageData', 'rotate']) c[m] = noop;
  return c;
}

function makeCanvas(w = 300, h = 150) {
  const cv = {
    width: w, height: h, style: {}, dataset: {},
    getContext: () => makeCtx(),
    addEventListener: () => {}, setAttribute: () => {}, removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    setPointerCapture: () => {}, parentNode: { classList: { remove: () => {} } },
  };
  return cv;
}

let randomState = seed >>> 0;
const seededMath = Object.create(Math);
seededMath.random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 4294967296);
const sandbox = {
  console, Math: seededMath, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map, Promise, Infinity, NaN,
  setTimeout, clearTimeout, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = {
  documentElement: { lang: '', style: {}, requestFullscreen: null },
  createElement: (tag) => (tag === 'canvas' ? makeCanvas(1, 1) : { style: {}, dataset: {}, appendChild: () => {} }),
  getElementById: () => makeCanvas(640, 360),
  querySelectorAll: () => [],
  addEventListener: () => {},
  title: '',
};
sandbox.navigator = { language: 'zh-CN', userAgent: 'node' };
sandbox.localStorage = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
})();
sandbox.addEventListener = () => {};
sandbox.requestAnimationFrame = () => 0;
sandbox.performance = { now: () => Date.now() };
sandbox.Image = class { set src(v) { this._src = v; } get src() { return this._src; } };
sandbox.AudioContext = class { constructor() { this.destination = {}; this.currentTime = 0; } createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; } createOscillator() { return { type: '', frequency: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {}, disconnect() {} }; } createBuffer() { return { getChannelData: () => new Float32Array(64) }; } createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {} }; } createBiquadFilter() { return { type: '', frequency: { value: 0, setValueAtTime() {} }, connect() {} }; } createStereoPanner() { return { pan: { value: 0, setValueAtTime() {} }, connect() {} }; } };
sandbox.webkitAudioContext = sandbox.AudioContext;

vm.createContext(sandbox);

const files = ['config.js', 'assets.js', 'en.js', 'zh-hant.js', 'ja.js', 'i18n.js', 'gfx.js', 'sfx.js', 'docs.js', 'data.js',
  'plot.js', 'endings.js', 'booth.js', 'events.js', 'screens.js', 'main.js', 'endless.js'];
for (const f of files) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: f });
  } catch (e) {
    console.error(`✗ 载入 ${f} 失败：`, e.message);
    process.exit(1);
  }
}

const run = (code) => vm.runInContext(code, sandbox);


return { run, sandbox };
};
