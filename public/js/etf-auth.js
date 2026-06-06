// =============================================
//   ETF 股票分析系統 — Firebase 驗證 + 管理員控制台
// =============================================
(function () {
  'use strict';

  // ── Firebase 設定（與主系統共用同一 Firebase 專案）──
  const firebaseConfig = {
    apiKey:            "AIzaSyBQHx2VC8SvwjOOTunbq6PiIS5HxB79u40",
    authDomain:        "ncutcc-cd082.firebaseapp.com",
    projectId:         "ncutcc-cd082",
    storageBucket:     "ncutcc-cd082.firebasestorage.app",
    messagingSenderId: "755991311078",
    appId:             "1:755991311078:web:6db31913e05e97ee460127"
  };

  firebase.initializeApp(firebaseConfig);
  const auth     = firebase.auth();
  const provider = new firebase.auth.GoogleAuthProvider();

  // ── DOM 參考 ──
  const overlay    = document.getElementById('auth-overlay');
  const loginBtn   = document.getElementById('google-login-btn');
  const authError  = document.getElementById('auth-error');
  const userBar    = document.getElementById('user-bar');
  const userAvatar = document.getElementById('user-avatar');
  const userNameEl = document.getElementById('user-name-text');
  const logoutBtn  = document.getElementById('logout-btn');
  const adminBtn   = document.getElementById('admin-panel-btn');
  const adminModal = document.getElementById('admin-modal');
  const adminClose = document.getElementById('admin-close-btn');
  const adminSave  = document.getElementById('admin-save-btn');
  const saveResult = document.getElementById('admin-save-result');
  const togglePublic = document.getElementById('toggle-public');

  // 管理員 tag 區塊設定
  const TAG_CONFIGS = [
    { key: 'admins',         listId: 'tag-list-admins',   inputId: 'input-admins',   addId: 'add-admins' },
    { key: 'allowedUsers',   listId: 'tag-list-users',    inputId: 'input-users',    addId: 'add-users'  },
    { key: 'allowedDomains', listId: 'tag-list-domains',  inputId: 'input-domains',  addId: 'add-domains'},
  ];

  // ── 全域 Token（供 app.js API 呼叫使用）──
  window._fbIdToken = null;
  window._fbIsAdmin = false;

  // ── 取得最新 ID Token ──
  async function refreshToken() {
    const user = auth.currentUser;
    if (!user) return null;
    const token = await user.getIdToken(true);
    window._fbIdToken = token;
    return token;
  }

  // ── 登入 ──
  loginBtn.addEventListener('click', async () => {
    authError.classList.remove('show');
    try {
      await auth.signInWithPopup(provider);
    } catch (e) {
      authError.textContent = '登入失敗：' + (e.message || '請重試');
      authError.classList.add('show');
    }
  });

  // ── 登出 ──
  logoutBtn.addEventListener('click', () => auth.signOut());

  // ── 偵聽登入狀態 ──
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      // 取得 ID Token
      let token;
      try { token = await user.getIdToken(true); }
      catch { token = await user.getIdToken(); }
      window._fbIdToken = token;

      // ── 步驟1：確認此帳號是否有存取權限 ──────────────────────
      async function checkAccess(retry = 0) {
        try {
          const resp = await fetch((window.API_BASE || '') + '/api/auth/check', {
            headers: { Authorization: 'Bearer ' + window._fbIdToken }
          });
          if (resp.ok) {
            const data = await resp.json();
            window._fbIsAdmin = data.isAdmin;
            if (adminBtn) adminBtn.style.display = data.isAdmin ? 'flex' : 'none';
            return true;   // ✅ 有權限
          }
          // Token 過期就重試一次
          if (resp.status === 401 && retry === 0) {
            window._fbIdToken = await user.getIdToken(true);
            return checkAccess(1);
          }
          // 無存取權限
          const data = await resp.json().catch(() => ({}));
          authError.textContent = `帳號 ${user.email} 沒有存取權限，請聯絡管理員。`;
          authError.classList.add('show');
          await auth.signOut();
          return false;   // ❌ 無權限，已登出
        } catch {
          // 網路錯誤：放行（避免誤擋，伺服器端仍會驗證每個 API）
          window._fbIsAdmin = false;
          if (adminBtn) adminBtn.style.display = 'none';
          return true;
        }
      }
      const hasAccess = await checkAccess();
      if (!hasAccess) return;  // 已登出，不繼續

      // 更新 UI：顯示使用者列
      if (userAvatar) userAvatar.src = user.photoURL ||
        'https://ui-avatars.com/api/?name=' + encodeURIComponent(user.displayName || 'U') + '&background=006874&color=fff';
      if (userNameEl) userNameEl.textContent = user.displayName || user.email;
      if (userBar) userBar.classList.add('show');

      // 登入後才顯示主要介面 + 設定頁面標題
      document.getElementById('app-header')?.style.setProperty('display', '');
      document.getElementById('app-layout')?.style.setProperty('display', '');
      document.title = '台灣季配息股票分析';

      // 隱藏登入遮罩
      overlay.classList.add('hidden');
      setTimeout(() => { overlay.style.display = 'none'; }, 450);

      // 顯示鈴鐺按鈕並初始化推播 UI
      const bellBtn = document.getElementById('pwa-bell-btn');
      if (bellBtn) bellBtn.style.display = '';
      window.ETFPwa?.onLogin();

      // 啟動主應用程式（載入觀察清單 + 開始定時刷新）
      window.ETFApp?.start();

      // 定時刷新 Token（每 50 分鐘）
      setInterval(refreshToken, 50 * 60 * 1000);

    } else {
      window._fbIdToken = null;
      window._fbIsAdmin = false;
      if (userBar) userBar.classList.remove('show');
      if (adminBtn) adminBtn.style.display = 'none';
      // 停止主應用程式，登出後隱藏主介面，還原 title，顯示登入遮罩
      window.ETFApp?.stop();
      const bellBtn = document.getElementById('pwa-bell-btn');
      if (bellBtn) bellBtn.style.display = 'none';
      document.getElementById('app-header')?.style.setProperty('display', 'none');
      document.getElementById('app-layout')?.style.setProperty('display', 'none');
      document.title = 'ETF 股票分析';
      overlay.style.display = '';
      setTimeout(() => overlay.classList.remove('hidden'), 10);
    }
  });

  // =========================================
  //  管理員控制台
  // =========================================
  let currentConfig = {};

  function renderTags(key, listId) {
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = '';
    const items = currentConfig[key] || [];
    if (!items.length) {
      list.innerHTML = '<span class="admin-empty-hint">（尚無項目）</span>';
      return;
    }
    items.forEach((val, idx) => {
      const tag = document.createElement('div');
      tag.className = 'admin-tag';
      tag.innerHTML = `${val}<button class="admin-tag-remove" data-key="${key}" data-idx="${idx}" title="移除">
        <span class="material-symbols-outlined">close</span></button>`;
      list.appendChild(tag);
    });
    list.querySelectorAll('.admin-tag-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.key;
        const i = parseInt(btn.dataset.idx);
        currentConfig[k].splice(i, 1);
        renderTags(k, TAG_CONFIGS.find(c => c.key === k).listId);
      });
    });
  }

  function renderAllTags() {
    TAG_CONFIGS.forEach(({ key, listId }) => renderTags(key, listId));
  }

  // 新增 tag 按鈕
  TAG_CONFIGS.forEach(({ key, inputId, addId, listId }) => {
    const addBtn = document.getElementById(addId);
    const input  = document.getElementById(inputId);
    if (!addBtn || !input) return;
    addBtn.addEventListener('click', () => {
      const val = input.value.trim();
      if (!val) return;
      if (!currentConfig[key]) currentConfig[key] = [];
      if (!currentConfig[key].includes(val)) {
        currentConfig[key].push(val);
        renderTags(key, listId);
      }
      input.value = '';
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
  });

  // isPublic toggle
  if (togglePublic) {
    togglePublic.addEventListener('change', () => {
      currentConfig.isPublic = togglePublic.checked;
    });
  }

  // ── 同步狀態顯示 ─────────────────────────────────────────────
  async function loadSyncStatus() {
    const panel = document.getElementById('sync-status-panel');
    if (!panel) return;
    panel.innerHTML = '<span style="opacity:.6">載入中…</span>';
    try {
      const token = await refreshToken();
      const resp  = await fetch((window.API_BASE || '') + '/api/sync/status', {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!resp.ok) { panel.innerHTML = '<span style="color:#e57373">無法取得狀態</span>'; return; }
      const s = await resp.json();

      function badge(val, okText, failText, skipText) {
        if (val === 'success')   return `<span style="color:#81c784">✅ ${okText}</span>`;
        if (val === 'failed')    return `<span style="color:#e57373">❌ ${failText}</span>`;
        if (val === 'no_change') return `<span style="color:#90caf9">⏭ 無變更</span>`;
        if (val === 'skipped')   return `<span style="color:#aaa">⚪ ${skipText}</span>`;
        return `<span style="color:#aaa">⚪ 尚未執行</span>`;
      }
      function fmtTime(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      }

      panel.innerHTML = [
        `<b>環境設定</b>`,
        `&nbsp; GITHUB_TOKEN：${s.githubToken ? '✅ 已設定' : '❌ 未設定'}`,
        `&nbsp; RENDER_DEPLOY_HOOK：${s.renderDeployHook ? '✅ 已設定' : '❌ 未設定'}`,
        ``,
        `<b>啟動時 git pull</b>`,
        `&nbsp; 結果：${badge(s.startupPullResult, '成功', '失敗', '未設定 Token')}`,
        `&nbsp; 時間：${fmtTime(s.startupPullAt)}`,
        ``,
        `<b>最後一次 git push</b>`,
        `&nbsp; 結果：${badge(s.lastPushResult, '推送成功', '推送失敗', '—')}`,
        `&nbsp; 時間：${fmtTime(s.lastPushAt)}`,
        `&nbsp; 訊息：${s.lastPushMessage || '—'}`,
        s.lastPushError ? `&nbsp; 錯誤：<span style="color:#e57373">${s.lastPushError}</span>` : '',
        ``,
        `<b>最後一次 Render 重新部署</b>`,
        `&nbsp; 結果：${badge(s.lastDeployResult, '觸發成功', '觸發失敗', '未設定 Hook')}`,
        `&nbsp; 時間：${fmtTime(s.lastDeployAt)}`,
      ].filter(l => l !== undefined).join('<br>');
    } catch {
      panel.innerHTML = '<span style="color:#e57373">連線失敗</span>';
    }
  }

  // 重新整理按鈕
  const syncRefreshBtn = document.getElementById('sync-refresh-btn');
  if (syncRefreshBtn) syncRefreshBtn.addEventListener('click', loadSyncStatus);

  // 開啟管理員面板
  if (adminBtn) {
    adminBtn.addEventListener('click', async () => {
      if (saveResult) { saveResult.textContent = ''; saveResult.className = 'admin-save-result'; }
      adminModal.classList.add('open');
      try {
        const token = await refreshToken();
        const resp = await fetch((window.API_BASE || '') + '/api/admin/config', {
          headers: { Authorization: 'Bearer ' + token }
        });
        if (resp.ok) currentConfig = await resp.json();
        else currentConfig = { isPublic: false, admins: [], allowedUsers: [], allowedDomains: [] };
      } catch {
        currentConfig = { isPublic: false, admins: [], allowedUsers: [], allowedDomains: [] };
      }
      if (togglePublic) togglePublic.checked = !!currentConfig.isPublic;
      renderAllTags();
      loadSyncStatus();  // 開啟面板時自動載入同步狀態
    });
  }

  // 關閉面板
  if (adminClose) adminClose.addEventListener('click', () => adminModal.classList.remove('open'));
  if (adminModal) adminModal.addEventListener('click', e => {
    if (e.target === adminModal) adminModal.classList.remove('open');
  });

  // 測試推播
  const testPushBtn = document.getElementById('admin-test-push-btn');
  const pushResult  = document.getElementById('admin-push-result');
  if (testPushBtn) {
    testPushBtn.addEventListener('click', async () => {
      testPushBtn.disabled = true;
      if (pushResult) { pushResult.textContent = '發送中...'; pushResult.className = 'admin-save-result'; }
      try {
        const token = await refreshToken();
        const resp = await fetch((window.API_BASE || '') + '/api/push/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok) {
          if (pushResult) { pushResult.textContent = '✅ 測試通知已發送！請查看裝置通知欄。'; pushResult.className = 'admin-save-result admin-save-result--ok'; }
        } else {
          if (pushResult) { pushResult.textContent = '❌ ' + (data.error || '發送失敗'); pushResult.className = 'admin-save-result admin-save-result--err'; }
        }
      } catch {
        if (pushResult) { pushResult.textContent = '❌ 連線失敗'; pushResult.className = 'admin-save-result admin-save-result--err'; }
      }
      testPushBtn.disabled = false;
      setTimeout(() => { if (pushResult) { pushResult.textContent = ''; pushResult.className = 'admin-save-result'; } }, 4000);
    });
  }

  // 儲存設定
  if (adminSave) {
    adminSave.addEventListener('click', async () => {
      adminSave.disabled = true;
      saveResult.textContent = '儲存中...';
      saveResult.className = 'admin-save-result';
      try {
        const token = await refreshToken();
        const resp = await fetch((window.API_BASE || '') + '/api/admin/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify(currentConfig)
        });
        if (resp.ok) {
          saveResult.textContent = '✅ 設定已儲存！正在同步到 GitHub…';
          saveResult.className = 'admin-save-result admin-save-result--ok';
          // 3 秒後重新整理同步狀態（等 git push 完成）
          setTimeout(loadSyncStatus, 3000);
        } else {
          const data = await resp.json().catch(() => ({}));
          saveResult.textContent = '❌ 錯誤：' + (data.error || '未知');
          saveResult.className = 'admin-save-result admin-save-result--err';
        }
      } catch {
        saveResult.textContent = '❌ 連線失敗';
        saveResult.className = 'admin-save-result admin-save-result--err';
      }
      adminSave.disabled = false;
      setTimeout(() => {
        saveResult.textContent = '';
        saveResult.className = 'admin-save-result';
      }, 3000);
    });
  }

})();
