'use strict';
// 云同步：Keycloak OIDC（Authorization Code + PKCE / S256）登录、Access Token 自动刷新、
// 每日结算后把存档同步到 https://api.luminet.cn/anthropic/v1。
//
// 约定：
// - 前端只跟 IdP 换 Token（公共客户端，无 client_secret），刷新令牌存在 localStorage。
// - Access Token 有效期 600 秒，提前 60 秒刷新；401 invalid_token 时强制刷新并重试一次。
// - 与后端的错误约定见 backend/src/error.rs：DetailErrorResponse / AuthErrorResponse 双信封。

window.CloudSync = (function () {
  const CFG = {
    issuer: 'https://auth.luminet.cn/realms/prod',
    clientId: 'app_vXmK3nB7cmKcW6q7',
    apiBase: 'https://api.luminet.cn/anthropic/v1',
    scope: 'openid profile email offline_access',
    authKey: 'ip-please-auth-v1',
    metaKey: 'ip-please-sync-meta-v1',
    pkceKey: 'ip-please-pkce-v1',
    saveKey: 'ip-please-save-v1',
    refreshAheadMs: 60 * 1000,
  };

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
  };

  const AUTH_ERROR_TEXT = {
    invalid_token: '登录已过期，正在重新登录',
    token_revoked: '登录状态已失效，请重新登录',
    insufficient_scope: '账号缺少云同步权限',
    session_validation_failed: '鉴权服务暂时不可用',
  };

  let auth = null;
  let refreshInFlight = null;
  let busy = false;
  let loginHintShown = false;

  // ———————————————————— 小工具 ————————————————————

  function el(id) {
    return document.getElementById(id);
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
    node.textContent = message;
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

  async function pkceChallenge(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64Url(digest);
  }

  function decodeJwtPayload(jwt) {
    try {
      const part = String(jwt).split('.')[1] || '';
      const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      return null;
    }
  }

  // ———————————————————— 登录态存取 ————————————————————

  function loadAuth() {
    try {
      const stored = JSON.parse(localStorage.getItem(CFG.authKey) || 'null');
      return stored && stored.refresh_token ? stored : null;
    } catch (error) {
      return null;
    }
  }

  function storeAuth(next) {
    auth = next;
    try {
      localStorage.setItem(CFG.authKey, JSON.stringify(next));
    } catch (error) {
      /* 隐私模式下存不了也不影响本次使用 */
    }
  }

  function clearAuth() {
    auth = null;
    try {
      localStorage.removeItem(CFG.authKey);
    } catch (error) {
      /* ignore */
    }
  }

  function applyToken(token) {
    const expiresIn = Number(token.expires_in) > 0 ? Number(token.expires_in) : 600;
    const claims = decodeJwtPayload(token.access_token) || {};
    storeAuth({
      access_token: token.access_token,
      refresh_token: token.refresh_token || (auth && auth.refresh_token) || null,
      expires_at: Date.now() + expiresIn * 1000,
      subject: claims.sub || (auth && auth.subject) || null,
      name: claims.preferred_username || claims.email || (auth && auth.name) || null,
    });
  }

  // ———————————————————— Token 端点 ————————————————————

  async function tokenRequest(params) {
    const response = await fetch(CFG.issuer + '/protocol/openid-connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
      cache: 'no-store',
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (error) {
      body = null;
    }
    if (!response.ok) {
      const error = new Error((body && (body.error_description || body.error)) || 'HTTP ' + response.status);
      error.status = response.status;
      error.code = body && body.error;
      throw error;
    }
    return body;
  }

  function redirectUri() {
    // Keycloak 中登记的回调地址是 https://www.fuckanthropic.dev/（同页回调）。
    return location.origin + '/';
  }

  async function login() {
    if (!window.crypto || !crypto.subtle) {
      toast('当前环境不支持安全登录（需要 HTTPS）');
      return;
    }
    const verifier = randomToken(48);
    const state = randomToken(32);
    const challenge = await pkceChallenge(verifier);
    try {
      sessionStorage.setItem(CFG.pkceKey, JSON.stringify({ verifier: verifier, state: state }));
    } catch (error) {
      toast('浏览器禁止了会话存储，无法登录');
      return;
    }
    const params = new URLSearchParams({
      client_id: CFG.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: CFG.scope,
      state: state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    location.href = CFG.issuer + '/protocol/openid-connect/auth?' + params.toString();
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
    const oauthError = url.searchParams.get('error');
    if (!code && !oauthError) return false;

    const description = url.searchParams.get('error_description') || '';
    ['code', 'state', 'session_state', 'iss', 'error', 'error_description'].forEach((key) =>
      url.searchParams.delete(key)
    );
    history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);

    if (oauthError) {
      toast('登录未完成：' + (description || oauthError), 4200);
      return true;
    }

    let stored = null;
    try {
      stored = JSON.parse(sessionStorage.getItem(CFG.pkceKey) || 'null');
      sessionStorage.removeItem(CFG.pkceKey);
    } catch (error) {
      stored = null;
    }
    if (!stored || !stored.verifier || stored.state !== state) {
      toast('登录校验失败，请重新登录');
      return true;
    }

    try {
      const token = await tokenRequest({
        grant_type: 'authorization_code',
        client_id: CFG.clientId,
        code: code,
        redirect_uri: redirectUri(),
        code_verifier: stored.verifier,
      });
      applyToken(token);
      render();
      toast('登录成功');
      await afterLogin();
    } catch (error) {
      toast('登录失败：' + (error.message || '网络错误'), 4200);
    }
    return true;
  }

  async function refreshAccessToken() {
    if (!auth || !auth.refresh_token) throw new Error('未登录');
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async function () {
      try {
        const token = await tokenRequest({
          grant_type: 'refresh_token',
          client_id: CFG.clientId,
          refresh_token: auth.refresh_token,
        });
        applyToken(token);
        render();
        return auth.access_token;
      } catch (error) {
        if (error.status === 400 || error.status === 401) {
          clearAuth();
          render();
          toast('登录已过期，请重新登录');
        }
        throw error;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  async function accessToken() {
    if (!auth) throw new Error('未登录');
    if (auth.access_token && auth.expires_at - Date.now() > CFG.refreshAheadMs) return auth.access_token;
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
      error.message = AUTH_ERROR_TEXT[error.authCode] || body.error.message || error.message;
    } else if (body && typeof body.detail === 'string') {
      error.code = businessErrorCodeFromDetail(body.detail);
      error.message = BUSINESS_ERROR_TEXT[error.code] || body.detail;
    } else {
      error.code = 'gateway_error';
      error.message = '云同步服务暂时不可用（HTTP ' + response.status + '）';
    }
    const retryAfter = Number(response.headers.get('Retry-After'));
    if (retryAfter > 0) error.retryAfter = retryAfter;
    return error;
  }

  async function apiFetch(path, options) {
    const settings = options || {};
    const send = async function (token) {
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      let payload;
      if (settings.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(settings.body);
      }
      const response = await fetch(CFG.apiBase + path, {
        method: settings.method || 'GET',
        headers: headers,
        body: payload,
        cache: 'no-store',
      });
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
    };

    let token = await accessToken();
    let result;
    try {
      result = await send(token);
    } catch (error) {
      const networkError = new Error('网络错误，无法连接云同步服务');
      networkError.network = true;
      throw networkError;
    }

    if (result.response.status === 401 && result.body && result.body.error) {
      const code = result.body.error.code;
      if (code === 'invalid_token') {
        try {
          token = await refreshAccessToken();
          result = await send(token);
        } catch (error) {
          throw apiError(result.response, result.body);
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

  function uploadSave(state, baseVersion) {
    return apiFetch('/sync/save', {
      method: 'POST',
      body: { day: state.day, payload: state, base_version: baseVersion },
    });
  }

  // ———————————————————— 本地元数据 ————————————————————

  function metaStorageKey() {
    return CFG.metaKey + ':' + ((auth && auth.subject) || 'anonymous');
  }

  function loadMeta() {
    try {
      const meta = JSON.parse(localStorage.getItem(metaStorageKey()) || 'null');
      return meta && typeof meta.version === 'number' ? meta : null;
    } catch (error) {
      return null;
    }
  }

  function saveMeta(meta) {
    try {
      localStorage.setItem(metaStorageKey(), JSON.stringify(meta));
    } catch (error) {
      /* ignore */
    }
  }

  function loadLocalSave() {
    try {
      const saved = JSON.parse(localStorage.getItem(CFG.saveKey) || 'null');
      return saved && typeof saved.day === 'number' ? saved : null;
    } catch (error) {
      return null;
    }
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
      localStorage.setItem(CFG.saveKey, JSON.stringify(server.payload));
    } catch (error) {
      toast('本机无法写入存档（隐私模式？）');
      return;
    }
    saveMeta(metaFromServer(server));
    toast('已载入云端存档，正在重新载入…');
    setTimeout(() => location.reload(), 450);
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
      const label = reason === 'ending' ? '结局存档' : '第 ' + result.day + ' 天存档';
      toast(label + '已同步到云端');
    } catch (error) {
      if (error.status === 409) {
        await handleConflict(state, reason);
        return;
      }
      if (error.code === 'sync_rate_limited') {
        toast('同步太频繁了，请 ' + (error.retryAfter || 3) + ' 秒后再试');
        return;
      }
      if (error.authCode) {
        toast(error.message || '登录状态异常');
        return;
      }
      toast('云同步失败：' + (error.message || '网络错误'), 4200);
    } finally {
      busy = false;
    }
  }

  async function forceUpload(state, serverVersion) {
    try {
      const snapshot = JSON.parse(JSON.stringify(state));
      const result = await uploadSave(snapshot, serverVersion);
      saveMeta(metaFromServer(result));
      render();
      toast('已用本机存档覆盖云端（第 ' + result.day + ' 天）');
    } catch (error) {
      if (error.status === 409) {
        toast('云端又更新了，请再试一次');
        return;
      }
      toast('覆盖失败：' + (error.message || '网络错误'));
    }
  }

  async function handleConflict(localState, reason) {
    let server = null;
    try {
      server = await fetchLatest();
    } catch (error) {
      toast('云端存档冲突，但读取失败：' + (error.message || '网络错误'));
      return;
    }
    const title = reason === 'ending' ? '结局存档冲突' : '云存档冲突';
    showDialog({
      title: title,
      paragraphs: [
        '云端已有一份更新的存档：第 ' + server.day + ' 天（' + formatTime(server.updated_at) + '）。',
        '本机刚结束的是第 ' + localState.day + ' 天。要保留哪一份？',
        '选「用云端存档」会覆盖本机进度并重新载入；选「保留本机」会把本机进度上传并覆盖云端。',
      ],
      buttons: [
        { label: '用云端存档', onClick: function () { closeDialog(); applyCloudSave(server); } },
        {
          label: '保留本机',
          primary: true,
          onClick: function () { closeDialog(); forceUpload(localState, server.version); },
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
        toast(local ? '已登录，日终会自动同步第 ' + local.day + ' 天存档' : '已登录，下一局日终会自动同步');
        return;
      }
      toast('读取云端存档失败：' + (error.message || '网络错误'));
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
        '云端存档在第 ' + server.day + ' 天（' + formatTime(server.updated_at) + '），本机进度是第 ' + localDay + ' 天。',
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
      toast(error.status === 404 ? '云端还没有存档' : '读取云端存档失败：' + (error.message || '网络错误'));
      return;
    }
    showDialog({
      title: '从云端恢复',
      paragraphs: [
        '云端存档在第 ' + server.day + ' 天（' + formatTime(server.updated_at) + '）。',
        '载入后本机当前进度会被覆盖。',
      ],
      buttons: [
        { label: '载入云端', primary: true, onClick: function () { closeDialog(); applyCloudSave(server); } },
        { label: '取消', onClick: closeDialog },
      ],
    });
  }

  function logout() {
    clearAuth();
    togglePanel(false);
    render();
    toast('已退出云同步登录');
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
        button.textContent = '云同步';
        button.title = '';
      } else {
        const meta = loadMeta();
        button.textContent = meta ? '云同步 · 第' + meta.day + '天' : '云同步 · 已登录';
        button.title = auth.name ? '已登录：' + auth.name : '已登录';
      }
    }
    renderPanel();
  }

  function renderPanel() {
    const panel = el('cloud-panel');
    if (!panel || panel.hidden) return;
    const meta = loadMeta();
    const rows = [];
    rows.push('<h2>云同步</h2>');
    if (!auth) {
      rows.push('<p>登录后可把每日存档备份到云端，换设备也能接着玩。</p>');
      rows.push('<div class="row"><button class="primary" data-action="login">登录</button><button data-action="close">关闭</button></div>');
    } else {
      rows.push('<p>账号：' + escapeHtml(auth.name || auth.subject || '已登录') + '</p>');
      rows.push('<p>状态：' + (meta ? '第 ' + meta.day + ' 天 · ' + formatTime(meta.synced_at) + ' 已同步' : '尚未同步过') + '</p>');
      rows.push('<div class="row"><button class="primary" data-action="sync">立即同步</button><button data-action="restore">从云端恢复</button></div>');
      rows.push('<div class="row"><button data-action="logout">退出登录</button><button data-action="close">关闭</button></div>');
    }
    panel.innerHTML = rows.join('');
  }

  function togglePanel(force) {
    const panel = el('cloud-panel');
    if (!panel) return;
    const show = force === undefined ? panel.hidden : force;
    panel.hidden = !show;
    if (show) renderPanel();
  }

  function showDialog(config) {
    const overlay = el('cloud-overlay');
    if (!overlay) return;
    const buttons = config.buttons
      .map((button, index) =>
        '<button data-index="' + index + '"' + (button.primary ? ' class="primary"' : '') + '>' +
        escapeHtml(button.label) + '</button>')
      .join('');
    overlay.innerHTML =
      '<div class="dialog" role="dialog" aria-modal="true">' +
      '<h2>' + escapeHtml(config.title) + '</h2>' +
      config.paragraphs.map((text) => '<p>' + escapeHtml(text) + '</p>').join('') +
      '<div class="row">' + buttons + '</div></div>';
    overlay.hidden = false;
    overlay.onclick = function (event) {
      if (event.target === overlay) {
        closeDialog();
        return;
      }
      const target = event.target.closest('button[data-index]');
      if (!target) return;
      const chosen = config.buttons[Number(target.dataset.index)];
      if (chosen && chosen.onClick) chosen.onClick();
    };
  }

  function closeDialog() {
    const overlay = el('cloud-overlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.innerHTML = '';
  }

  function handleAction(action) {
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
    auth = loadAuth();
    const button = el('cloud');
    if (button) {
      button.addEventListener('click', function () {
        if (!auth) login();
        else togglePanel();
      });
    }
    const panel = el('cloud-panel');
    if (panel) {
      panel.addEventListener('click', function (event) {
        const target = event.target.closest('button[data-action]');
        if (target) handleAction(target.dataset.action);
      });
    }
    render();
    handleRedirectBack();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    onDayEnd: onDayEnd,
    onGameEnd: onGameEnd,
    login: login,
    logout: logout,
    syncNow: manualSync,
    restore: manualRestore,
    isLoggedIn: function () { return !!auth; },
  };
})();
