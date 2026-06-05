/* ============================================================
   ETF PWA — Service Worker 註冊 + 推播通知訂閱
   由 etf-auth.js 在登入成功後呼叫 window.ETFPwa.init()
   ============================================================ */

window.ETFPwa = (function () {
  'use strict';

  let _swReg = null;

  // ── SW 註冊（頁面載入即執行）──────────────────────────────────
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      _swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      console.log('[PWA] Service Worker 已註冊');
      return _swReg;
    } catch (e) {
      console.warn('[PWA] SW 註冊失敗:', e.message);
      return null;
    }
  }

  // ── base64 URL → Uint8Array（VAPID public key 轉換）──────────
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  // ── 訂閱推播 ─────────────────────────────────────────────────
  async function subscribe() {
    if (!_swReg) {
      alert('瀏覽器不支援推播通知。請使用 Chrome / Edge。');
      return false;
    }

    // 1. 請求通知權限
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      alert('未取得通知權限，無法接收除息提醒。');
      return false;
    }

    try {
      // 2. 取得 VAPID 公鑰
      const keyRes = await fetch((window.API_BASE || '') + '/api/push/vapid-public-key', {
        headers: window._fbIdToken ? { Authorization: 'Bearer ' + window._fbIdToken } : {}
      });
      const { publicKey } = await keyRes.json();

      // 3. 建立 Push 訂閱
      const sub = await _swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // 4. 送到伺服器儲存
      await fetch((window.API_BASE || '') + '/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(window._fbIdToken ? { Authorization: 'Bearer ' + window._fbIdToken } : {})
        },
        body: JSON.stringify(sub.toJSON()),
      });

      console.log('[PWA] 推播訂閱成功');
      return true;
    } catch (e) {
      console.error('[PWA] 推播訂閱失敗:', e.message);
      alert('推播訂閱失敗：' + e.message);
      return false;
    }
  }

  // ── 取消訂閱 ─────────────────────────────────────────────────
  async function unsubscribe() {
    if (!_swReg) return false;
    try {
      const sub = await _swReg.pushManager.getSubscription();
      if (!sub) return true;

      await fetch((window.API_BASE || '') + '/api/push/unsubscribe', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(window._fbIdToken ? { Authorization: 'Bearer ' + window._fbIdToken } : {})
        },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });

      await sub.unsubscribe();
      console.log('[PWA] 已取消推播訂閱');
      return true;
    } catch (e) {
      console.error('[PWA] 取消訂閱失敗:', e.message);
      return false;
    }
  }

  // ── 查詢目前是否已訂閱 ────────────────────────────────────────
  async function isSubscribed() {
    if (!_swReg) return false;
    const sub = await _swReg.pushManager.getSubscription().catch(() => null);
    return !!sub;
  }

  // ── 更新 UI 按鈕狀態 ─────────────────────────────────────────
  async function updateBellUI() {
    const btn = document.getElementById('pwa-bell-btn');
    if (!btn) return;
    const supported = 'serviceWorker' in navigator && 'PushManager' in window;
    if (!supported) { btn.style.display = 'none'; return; }

    const subscribed = await isSubscribed();
    btn.title = subscribed ? '已開啟除息提醒（點擊關閉）' : '開啟除息推播提醒';
    btn.innerHTML = subscribed
      ? '<span class="material-symbols-outlined pwa-bell-icon pwa-bell--on">notifications_active</span>'
      : '<span class="material-symbols-outlined pwa-bell-icon">notifications</span>';
    btn.dataset.on = subscribed ? '1' : '0';
  }

  // ── 鈴鐺按鈕點擊 ─────────────────────────────────────────────
  async function toggleNotification() {
    const btn = document.getElementById('pwa-bell-btn');
    if (!btn) return;
    btn.disabled = true;

    const on = btn.dataset.on === '1';
    if (on) {
      const ok = await unsubscribe();
      if (ok) showBellToast('🔕 除息提醒已關閉');
    } else {
      const ok = await subscribe();
      if (ok) showBellToast('🔔 已開啟！除息前一天將收到通知');
    }
    await updateBellUI();
    btn.disabled = false;
  }

  function showBellToast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'show success';
    setTimeout(() => { t.className = ''; }, 3500);
  }

  // ── 公開介面 ─────────────────────────────────────────────────
  return {
    // 頁面載入即呼叫（登入前就可以）
    init: registerSW,
    // 登入後呼叫，掛載鈴鐺按鈕互動
    onLogin: async function () {
      await updateBellUI();
      const btn = document.getElementById('pwa-bell-btn');
      if (btn) btn.addEventListener('click', toggleNotification);
    },
    updateUI: updateBellUI,
  };
})();

// SW 立即在頁面載入時註冊（不需等待登入）
ETFPwa.init();
