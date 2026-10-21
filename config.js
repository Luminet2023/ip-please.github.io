'use strict';
// File Zero's identity and storage are shared by the game and browser tools.
const MOD = Object.freeze({
  id: 'ip-please-file-zero',
  title: 'IP, PLEASE：零号档案',
  subtitle: '零号档案',
  author: '茗 / wess09',
  originalUrl: 'https://ip-please.github.io/',
  siteUrl: 'https://ip-please-zero.azurpilot.com/',
});

const STORAGE_KEYS = Object.freeze({
  save: MOD.id + '-save-v1',
  endings: MOD.id + '-endings-v1',
  lastEnding: MOD.id + '-last-ending-v1',
  language: MOD.id + '-lang',
});

if (typeof module !== 'undefined' && module.exports) module.exports = { MOD, STORAGE_KEYS };
