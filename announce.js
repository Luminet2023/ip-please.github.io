'use strict';
// 公告：页面左上角的横幅（所有人可见），以及云同步面板里的管理员区块（发布 / 下线）。
//
// - 公告文字一律用 textContent 显示，不经过 canvas（像素字库没有任意文字的字形）。
// - 关掉的公告记在 localStorage（只保留仍在生效的 ID），换设备会再看到一次。
// - 管理员身份由后端会话决定（Keycloak 角色）；这里只决定显不显示按钮，权限以后端为准。

window.Announce = (function () {
  const DISMISSED_KEY = 'ip-please-announce-dismissed-v1';
  const REFRESH_MS = 15 * 60 * 1000;
  const LEVEL_LABEL = { info: '公告', warning: '注意', maintenance: '维护' };
  const DURATIONS = [
    { label: '直到下线', days: 0 },
    { label: '1 天', days: 1 },
    { label: '3 天', days: 3 },
    { label: '7 天', days: 7 },
  ];

  let active = [];
  let adminItems = null;
  let adminLoading = false;
  let timer = 0;

  function cloud() {
    return window.CloudSync || null;
  }

  function loadDismissed() {
    try {
      const list = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  }

  function saveDismissed(list) {
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(list.slice(-50)));
    } catch (error) {
      /* 隐私模式：下次还会再显示，无伤大雅 */
    }
  }

  // ———————————————————— 横幅 ————————————————————

  function renderBanner() {
    const banner = document.getElementById('announce');
    if (!banner) return;
    const dismissed = loadDismissed();
    const next = active.find((item) => dismissed.indexOf(item.announcement_id) < 0);
    if (!next) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }
    banner.textContent = '';
    banner.className = 'announce level-' + (LEVEL_LABEL[next.level] ? next.level : 'info');

    const head = document.createElement('div');
    head.className = 'head';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = LEVEL_LABEL[next.level] || LEVEL_LABEL.info;
    const title = document.createElement('strong');
    title.textContent = next.title;
    head.appendChild(tag);
    head.appendChild(title);

    const body = document.createElement('p');
    body.textContent = next.body;

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '知道了';
    close.addEventListener('click', function () {
      dismiss(next.announcement_id);
    });

    banner.appendChild(head);
    banner.appendChild(body);
    banner.appendChild(close);
    banner.hidden = false;
  }

  function dismiss(announcementId) {
    const list = loadDismissed();
    if (list.indexOf(announcementId) < 0) list.push(announcementId);
    saveDismissed(list);
    renderBanner();
  }

  async function refresh() {
    const api = cloud();
    if (!api) return;
    try {
      const result = await api.publicApi('/announcements');
      active = Array.isArray(result && result.announcements) ? result.announcements : [];
      // 只记住仍在生效的公告，避免列表无限增长
      const ids = active.map((item) => item.announcement_id);
      saveDismissed(loadDismissed().filter((id) => ids.indexOf(id) >= 0));
      renderBanner();
    } catch (error) {
      /* 公告拉取失败不打扰玩家 */
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(function () {
      if (document.visibilityState !== 'hidden') refresh();
    }, REFRESH_MS);
  }

  // ———————————————————— 管理员区块（云同步面板） ————————————————————

  function escape(text) {
    const api = cloud();
    return api ? api.ui.escapeHtml(text) : String(text);
  }

  function formatTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (value) => String(value).padStart(2, '0');
    return (date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  async function loadAdmin() {
    const api = cloud();
    if (!api || adminLoading) return;
    adminLoading = true;
    try {
      const result = await api.api('/admin/announcements');
      adminItems = Array.isArray(result && result.announcements) ? result.announcements : [];
    } catch (error) {
      adminItems = [];
      api.ui.toast('读取公告列表失败：' + (error.message || '网络错误'));
    } finally {
      adminLoading = false;
      api.refreshPanel();
    }
  }

  function renderAdmin(user) {
    if (!user || !user.is_admin) return '';
    if (adminItems === null) loadAdmin();
    const rows = ['<div class="admin"><h2>公告管理</h2>'];
    if (adminItems === null) {
      rows.push('<p>正在读取…</p>');
    } else if (!adminItems.length) {
      rows.push('<p>当前没有生效中的公告。</p>');
    } else {
      adminItems.forEach((item) => {
        rows.push(
          '<div class="row ann-item"><span>' + escape(LEVEL_LABEL[item.level] || '公告') + ' · ' +
          escape(item.title) + (item.ends_at ? '（至 ' + escape(formatTime(item.ends_at)) + '）' : '') +
          '</span><button data-action="ann-retire" data-id="' + escape(item.announcement_id) + '">下线</button></div>'
        );
      });
    }
    rows.push('<div class="row"><input id="ann-title" maxlength="60" placeholder="标题（≤60 字）"></div>');
    rows.push('<div class="row"><textarea id="ann-body" maxlength="500" rows="3" placeholder="正文（≤500 字）"></textarea></div>');
    rows.push(
      '<div class="row"><select id="ann-level">' +
      Object.keys(LEVEL_LABEL).map((key) => '<option value="' + key + '">' + LEVEL_LABEL[key] + '</option>').join('') +
      '</select><select id="ann-duration">' +
      DURATIONS.map((item, index) => '<option value="' + index + '">' + item.label + '</option>').join('') +
      '</select><button class="primary" data-action="ann-publish">发布</button></div>'
    );
    rows.push('</div>');
    return rows.join('');
  }

  async function publish() {
    const api = cloud();
    const title = (document.getElementById('ann-title') || {}).value || '';
    const body = (document.getElementById('ann-body') || {}).value || '';
    const level = (document.getElementById('ann-level') || {}).value || 'info';
    const duration = DURATIONS[Number((document.getElementById('ann-duration') || {}).value) || 0];
    if (!title.trim() || !body.trim()) {
      api.ui.toast('标题和正文都要填');
      return;
    }
    const payload = { title: title, body: body, level: level };
    if (duration && duration.days) {
      payload.ends_at = new Date(Date.now() + duration.days * 86400000).toISOString();
    }
    try {
      await api.api('/admin/announcements', { method: 'POST', body: payload });
      api.ui.toast('公告已发布');
      adminItems = null;
      api.refreshPanel();
      refresh();
    } catch (error) {
      api.ui.toast('发布失败：' + (error.message || '网络错误'));
    }
  }

  async function retire(announcementId) {
    const api = cloud();
    try {
      await api.api('/admin/announcements/' + encodeURIComponent(announcementId) + '/retire', { method: 'POST' });
      api.ui.toast('公告已下线');
      adminItems = null;
      api.refreshPanel();
      refresh();
    } catch (error) {
      api.ui.toast('下线失败：' + (error.message || '网络错误'));
    }
  }

  function onAction(action, target) {
    if (action === 'ann-publish') {
      publish();
      return true;
    }
    if (action === 'ann-retire') {
      retire(target.dataset.id);
      return true;
    }
    return false;
  }

  function init() {
    const api = cloud();
    if (!api) return;
    api.addPanelSection({ render: renderAdmin, onAction: onAction });
    api.onAuthChange(function () {
      adminItems = null;
    });
    refresh();
    schedule();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { refresh: refresh, dismiss: dismiss };
})();
