'use strict';
// Strategy only. These functions never modify the game or unlock an ending.
const IDS = Array.from({ length: 30 }, (_, i) => 'E' + String(i + 1).padStart(2, '0'));
const bribed = new Set(['E13', 'E14', 'E15', 'E24']);
function verdict(target, e) {
  const id = e.caseId;
  if (target === 'E23') return e.ok.includes('approve') ? 'deny' : 'approve';
  if (id === 'D14-AUTHOR') return ['E01', 'E28'].includes(target) ? 'detain' : target === 'E26' ? 'deny' : 'approve';
  if (id === 'D05-RELAY') return bribed.has(target) ? 'approve' : 'deny';
  if (id === 'D12-TRANSFER') return target === 'E02' ? 'approve' : 'deny';
  if (id === 'D12-DOUBLE') return target === 'E14' ? 'deny' : 'approve';
  if (id === 'D12-QWEN-DISPUTE') return target === 'E09' ? 'approve' : 'deny';
  if (id === 'D13-RETIRE') return target === 'E25' ? 'approve' : 'deny';
  if (id === 'D10-FISH-STATUS' && target === 'E17') return 'approve';
  if (id === 'D14-GPT' && ['E03', 'E05', 'E18'].includes(target)) return 'deny';
  if (target === 'E17' && ['D03-FISH', 'D07-FISH', 'D09-FISH-APPEAL'].includes(id)) return 'deny';
  return e.ok.includes('approve') ? 'approve' : 'deny';
}
function evidence(target, id, day) {
  if (id === 'familyPass') return target === 'E21' ? 0 : target === 'E22' ? 1 : 2;
  if (id === 'sysLicense') return target === 'E13' ? 1 : target === 'E15' ? 0 : 2;
  if (id === 'transferDoc') return target === 'E02' ? 1 : target === 'E25' ? 2 : 0;
  if (id === 'rawVideo' && target === 'E12') return day === 8 ? 2 : 0;
  if (id === 'glmSign' && target === 'E14') return 1;
  if (id === 'auditLog' && target === 'E08') return 2;
  if (id === 'kimiArchive' && target === 'E08' && day === 10) return 2;
  if (target === 'E04' && ['glmSign', 'originalFootage', 'auditLog'].includes(id)) return 2;
  return 0;
}
function investigate(target, e) {
  return !(e.caseId === 'D14-AUTHOR' && ['E01', 'E26', 'E27'].includes(target));
}
function buyPass(target, day) { return target === 'E21' || (target === 'E22' && day === 10); }
module.exports = { IDS, verdict, evidence, investigate, buyPass, keepNote: target => bribed.has(target) };
