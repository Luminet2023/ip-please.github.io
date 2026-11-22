#!/usr/bin/env node
'use strict';
// tools/hb_judge_example.js 的自测：用测试密钥按后端同样的格式签凭证，逐项检查拒绝条件。
// 后端签发 + 前端展示 + Node 验签的真实链路在 miniapp/tests/backend-browser.cjs 里。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPrivateKey, createPublicKey, sign, createHash } = require('node:crypto');
const { verifyVoucher, ISSUER, AUDIENCE, TYPE, GAME } = require('./hb_judge_example');

const priv = createPrivateKey(fs.readFileSync(path.join(__dirname, '../backend/tests/fixtures/test_hb_private.pem')));
const pub = createPublicKey(priv).export({ format: 'jwk' });
const kid = createHash('sha256').update(`{"crv":"P-256","kty":"EC","x":"${pub.x}","y":"${pub.y}"}`).digest('base64url');
const jwks = { keys: [{ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid, alg: 'ES256', use: 'sig' }] };
const now = 1_800_000_000;
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');

function token(over = {}, head = {}) {
  const header = { alg: 'ES256', typ: TYPE, kid, ...head };
  const claims = { iss: ISSUER, aud: AUDIENCE, sub: '12345', iat: now, exp: now + 900, jti: 'x', game: GAME,
    board: 'daily', period: '2026-11-22', score: 4200, travelers: 40, best_streak: 17, rank: 3,
    run_id: 'run_aaaaaaaaaaaaaaaaaaaa', achieved_at: '2026-11-22T10:00:00.000Z', nonce: 'hb-001', ...over };
  const data = b64(header) + '.' + b64(claims);
  return data + '.' + sign('sha256', Buffer.from(data), { key: priv, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

(async () => {
  const base = { jwks, now, board: 'daily', period: '2026-11-22', minScore: 3000, nonce: 'hb-001', linuxdoId: '12345' };
  const ok = await verifyVoucher(token(), base);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.claims.score, 4200);

  const cases = [
    [token(), { ...base, linuxdoId: 999 }, 'wrong_user'],
    [token(), { ...base, nonce: 'hb-002' }, 'wrong_nonce'],
    [token({ nonce: undefined }), base, 'wrong_nonce'],
    [token(), { ...base, minScore: 5000 }, 'score_too_low'],
    [token(), { ...base, board: 'weekly' }, 'wrong_board'],
    [token(), { ...base, period: '2026-11-21' }, 'wrong_period'],
    [token({ exp: now - 120 }), base, 'expired'],
    [token({ aud: 'ip-please' }), base, 'wrong_issuer'],
    [token({}, { alg: 'HS256' }), base, 'bad_header'],
    [token({}, { kid: 'other' }), base, 'unknown_key'],
    ['a.b', base, 'bad_format'],
  ];
  for (const [t, opts, reason] of cases) assert.equal((await verifyVoucher(t, opts)).reason, reason, reason);

  // 改分数不重签：签名失效。
  const [h, , s] = token().split('.');
  const forged = h + '.' + b64({ iss: ISSUER, aud: AUDIENCE, sub: '12345', iat: now, exp: now + 900, game: GAME, board: 'daily', score: 999999 }) + '.' + s;
  assert.equal((await verifyVoucher(forged, base)).reason, 'bad_signature');
  console.log('hb judge example: ' + (cases.length + 2) + ' checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
