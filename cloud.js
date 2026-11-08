'use strict';
// 云同步与登录：每日结算后把存档同步到 https://api.luminet.cn/anthropic/v1。
//
// 约定（AGENT.md「前端鉴权约定」）：
// - 浏览器只跳转 IdP 授权页，不再直接向 IdP 换 Token。回跳后把 code 交给后端
//   `/auth/callback`，由后端换码并签发本服务自己的 AT / RT（会话 sess_*）。
// - 登录时浏览器生成 login_verifier，只把它的 SHA-256 交给 `/auth/login`；回调时再出示原文，
//   这样即使 code+state 泄露，别人也兑换不了。
// - AT 有效期 600 秒，提前 60 秒刷新；401 invalid_token 时刷新并重试一次；
//   401 token_revoked（会话被吊销，包括 IdP 反向通道注销）时清理凭据并登出。
// - 与后端的错误约定见 backend/src/error.rs：DetailErrorResponse / AuthErrorResponse 双信封。

window.CloudSync = (function () {
  const CFG = {
    apiBase: 'https://api.luminet.cn/anthropic/v1',
    idpOrigin: 'https://auth.luminet.cn',
    authKey: 'ip-please-auth-v2',
    legacyAuthKey: 'ip-please-auth-v1',
    loginKey: 'ip-please-login-v2',
    metaKey: 'ip-please-sync-meta-v1',
    // 与游戏共用零号档案的存档键（config.js），不读原版的 ip-please-save-v1
    saveKey: STORAGE_KEYS.save,
    refreshAheadMs: 60 * 1000,
  };

  // 原作仓库、零号档案 mod 与致谢文案：登录面板里必须保留，说明本版合并了哪些内容。
  const platform = !!(window.GameHost && GameHost.isMiniApp);
  const tr = (text, ...args) => typeof T === 'function' ? T(text, ...args) : String(text).replace(/\{(\d)\}/g, (_, i) => args[i]);
  function node(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = tr(text);
    if (cls) n.className = cls;
    return n;
  }
  function actionButton(label, action, primary) {
    const b = node('button', label, primary ? 'primary' : '');
    b.type = 'button'; b.dataset.action = action; return b;
  }
  function credits() {
    const p = node('p', undefined, 'credit');
    p.append(document.createTextNode(tr('本页基于 ')));
    for (const [i, title, url] of [[0, 'ip-please/ip-please.github.io', 'https://github.com/ip-please/ip-please.github.io'], [1, 'wess09', 'https://github.com/wess09/ip-please-zero']]) {
      if (i) p.append(document.createTextNode(tr(' 二次开发，合并了茗（')));
      const a = node('a', title); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      if (platform) a.addEventListener('click', e => { e.preventDefault(); GameHost.openLink(url).catch(e => toast(e.message)); });
      p.append(a);
    }
    p.append(document.createTextNode(tr('）的《零号档案 · File Zero》，并新增云存档同步功能；游戏本体、剧本与美术素材版权归原作者与 mod 作者，特此致谢。')));
    return p;
  }

  // DetailErrorResponse.detail -> 业务错误码，与 backend/src/error.rs 的登记表一一对应。
  const BUSINESS_ERROR_CODES = {
    'The requested resource was not found.': 'not_found',
    'The request is invalid.': 'invalid_request',
    'Method not allowed.': 'method_not_allowed',
    'The cloud save has a newer version than the client base version.': 'sync_conflict',
    'The requested save snapshot is no longer available.': 'sync_snapshot_expired',
    'Too many sync requests. Please retry later.': 'sync_rate_limited',
    'Cloud sync storage is temporarily unavailable.': 'sync_unavailable',
    'The backend service is unavailable.': 'backend_unavailable',
    'Internal server error.': 'internal_error',
    'The request body is too large.': 'request_too_large',
    'The save payload exceeds the size limit.': 'sync_payload_too_large',
    Unauthorized: 'unauthorized',
    'The login attempt is invalid or has expired.': 'login_attempt_invalid',
    'Too many requests. Please retry later.': 'rate_limited',
    'The request ID has already been used for a different action.': 'mapp_request_conflict',
    'An endless run is already in progress.': 'endless_run_active',
    'The game rules have changed. Please reload to start a new run.': 'endless_rules_outdated',
    'The endless run state has changed. Please reload.': 'endless_state_conflict',
    "Today's daily challenge has already been played.": 'daily_already_played',
  };

  const BUSINESS_ERROR_TEXT = {
    not_found: '云端还没有存档',
    invalid_request: '请求参数有误',
    method_not_allowed: '请求方式不支持',
    sync_conflict: '云端存档比本机新',
    sync_snapshot_expired: '该云端快照已不可用',
    sync_rate_limited: '同步太频繁，请稍后再试',
    sync_unavailable: '云同步存储暂时不可用',
    backend_unavailable: '云同步服务暂时不可用',
    internal_error: '云同步服务出错了',
    request_too_large: '请求体过大',
    sync_payload_too_large: '存档超过大小上限',
    unauthorized: '请先登录',
    login_attempt_invalid: '登录校验失败，请重新登录',
    rate_limited: '操作太频繁，请稍后再试',
    endless_run_active: '已有一局无尽模式在进行中',
    endless_rules_outdated: '游戏规则已更新，请刷新页面后开始新对局',
    endless_state_conflict: '对局状态已变化，正在重新同步',
    daily_already_played: '今天的每日挑战已经玩过了',
  };

  const AUTH_ERROR_TEXT = {
    invalid_token: '登录已过期，正在重新登录',
    token_revoked: '登录状态已失效，请重新登录',
    insufficient_scope: '账号缺少所需权限',
    session_validation_failed: '鉴权服务暂时不可用',
  };

  let auth = null;
  let refreshInFlight = null;
  let busy = false;
  let loginHintShown = false;
  const authListeners = [];
  const panelSections = [];

  // ———————————————————— 小工具 ————————————————————

  function el(id) {
    return document.getElementById(id);
  }

  // 名字来自 IdP；升级前存下的登录态还没有 display_name，下次刷新 Token 后补上。
  function displayName(user) {
    return (user && user.display_name) || tr('审查员');
  }

  const AVATAR_COLORS = ['#7a3b2a', '#3b5a7a', '#4a6b3a', '#6b4a7a', '#7a6a2a', '#2a6b6b'];

  const pendingAvatars = new Map();
  let avatarObserver = null;
  function releaseAvatars(root) {
    for (const [slot, observer] of pendingAvatars) {
      if (!slot.isConnected || (root && root.contains(slot))) {
        observer.disconnect(); pendingAvatars.delete(slot);
      }
    }
  }

  // 头像：IdP 给了 https 图片就用，没有或加载失败时显示名字首字（底色按 tag 区分同名玩家）。
  function avatar(user) {
    const fallback = document.createElement('span');
    fallback.className = 'avatar';
    fallback.setAttribute('aria-hidden', 'true');
    fallback.textContent = Array.from(displayName(user))[0].toUpperCase();
    fallback.style.background = AVATAR_COLORS[(parseInt(user && user.tag, 16) || 0) % AVATAR_COLORS.length];
    if (platform) {
      const slot = node('span', undefined, 'avatar-slot'); slot.append(fallback);
      const load = async () => {
        const url = await GameHost.avatar(user && user.linuxdo_id);
        if (!url || !slot.isConnected) return;
        const img = node('img', undefined, 'avatar'); img.alt = '';
        img.addEventListener('error', () => img.replaceWith(fallback), { once: true }); img.src = url;
        slot.replaceChildren(img);
      };
      if (typeof IntersectionObserver === 'function') {
        const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { observer.disconnect(); pendingAvatars.delete(slot); load(); } });
        pendingAvatars.set(slot, observer);
        if (!avatarObserver) {
          avatarObserver = new MutationObserver(() => releaseAvatars());
          avatarObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
        observer.observe(slot);
      } else { setTimeout(load, 0); }
      return slot;
    }
    const url = user && user.avatar_url;
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return fallback;
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.setAttribute('loading', 'lazy');
    img.addEventListener('error', () => img.replaceWith(fallback), { once: true });
    img.src = url;
    return img;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function formatTime(iso) {
    if (!iso) return '未知时间';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    const pad = (value) => String(value).padStart(2, '0');
    return (
      date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    );
  }

  let toastTimer = 0;
  function toast(message, durationMs) {
    const node = el('toast');
    if (!node) return;
    node.textContent = tr(message);
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), durationMs || 3200);
  }

  function base64Url(bytes) {
    const view = new Uint8Array(bytes);
    let binary = '';
    for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomToken(byteLength) {
    const buffer = new Uint8Array(byteLength);
    crypto.getRandomValues(buffer);
    return base64Url(buffer);
  }

  async function sha256b64url(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return base64Url(digest);
  }

  // ———————————————————— 登录态存取 ————————————————————

  function readStoredAuth() {
    try {
      const stored = JSON.parse(gameStorage.getItem(CFG.authKey) || 'null');
      return stored && stored.refresh_token && stored.user && stored.user.user_id ? stored : null;
    } catch (error) {
      return null;
    }
  }

  function notifyAuthChange() {
    const snapshot = publicUser();
    authListeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        /* 监听方的错误不影响登录流程 */
      }
    });
  }

  function storeAuth(next) {
    auth = next;
    try {
      gameStorage.setItem(CFG.authKey, JSON.stringify(next));
    } catch (error) {
      /* 隐私模式下存不了也不影响本次使用 */
    }
    notifyAuthChange();
  }

  function clearAuth() {
    auth = null;
    try {
      gameStorage.removeItem(CFG.authKey);
    } catch (error) {
      /* ignore */
    }
    notifyAuthChange();
  }

  // 后端 TokenResponse → 本地登录态（expires_at 秒 → 毫秒）
  function applySession(token) {
    storeAuth({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Number(token.expires_at) * 1000,
      session_id: token.session_id,
      user: token.user,
    });
  }

  function publicUser() {
    return auth && auth.user ? Object.assign({}, auth.user) : null;
  }

  // 旧版（前端直连 IdP）的登录态不再可用：清掉并提示重新登录一次。
  function dropLegacyAuth() {
    try {
      if (gameStorage.getItem(CFG.legacyAuthKey) === null) return false;
      gameStorage.removeItem(CFG.legacyAuthKey);
      return true;
    } catch (error) {
      return false;
    }
  }

  // ———————————————————— 登录 ————————————————————

  function redirectUri() {
    // 后端 OIDC_REDIRECT_URIS 里登记的回调地址：https://www.fuckanthropic.dev/（同页回调）。
    return location.origin + '/';
  }

  async function login() {
    if (platform) { togglePanel(true); return; }
    if (!window.crypto || !crypto.subtle) {
      toast('当前环境不支持安全登录（需要 HTTPS）');
      return;
    }
    const verifier = randomToken(32);
    let started;
    try {
      started = await publicFetch('/auth/login', {
        method: 'POST',
        body: { login_challenge: await sha256b64url(verifier), redirect_uri: redirectUri() },
      });
    } catch (error) {
      toast(tr('无法发起登录：') + (error.message || '网络错误'), 4200);
      return;
    }
    let target;
    try {
      target = new URL(started.authorize_url);
    } catch (error) {
      target = null;
    }
    if (!target || target.origin !== CFG.idpOrigin) {
      toast('登录地址异常，已中止');
      return;
    }
    try {
      sessionStorage.setItem(CFG.loginKey, JSON.stringify({ verifier: verifier, state: started.state }));
    } catch (error) {
      toast('浏览器禁止了会话存储，无法登录');
      return;
    }
    location.href = target.href;
  }

  async function handleRedirectBack() {
    let url;
    try {
      url = new URL(location.href);
    } catch (error) {
      return false;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const iss = url.searchParams.get('iss');
    const oauthError = url.searchParams.get('error');
    if (!code && !oauthError) return false;

    const description = url.searchParams.get('error_description') || '';
    ['code', 'state', 'session_state', 'iss', 'error', 'error_description'].forEach((key) =>
      url.searchParams.delete(key)
    );
    history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);

    if (oauthError) {
      toast(tr('登录未完成：') + (description || oauthError), 4200);
      return true;
    }

    let stored = null;
    try {
      stored = JSON.parse(sessionStorage.getItem(CFG.loginKey) || 'null');
      sessionStorage.removeItem(CFG.loginKey);
    } catch (error) {
      stored = null;
    }
    if (!stored || !stored.verifier || stored.state !== state) {
      toast('登录校验失败，请重新登录');
      return true;
    }

    try {
      const body = { code: code, state: state, login_verifier: stored.verifier };
      if (iss) body.iss = iss;
      const token = await publicFetch('/auth/callback', { method: 'POST', body: body });
      applySession(token);
      render();
      toast('登录成功');
      await afterLogin();
    } catch (error) {
      toast(tr('登录失败：') + (error.message || '网络错误'), 4200);
    }
    return true;
  }

  function tokenIsFresh(candidate) {
    return !!candidate && !!candidate.access_token && candidate.expires_at - Date.now() > CFG.refreshAheadMs;
  }

  // 刷新一次：多标签页通过 navigator.locks 串行化；锁内先看别的标签页是否已经换过 RT。
  async function refreshOnce() {
    const current = readStoredAuth() || auth;
    if (!current) throw sessionGone();
    if (auth && current.refresh_token !== auth.refresh_token && tokenIsFresh(current)) {
      auth = current;
      return current.access_token;
    }
    let token;
    try {
      token = await publicFetch('/auth/refresh', {
        method: 'POST',
        body: { refresh_token: current.refresh_token },
      });
    } catch (error) {
      if (error.authCode === 'invalid_token') {
        // 刚被另一个标签页轮换：重读存储，拿到新 RT 就用它的结果
        const latest = readStoredAuth();
        if (latest && latest.refresh_token !== current.refresh_token) {
          auth = latest;
          if (tokenIsFresh(latest)) return latest.access_token;
        }
      }
      if (error.authCode) {
        clearAuth();
        render();
        toast('登录状态已失效，请重新登录');
      }
      throw error;
    }
    applySession(token);
    render();
    return auth.access_token;
  }

  function sessionGone() {
    const error = new Error('未登录');
    error.code = 'not_logged_in';
    return error;
  }

  async function refreshAccessToken() {
    if (!auth) throw sessionGone();
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async function () {
      try {
        if (navigator.locks && navigator.locks.request) {
          return await navigator.locks.request('ip-please-auth-refresh', refreshOnce);
        }
        return await refreshOnce();
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  async function accessToken() {
    if (!auth) throw sessionGone();
    if (tokenIsFresh(auth)) return auth.access_token;
    return refreshAccessToken();
  }

  // ———————————————————— 后端调用 ————————————————————

  function businessErrorCodeFromDetail(detail) {
    return BUSINESS_ERROR_CODES[detail] || 'unknown';
  }

  function apiError(response, body) {
    const error = new Error('HTTP ' + response.status);
    error.status = response.status;
    if (body && body.error && body.error.code) {
      error.authCode = body.error.code;
      error.message = tr(AUTH_ERROR_TEXT[error.authCode] || body.error.message || error.message);
    } else if (body && typeof body.detail === 'string') {
      error.code = businessErrorCodeFromDetail(body.detail);
      error.message = tr(BUSINESS_ERROR_TEXT[error.code] || body.detail);
    } else {
      error.code = 'gateway_error';
      error.message = tr('云同步服务暂时不可用（HTTP {0}）', response.status);
    }
    const retryAfter = Number(response.headers.get('Retry-After'));
    if (retryAfter > 0) error.retryAfter = retryAfter;
    return error;
  }

  // 尽量少发 CORS 预检：
  // - JSON 按字符串 body 发、不设 Content-Type（浏览器默认 text/plain）。不带 Token 的请求因此是
  //   「简单请求」，完全不预检；后端不看 Content-Type，照样按 JSON 解析。
  // - 不设 fetch 的 cache 选项：cache: 'no-store' 会让 Chrome 跳过预检缓存，每次都重新预检。
  //   接口响应自带 Cache-Control: no-store，浏览器本来就不会缓存数据。
  async function send(path, settings, token) {
    if (platform) return GameHost.request(path, settings);
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const payload = settings.body === undefined ? undefined : JSON.stringify(settings.body);
    let response;
    try {
      response = await fetch(CFG.apiBase + path, {
        method: settings.method || 'GET',
        headers: headers,
        body: payload,
      });
    } catch (error) {
      const networkError = new Error('网络错误，无法连接云同步服务');
      networkError.network = true;
      throw networkError;
    }
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        body = null;
      }
    }
    return { response: response, body: body };
  }

  // 不带 Token 的接口（登录、刷新、公告、排行榜）
  async function publicFetch(path, options) {
    const result = await send(path, options || {}, null);
    if (!result.response.ok) throw apiError(result.response, result.body);
    return result.body;
  }

  // 公开接口但登录后带上身份（排行榜里的「我的排名」）
  async function optionalAuthFetch(path, options) {
    return auth ? apiFetch(path, options) : publicFetch(path, options);
  }

  async function apiFetch(path, options) {
    const settings = options || {};
    if (platform) {
      const result = await GameHost.request(path, settings);
      if (!result.response.ok) { const error=apiError(result.response,result.body);error.operation=result.operation;throw error; }
      return result.body;
    }
    let token = await accessToken();
    let result = await send(path, settings, token);

    if (result.response.status === 401 && result.body && result.body.error) {
      const code = result.body.error.code;
      if (code === 'invalid_token') {
        try {
          token = await refreshAccessToken();
        } catch (error) {
          throw apiError(result.response, result.body);
        }
        result = await send(path, settings, token);
        if (result.response.status === 401 && result.body && result.body.error &&
            result.body.error.code === 'token_revoked') {
          clearAuth();
          render();
          toast('登录状态已失效，请重新登录');
        }
      } else if (code === 'token_revoked') {
        clearAuth();
        render();
        toast('登录状态已失效，请重新登录');
        throw apiError(result.response, result.body);
      }
    }

    if (!result.response.ok) throw apiError(result.response, result.body);
    return result.body;
  }

  function fetchLatest() {
    return apiFetch('/sync/save');
  }

  function uploadSave(state, baseVersion, replacesRequestId) {
    return apiFetch('/sync/save', {
      method: 'POST',
      body: { day: state.day, payload: state, base_version: baseVersion },
      replacesRequestId: replacesRequestId,
    });
  }

  // ———————————————————— 本地元数据 ————————————————————

  function metaStorageKey() {
    return CFG.metaKey + ':' + ((auth && auth.user && auth.user.user_id) || 'anonymous');
  }

  function loadMeta() {
    try {
      const meta = JSON.parse(gameStorage.getItem(metaStorageKey()) || 'null');
      return meta && typeof meta.version === 'number' ? meta : null;
    } catch (error) {
      return null;
    }
  }

  function saveMeta(meta) {
    try {
      gameStorage.setItem(metaStorageKey(), JSON.stringify(meta));
    } catch (error) {
      /* ignore */
    }
  }

  function loadLocalSave() {
    try {
      const saved = JSON.parse(gameStorage.getItem(CFG.saveKey) || 'null');
      return saved && typeof saved.day === 'number' ? saved : null;
    } catch (error) {
      return null;
    }
  }

  // 能载入接着玩的云端存档：零号档案格式（带 plot 剧情状态）且还没打出结局。
  // 云端可能还留着本站改成零号档案之前的旧版存档，零号档案不读旧存档。
  function isRestorable(payload) {
    return !!payload && typeof payload.day === 'number' && !!payload.plot &&
      !(payload.plot.final && payload.plot.final.ending);
  }

  function unrestorableReason(payload) {
    return payload && payload.plot ? '云端那一局已经打完了' : '云端是旧版游戏的存档，零号档案读不了';
  }

  function metaFromServer(server) {
    return {
      version: server.version,
      day: server.day,
      save_id: server.save_id,
      synced_at: server.updated_at,
    };
  }

  function applyCloudSave(server) {
    try {
      gameStorage.setItem(CFG.saveKey, JSON.stringify(server.payload));
    } catch (error) {
      toast('本机无法写入存档（隐私模式？）');
      return;
    }
    saveMeta(metaFromServer(server));
    toast('已载入云端存档，正在重新载入…');
    if (platform) GameHost.transition(() => GameHost.reload());
    else setTimeout(() => location.reload(), 450);
  }

  // ———————————————————— 同步主流程 ————————————————————

  async function syncState(state, reason) {
    if (!auth) {
      maybePromptLogin();
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const meta = loadMeta();
      const baseVersion = meta ? meta.version : 0;
      const snapshot = JSON.parse(JSON.stringify(state));
      const result = await uploadSave(snapshot, baseVersion);
      saveMeta(metaFromServer(result));
      render();
      const label = reason === 'ending' ? '结局存档' : tr('第 {0} 天存档', result.day);
      toast(tr('{0}已同步到云端', label));
    } catch (error) {
      if (error.status === 409) {
        await handleConflict(state, reason, error.operation);
        return;
      }
      if (error.code === 'sync_rate_limited') {
        toast(tr('同步太频繁了，请 {0} 秒后再试', error.retryAfter || 3));
        return;
      }
      if (error.authCode) {
        toast(error.message || '登录状态异常');
        return;
      }
      toast(tr('云同步失败：') + (error.message || '网络错误'), 4200);
    } finally {
      busy = false;
    }
  }

  async function forceUpload(state, serverVersion, replacesRequestId) {
    try {
      const snapshot = JSON.parse(JSON.stringify(state));
      const result = await uploadSave(snapshot, serverVersion, replacesRequestId);
      saveMeta(metaFromServer(result));
      render();
      toast(tr('已用本机存档覆盖云端（第 {0} 天）', result.day));
      return true;
    } catch (error) {
      if (error.status === 409) {
        toast('云端又更新了，请再试一次');
        if(platform) await handleConflict(state, 'manual', error.operation);
        return false;
      }
      toast(tr('覆盖失败：') + (error.message || '网络错误'));
    }
  }

  async function handleConflict(localState, reason, operation) {
    let server = null;
    try {
      server = await fetchLatest();
    } catch (error) {
      toast(tr('云端存档冲突，但读取失败：') + (error.message || '网络错误'));
      return;
    }
    if (!platform && !isRestorable(server.payload)) {
      await forceUpload(localState, server.version);
      return;
    }
    const title = reason === 'ending' ? '结局存档冲突' : '云存档冲突';
    let resolving=false;
    const choose=async local=>{
      if(resolving || (!local && !isRestorable(server.payload)))return;resolving=true;
      try {
        if(local) {if(await forceUpload(localState,server.version,operation?.request_id))closeDialog();}
        else {if(operation)await GameHost.resolvePending(operation.request_id);closeDialog();applyCloudSave(server);}
      } catch(error) {toast(error.message || '网络错误');}
      finally {resolving=false;}
    };
    showDialog({
      title: title,
      paragraphs: [
        tr('云端已有一份更新的存档：第 {0} 天（{1}）。', server.day, formatTime(server.updated_at)),
        tr('本机刚结束的是第 {0} 天。要保留哪一份？', localState.day),
        '选「用云端存档」会覆盖本机进度并重新载入；选「保留本机」会把本机进度上传并覆盖云端。',
      ],
      buttons: [
        { label: '用云端存档', disabled: !isRestorable(server.payload), onClick: () => choose(false) },
        {
          label: '保留本机',
          primary: true,
          onClick: () => choose(true),
        },
        { label: '稍后再说', onClick: closeDialog },
      ],
    });
  }

  async function afterLogin() {
    let server = null;
    try {
      server = await fetchLatest();
    } catch (error) {
      if (error.status === 404) {
        const local = loadLocalSave();
        toast(local ? tr('已登录，日终会自动同步第 {0} 天存档', local.day) : '已登录，下一局日终会自动同步');
        return;
      }
      toast(tr('读取云端存档失败：') + (error.message || '网络错误'));
      return;
    }

    if (platform && GameHost.pending().length) return;
    if (!isRestorable(server.payload)) {
      saveMeta(metaFromServer(server));
      toast(tr('已登录。{0}，日终会用本机进度覆盖', unrestorableReason(server.payload)), 4200);
      return;
    }

    const local = loadLocalSave();
    const localDay = local ? local.day : 0;
    if (localDay >= server.day) {
      saveMeta(metaFromServer(server));
      toast('已登录，日终会自动同步本机进度');
      return;
    }

    showDialog({
      title: '发现云端存档',
      paragraphs: [
        tr('云端存档在第 {0} 天（{1}），本机进度是第 {2} 天。', server.day, formatTime(server.updated_at), localDay),
        '要载入云端存档继续玩吗？',
      ],
      buttons: [
        { label: '载入云端', primary: true, onClick: function () { closeDialog(); applyCloudSave(server); } },
        {
          label: '保留本机',
          onClick: function () { closeDialog(); saveMeta(metaFromServer(server)); toast('已保留本机进度，日终会覆盖云端'); },
        },
      ],
    });
  }

  let recoveryInFlight = null;
  function recoverPending() {
    if (!platform) return Promise.resolve({blocked:false,terminal:false,hasRun:false});
    if (recoveryInFlight) return recoveryInFlight;
    recoveryInFlight=(async()=>{
      const results=await GameHost.retryPending();
      render();
      for(const result of results) if(!result.response.ok) {
        const error=apiError(result.response,result.body),op=result.operation;
        if(error.code==='sync_conflict' && op?.op==='save') {
          await handleConflict(op.args.payload,'manual',op);
          return {blocked:true,terminal:false,hasRun:false};
        }
        const runOperation=op && (op.op.startsWith('run_') || op.op==='wave_result');
        if(!(runOperation && (error.code==='endless_state_conflict' || error.code==='not_found')))throw error;
      }
      const hasRun=results.some(r=>r.operation?.op.startsWith('run_') || r.operation?.op==='wave_result');
      const terminal=hasRun && window.Endless ? await Endless.recoverResults(results) : false;
      return {blocked:false,terminal,hasRun};
    })().finally(()=>{recoveryInFlight=null;});
    return recoveryInFlight;
  }

  async function retryPending() {
    try {
      const result=await recoverPending();
      if(result.blocked)return;
      if(result.hasRun && !result.terminal && window.Endless)await Endless.resume();
      toast('待确认操作已恢复');
    } catch (error) { toast(error.message || '网络错误'); }
  }

  async function showSnapshots() {
    try {
      const result = await apiFetch('/sync/snapshots?limit=50');
      showDialog({ title: '历史快照', paragraphs: [], buttons: [{label:'关闭', onClick:closeDialog}] });
      const dialog = el('cloud-overlay').querySelector('.dialog');
      const list = node('div', undefined, 'snapshots');
      for (const snap of result.snapshots || []) {
        const b = node('button', tr('第 {0} 天 · {1}', snap.day, formatTime(snap.created_at))); b.type = 'button';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const saved = await apiFetch('/sync/snapshots/' + encodeURIComponent(snap.save_id));
            if (!isRestorable(saved.payload)) { toast(unrestorableReason(saved.payload)); return; }
            showDialog({title:'从云端恢复', paragraphs:['载入后本机当前进度会被覆盖。'], buttons:[{label:'载入云端',onClick:()=>{closeDialog();applyCloudSave(saved);}}, {label:'取消',onClick:closeDialog}]});
          } catch(error) {toast(error.message);} finally {b.disabled=false;}
        }); list.append(b);
      }
      dialog.insertBefore(list, dialog.lastChild);
    } catch(error) { toast(error.message || '网络错误'); }
  }

  function onDayEnd(state) {
    return syncState(state, 'day');
  }

  function onGameEnd(state) {
    return syncState(state, 'ending');
  }

  function manualSync() {
    const local = loadLocalSave();
    if (!local) {
      toast('本机还没有存档可以同步');
      return;
    }
    syncState(local, 'manual');
  }

  async function manualRestore() {
    let server = null;
    try {
      server = await fetchLatest();
    } catch (error) {
      toast(error.status === 404 ? '云端还没有存档' : tr('读取云端存档失败：') + (error.message || '网络错误'));
      return;
    }
    if (!isRestorable(server.payload)) {
      toast(tr('{0}，没有可以接着玩的进度', unrestorableReason(server.payload)));
      return;
    }
    showDialog({
      title: '从云端恢复',
      paragraphs: [
        tr('云端存档在第 {0} 天（{1}）。', server.day, formatTime(server.updated_at)),
        '载入后本机当前进度会被覆盖。',
      ],
      buttons: [
        { label: '载入云端', primary: true, onClick: function () { closeDialog(); applyCloudSave(server); } },
        { label: '取消', onClick: closeDialog },
      ],
    });
  }

  function logout() {
    if (platform) { togglePanel(false); return; }
    const refreshToken = auth && auth.refresh_token;
    clearAuth();
    togglePanel(false);
    render();
    toast('已退出登录');
    // 尽力通知后端吊销会话；失败也不影响本地已登出
    if (refreshToken) {
      publicFetch('/auth/logout', { method: 'POST', body: { refresh_token: refreshToken } }).catch(() => {});
    }
  }

  // ———————————————————— 界面 ————————————————————

  function maybePromptLogin() {
    if (loginHintShown) return;
    loginHintShown = true;
    toast('登录后可把存档同步到云端（右上角「云同步」）', 4200);
  }

  function render() {
    const button = el('cloud');
    if (button) {
      if (!auth) {
        button.textContent = tr('云同步');
        button.title = '';
      } else {
        const meta = loadMeta();
        button.textContent = meta ? tr('云同步 · 第 {0} 天', meta.day) : tr('云同步 · 已登录');
        button.title = tr('已登录：{0}', displayName(auth.user));
      }
    }
    renderPanel();
  }

  function renderPanel() {
    const panel = el('cloud-panel');
    if (!panel || panel.hidden) return;
    const meta = loadMeta();
    panel.replaceChildren(node('h2', platform ? 'LINUX DO · 云同步' : '云同步'));
    const row = (...buttons) => { const r = node('div', undefined, 'row'); r.append(...buttons); panel.append(r); };
    if (!auth) {
      panel.append(node('p', '登录后可把每日存档备份到云端，换设备也能接着玩。'), credits());
      row(actionButton('登录', 'login', true), actionButton('关闭', 'close'));
    } else {
      const who = node('div', undefined, 'who'); who.append(avatar(auth.user), node('span', displayName(auth.user), 'name'));
      if (auth.user.is_admin) who.append(node('span', '管理员', 'tag'));
      panel.append(who, node('p', tr('存档：{0}', meta ? tr('第 {0} 天 · {1} 已同步', meta.day, formatTime(meta.synced_at)) : tr('尚未同步过'))));
      row(actionButton('立即同步', 'sync', true), actionButton('从云端恢复', 'restore'), actionButton('历史快照', 'snapshots'));
      if (platform) {
        panel.append(node('p', GameHost.bootstrap.channel === 'sandbox' ? 'LINUX DO 测试环境 · 独立排行榜' : 'LINUX DO 正式环境 · 独立排行榜'));
        row(actionButton('重试待确认操作', 'retry-pending'));
      }
      panelSections.forEach(section => { try { const content = section.render(publicUser()); if (content) panel.append(content); } catch (_) {} });
      row(...(platform ? [] : [actionButton('退出登录', 'logout')]), actionButton('关闭', 'close'));
      panel.append(credits());
    }
  }

  function togglePanel(force) {
    const panel = el('cloud-panel');
    if (!panel) return;
    const show = force === undefined ? panel.hidden : force;
    if (!show) releaseAvatars(panel);
    panel.hidden = !show;
    if (show) renderPanel();
  }

  const overlayPointers = new WeakMap();
  function overlayDismiss(overlay, onContentClick) {
    let startedOnBackdrop = false;
    if (overlayPointers.has(overlay)) overlay.removeEventListener('pointerdown', overlayPointers.get(overlay));
    const pointer = event => { startedOnBackdrop = event.target === overlay; };
    overlayPointers.set(overlay, pointer); overlay.addEventListener('pointerdown', pointer);
    overlay.onclick = event => {
      if (event.target === overlay) { if (startedOnBackdrop) closeDialog(); startedOnBackdrop = false; return; }
      if (onContentClick) onContentClick(event);
    };
  }

  function showDialog(config) {
    const overlay = el('cloud-overlay');
    if (!overlay) return;
    const dialog = node('div', undefined, 'dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    dialog.append(node('h2', config.title));
    config.paragraphs.forEach(text => dialog.append(node('p', text)));
    const row = node('div', undefined, 'row');
    config.buttons.forEach((button, index) => { const b = node('button', button.label, button.primary ? 'primary' : ''); b.type = 'button'; b.dataset.index = index; b.disabled=!!button.disabled; row.append(b); });
    dialog.append(row); overlay.replaceChildren(dialog);
    overlay.hidden = false;
    overlayDismiss(overlay, function (event) {
      const target = event.target.closest('button[data-index]');
      if (!target) return;
      const chosen = config.buttons[Number(target.dataset.index)];
      if (chosen && chosen.onClick) chosen.onClick();
    });
  }

  function closeDialog() {
    const overlay = el('cloud-overlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.replaceChildren();
  }

  function handleAction(action, target) {
    for (const section of panelSections) {
      if (section.onAction && section.onAction(action, target)) return;
    }
    if (action === 'snapshots') { showSnapshots(); return; }
    if (action === 'retry-pending') { retryPending(); return; }
    if (action === 'login') {
      togglePanel(false);
      login();
    } else if (action === 'close') {
      togglePanel(false);
    } else if (action === 'sync') {
      manualSync();
    } else if (action === 'restore') {
      manualRestore();
    } else if (action === 'logout') {
      logout();
    }
  }

  function init() {
    const hadLegacy = platform ? false : dropLegacyAuth();
    auth = platform ? { user: GameHost.user } : readStoredAuth();
    if (hadLegacy && !auth) toast('云同步登录已升级，请重新登录一次', 4200);
    // 其他标签页登录 / 刷新 / 登出时同步本页状态
    window.addEventListener('storage', function (event) {
      if (platform || event.key !== CFG.authKey) return;
      auth = readStoredAuth();
      render();
      notifyAuthChange();
    });
    const button = el('cloud');
    if (button) {
      // 先打开面板（含原作致谢与登录说明），再由面板里的「登录」跳转 IdP。
      button.addEventListener('click', function () {
        togglePanel();
      });
    }
    const panel = el('cloud-panel');
    if (panel) {
      panel.addEventListener('click', function (event) {
        const target = event.target.closest('button[data-action]');
        if (target) handleAction(target.dataset.action, target);
      });
    }
    render();
    // 处理 OAuth 回调（登录后返回本页时清理 URL 并换取 Token）
    if (platform) { notifyAuthChange(); if (!GameHost.pending().length) afterLogin(); }
    else handleRedirectBack();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    retryPending: retryPending,
    recoverPending: recoverPending,
    onDayEnd: onDayEnd,
    onGameEnd: onGameEnd,
    login: login,
    logout: logout,
    syncNow: manualSync,
    restore: manualRestore,
    isLoggedIn: function () { return !!auth; },
    user: publicUser,
    // 供无尽模式 / 公告等模块复用的接口与界面
    api: apiFetch,
    publicApi: publicFetch,
    optionalAuthApi: optionalAuthFetch,
    onAuthChange: function (listener) { authListeners.push(listener); },
    addPanelSection: function (section) { panelSections.push(section); render(); },
    openPanel: function () { togglePanel(true); },
    refreshPanel: renderPanel,
    promptLogin: function (reason) {
      if (reason) toast(reason, 4200);
      togglePanel(true);
    },
    ui: { overlayDismiss: overlayDismiss, toast: toast, showDialog: showDialog, closeDialog: closeDialog, escapeHtml: escapeHtml, avatar: avatar, displayName: displayName },
  };
})();
