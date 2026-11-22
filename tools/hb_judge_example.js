'use strict';
// 红包凭证的验签参考实现：给 LINUX DO 红包站的代码判定红包（judge）抄用。
// 只依赖 WebCrypto（浏览器 / Node 20+ / Deno / Cloudflare Workers 的 globalThis.crypto.subtle）。
// 凭证格式见 AGENT.md「红包凭证」。公钥取自 GET https://api.luminet.cn/anthropic/v1/hb/jwks，
// 建议直接内置在 judge 里（judge 不用联网，也不怕接口临时不可用）。
//
//   const r = await verifyVoucher(token, {
//     jwks,                       // {keys:[…]}，内置或 fetch 来的
//     board: 'daily',             // 红包要求的榜
//     period: '2026-11-22',       // 可选：要求的周期（日榜日期 / 周榜 2026-W47 / 总榜 all）
//     minScore: 3000,             // 可选：最低分
//     nonce: 'hb-001',            // 可选：要求凭证绑定这个红包编号
//     linuxdoId: '12345',         // 可选：judge 能拿到领取人 ID 时一定要传
//   });
//   r.ok ? r.claims.score : r.reason

const ISSUER = 'https://api.luminet.cn/anthropic';
const AUDIENCE = 'ip-please-hb';
const TYPE = 'ip-please-hb+jwt';
const GAME = 'ip-please';
const CLOCK_SKEW_SECS = 60;

function b64urlBytes(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function b64urlJson(text) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(text)));
}

async function verifyVoucher(token, options) {
  const fail = (reason) => ({ ok: false, reason });
  const { jwks, board, period, minScore, nonce, linuxdoId, issuer = ISSUER } = options || {};
  const now = options && Number.isFinite(options.now) ? options.now : Math.floor(Date.now() / 1000);
  if (typeof token !== 'string' || token.length > 4096) return fail('bad_format');
  const parts = token.trim().split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return fail('bad_format');

  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch (_) { return fail('bad_format'); }
  // 只接受 ES256：拒绝 none / HS256 之类的算法混淆。
  if (header.alg !== 'ES256' || header.typ !== TYPE) return fail('bad_header');
  const jwk = jwks && Array.isArray(jwks.keys) && jwks.keys.find((k) => k.kid === header.kid && k.kty === 'EC' && k.crv === 'P-256');
  if (!jwk) return fail('unknown_key');

  let valid = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    // JWS 的 ES256 签名就是 64 字节 r||s，和 WebCrypto 的格式一致。
    valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlBytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1]));
  } catch (_) { valid = false; }
  if (!valid) return fail('bad_signature');

  if (claims.iss !== issuer || claims.aud !== AUDIENCE || claims.game !== GAME) return fail('wrong_issuer');
  if (!Number.isSafeInteger(claims.exp) || claims.exp + CLOCK_SKEW_SECS < now) return fail('expired');
  if (!Number.isSafeInteger(claims.iat) || claims.iat - CLOCK_SKEW_SECS > now) return fail('not_yet_valid');
  if (board !== undefined && claims.board !== board) return fail('wrong_board');
  if (period !== undefined && claims.period !== period) return fail('wrong_period');
  if (nonce !== undefined && claims.nonce !== nonce) return fail('wrong_nonce');
  if (linuxdoId !== undefined && claims.sub !== String(linuxdoId)) return fail('wrong_user');
  if (minScore !== undefined && !(Number.isSafeInteger(claims.score) && claims.score >= minScore)) return fail('score_too_low');
  return { ok: true, claims };
}

if (typeof module !== 'undefined') module.exports = { verifyVoucher, ISSUER, AUDIENCE, TYPE, GAME };
