const API = window.API_BASE || '';
const SHARED_ID = '__shared__';   // 共用預設清單 id（與 server.js 同步）
let activeSymbol = null;
let priceChart = null;
let refreshTimer = null;
let watchlistData = {};
let sortMode = 'exdiv';
let _activeListId       = localStorage.getItem('etf_active_list') || 'default';
let _activeListReadonly = false;   // 當前清單是否為唯讀（共用清單）
let _refreshListTabs    = null;    // initLists() 完成後設定，供 addStock() 呼叫
// 本地端暫存的重命名（server round-trip 前保護 tab 名稱不被舊資料覆蓋）
// 格式：{ listId: newName }。持久化至 localStorage，頁面重載後仍有效
const _pendingRenames = (() => {
  try { return JSON.parse(localStorage.getItem('etf_pending_renames') || '{}'); } catch { return {}; }
})();
// 本地端暫存的新增清單（server 尚未持有 / Render 重啟後遺失時的備援）
// 格式：[{ id, name }]。持久化至 localStorage，server 確認後自動清除
const _pendingLists = (() => {
  try { return JSON.parse(localStorage.getItem('etf_pending_lists') || '[]'); } catch { return []; }
})();

// ── 信號優先順序 ─────────────────────────────────────────────
const SIGNAL_RANK = { BUY_STRONG: 1, BUY: 2, WAIT_NEXT: 3, WAIT: 4, HOLD: 5, AVOID: 6, UNKNOWN: 7 };
const SIGNAL_LABEL = { BUY_STRONG: '強力買進', BUY: '可買進', WAIT_NEXT: '等下次', WAIT: '觀望', HOLD: '持有', AVOID: '避開', UNKNOWN: '—' };
const SIGNAL_COLOR = { BUY_STRONG: '#00d084', BUY: '#4f7cff', WAIT_NEXT: '#a78bfa', WAIT: '#7c85a2', HOLD: '#7c85a2', AVOID: '#ff4d6d', UNKNOWN: '#3a3f5c' };

// ── LocalStorage 快取層 ──────────────────────────────────────────
const LS_KEY = 'etf_watchlist_v1';

function lsSave(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch {}
}
function lsLoad() {
  try {
    const v = localStorage.getItem(LS_KEY);
    const parsed = v ? JSON.parse(v) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// ── 帶 Firebase Token 的 fetch 封裝 ─────────────────────────────
async function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (window._fbIdToken) headers['Authorization'] = 'Bearer ' + window._fbIdToken;
  // cache:'no-store' 防止瀏覽器快取 API 回應，確保每次都拿最新資料
  const res = await fetch(API + url, { cache: 'no-store', ...opts, headers });
  if (res.status === 401) {
    showToast('請先登入才能使用此功能', 'error');
    throw new Error('Unauthorized');
  }
  return res;
}

// ── 時鐘與市場狀態 ──────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const tw = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(now);
  document.getElementById('clock').textContent = tw + ' (台灣時間)';

  // 台股交易時間 09:00–13:30，週一至週五
  const twNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = twNow.getDay();
  const h = twNow.getHours(), m = twNow.getMinutes();
  const mins = h * 60 + m;
  const isOpen = day >= 1 && day <= 5 && mins >= 9 * 60 && mins < 13 * 60 + 30;
  const badge = document.getElementById('market-status');
  badge.textContent = isOpen ? '● 台股開盤中' : '● 台股休市';
  badge.className = 'market-badge ' + (isOpen ? 'open' : 'closed');
}
setInterval(updateClock, 1000);
updateClock();

// ── Tab badge 即時更新（不依賴 server round-trip）──────────────
function _updateTabBadge(listId, delta) {
  const badge = document.querySelector(
    `.list-tab-wrap[data-id="${listId}"] .list-tab-count`
  );
  if (!badge) return;
  const current = parseInt(badge.textContent, 10);
  if (!isNaN(current)) badge.textContent = Math.max(0, current + delta);
}

// ── Toast 通知 ──────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show ${type}`;
  setTimeout(() => { t.className = ''; }, 3000);
}

// ── 自訂對話框（取代 prompt / confirm，相容所有手機瀏覽器）────
function _createModalBackdrop() {
  const bd = document.createElement('div');
  bd.style.cssText = [
    'position:fixed','inset:0','background:rgba(0,0,0,.55)',
    'z-index:99999','display:flex','align-items:center','justify-content:center',
    'padding:16px','box-sizing:border-box'
  ].join(';');
  return bd;
}
function _createModalBox(html) {
  const box = document.createElement('div');
  box.style.cssText = [
    'background:var(--surface,#1e2433)','border-radius:16px','padding:22px 20px',
    'min-width:260px','max-width:min(400px,90vw)','width:100%',
    'box-shadow:0 8px 40px rgba(0,0,0,.5)','color:var(--on-surface,#e4e8f0)',
    'font-family:inherit'
  ].join(';');
  box.innerHTML = html;
  return box;
}

/** 取代 prompt()：顯示輸入框，回傳 Promise<string|null> */
function showInputModal(message, defaultValue = '') {
  return new Promise(resolve => {
    const bd  = _createModalBackdrop();
    const esc = encodeURIComponent(defaultValue).replace(/%/g,'%');
    const box = _createModalBox(`
      <div style="font-size:.95rem;margin-bottom:14px;line-height:1.5">${message}</div>
      <input id="_mi_input" autocomplete="off" style="
        width:100%;box-sizing:border-box;padding:9px 12px;
        border-radius:9px;border:1.5px solid var(--border,#2e3650);
        background:var(--bg,#131722);color:var(--on-surface,#e4e8f0);
        font-size:.95rem;outline:none;
      " value="">
      <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">
        <button id="_mi_cancel" style="
          padding:7px 16px;border-radius:9px;border:1px solid var(--border,#2e3650);
          background:transparent;color:var(--muted,#8892a4);cursor:pointer;font-size:.9rem
        ">取消</button>
        <button id="_mi_ok" style="
          padding:7px 18px;border-radius:9px;border:none;
          background:var(--accent,#4c8dff);color:#fff;cursor:pointer;font-size:.9rem;font-weight:600
        ">確認</button>
      </div>
    `);
    bd.appendChild(box);
    document.body.appendChild(bd);

    const input = box.querySelector('#_mi_input');
    input.value = defaultValue;
    setTimeout(() => { input.focus(); input.select(); }, 60);

    const ok = () => {
      const v = input.value.trim();
      document.body.removeChild(bd);
      resolve(v || null);
    };
    const cancel = () => { document.body.removeChild(bd); resolve(null); };

    box.querySelector('#_mi_ok').addEventListener('click', ok);
    box.querySelector('#_mi_cancel').addEventListener('click', cancel);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') cancel(); });
    bd.addEventListener('click', e => { if (e.target === bd) cancel(); });
  });
}

/** 取代 confirm()：顯示確認框，回傳 Promise<boolean> */
function showConfirmModal(message) {
  return new Promise(resolve => {
    const bd  = _createModalBackdrop();
    const box = _createModalBox(`
      <div style="font-size:.95rem;line-height:1.6;white-space:pre-line;margin-bottom:18px">${message}</div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="_mc_cancel" style="
          padding:7px 16px;border-radius:9px;border:1px solid var(--border,#2e3650);
          background:transparent;color:var(--muted,#8892a4);cursor:pointer;font-size:.9rem
        ">取消</button>
        <button id="_mc_ok" style="
          padding:7px 18px;border-radius:9px;border:none;
          background:#e05252;color:#fff;cursor:pointer;font-size:.9rem;font-weight:600
        ">確定刪除</button>
      </div>
    `);
    bd.appendChild(box);
    document.body.appendChild(bd);

    const yes  = () => { document.body.removeChild(bd); resolve(true); };
    const no   = () => { document.body.removeChild(bd); resolve(false); };

    box.querySelector('#_mc_ok').addEventListener('click', yes);
    box.querySelector('#_mc_cancel').addEventListener('click', no);
    bd.addEventListener('click', e => { if (e.target === bd) no(); });
  });
}

// ── 數字格式化 ──────────────────────────────────────────────
function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-TW', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtChange(v, pct) {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${fmt(v)} (${sign}${fmt(pct)}%)`;
}

// ── 觀察清單 ────────────────────────────────────────────────
async function loadWatchlist() {
  const container = document.getElementById('watchlist');

  // ── 本地資料來源 ────────────────────────────────────────────────
  const lsKey  = `etf_wl_${_activeListId}`;
  const delKey = `etf_del_${_activeListId}`;   // 本地明確刪除的股票清單
  const cached  = (() => { try { return JSON.parse(localStorage.getItem(lsKey)  || '[]'); } catch { return []; } })();
  const deleted = (() => { try { return JSON.parse(localStorage.getItem(delKey) || '[]'); } catch { return []; } })();

  // 1. 立即顯示本地快取（不等伺服器）
  // Promise.all：所有卡片佔位符立即插入 DOM（保持順序），API 並行請求，不產生逐一掃描效果
  if (cached.length) {
    container.innerHTML = '';
    await Promise.all(cached.map(sym => fetchAndRenderCard(sym)));
  } else {
    container.innerHTML = '<div class="loading" style="padding:20px;text-align:center">載入中…</div>';
  }

  // 2. 從伺服器同步（合併策略：localStorage 永遠只增不減）
  try {
    const res  = await apiFetch(`/api/watchlist?list=${_activeListId}`);
    const data = await res.json();
    const list = data.stocks || [];

    // 更新唯讀狀態
    _activeListReadonly = !!(data.readonly && !window._fbIsAdmin);
    _updateAddStockUI();

    // ── 合併策略 ────────────────────────────────────────────────
    // 取 local ∪ server，排除本地「明確刪除」的股票
    // 只有 removeStock() 才能讓 localStorage 變少，防止
    // Render 新實例回傳空/舊資料把使用者剛新增的股票抹掉
    const deletedSet = new Set(deleted);
    const merged = [...new Set([...cached, ...list])].filter(s => !deletedSet.has(s));

    // 清除已被伺服器確認刪除的暫存紀錄（server 沒有該支 = 刪除已同步）
    if (deleted.length > 0) {
      const stillPending = deleted.filter(s => list.includes(s));
      stillPending.length
        ? localStorage.setItem(delKey, JSON.stringify(stillPending))
        : localStorage.removeItem(delKey);
    }

    localStorage.setItem(lsKey, JSON.stringify(merged));

    // 若合併後與原本 cached 不同才重新渲染
    const cachedStr = JSON.stringify([...cached].sort());
    const mergedStr = JSON.stringify([...merged].sort());
    if (cachedStr !== mergedStr) {
      container.innerHTML = '';
      if (!merged.length) {
        container.innerHTML = '<div class="loading" style="padding:20px;text-align:center">尚無觀察股票<br><small style="color:#7c85a2">在上方輸入代碼新增</small></div>';
        return;
      }
      await Promise.all(merged.map(sym => fetchAndRenderCard(sym)));
    } else if (!merged.length) {
      container.innerHTML = '<div class="loading" style="padding:20px;text-align:center">尚無觀察股票<br><small style="color:#7c85a2">在上方輸入代碼新增</small></div>';
    }
  } catch {
    if (!cached.length)
      container.innerHTML = '<div class="loading" style="padding:20px;text-align:center;color:#ff4d6d">伺服器無回應<br><small>顯示上次快取</small></div>';
  }
}

// ── 計算距離今天幾天 ─────────────────────────────────────────
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const diff = new Date(dateStr) - new Date(new Date().toDateString());
  return Math.round(diff / 86400000);
}

const SELL_SIGNAL_COLOR = {
  SELL_STRONG: '#ff4d6d', SELL: '#ff8a00', TAKE_PROFIT: '#fbbf24',
  HOLD_PROFIT: '#00d084', WAIT_FILL: '#64748b', EVALUATE: '#4f7cff',
  HOLD: '#64748b', UNKNOWN: '#3a3f5c',
};
const SELL_SIGNAL_LABEL = {
  SELL_STRONG: '強力賣出', SELL: '建議賣出', TAKE_PROFIT: '部分賣出',
  HOLD_PROFIT: '持有獲利', WAIT_FILL: '持有等填息', EVALUATE: '評估停損',
  HOLD: '持有中', UNKNOWN: '—',
};

function exDivBadgeHtml(nextDate, signal, sellSignal, sellGainPct) {
  const days = daysUntil(nextDate);
  let dateHtml = '';
  if (nextDate) {
    let urgClass = 'exdiv-badge';
    if (days !== null && days <= 0)       urgClass += ' exdiv-passed';
    else if (days !== null && days <= 14) urgClass += ' exdiv-urgent';
    else if (days !== null && days <= 30) urgClass += ' exdiv-soon';
    const daysLabel = days === null ? '' : days <= 0 ? '（已過）' : `（${days}天後）`;
    dateHtml = `<span class="${urgClass}">🗓 ${nextDate} ${daysLabel}</span>`;
  }
  // 買入信號
  const sig    = signal     || 'UNKNOWN';
  const buySig = `<span class="signal-dot" style="background:${SIGNAL_COLOR[sig] || '#3a3f5c'}" title="買入：${SIGNAL_LABEL[sig] || sig}"></span><span class="signal-label" style="color:${SIGNAL_COLOR[sig] || '#3a3f5c'}">${SIGNAL_LABEL[sig] || sig}</span>`;
  // 賣出信號
  const ssig   = sellSignal || 'UNKNOWN';
  const gainBadge = sellGainPct != null ? `<span style="font-size:.62rem;background:rgba(255,255,255,.1);padding:1px 5px;border-radius:99px;color:${sellGainPct >= 0 ? '#00d084' : '#ff4d6d'}">${sellGainPct >= 0 ? '+' : ''}${sellGainPct.toFixed(1)}%</span>` : '';
  const sellSig = `<span class="signal-dot" style="background:${SELL_SIGNAL_COLOR[ssig] || '#3a3f5c'}" title="賣出：${SELL_SIGNAL_LABEL[ssig] || ssig}"></span><span class="signal-label" style="color:${SELL_SIGNAL_COLOR[ssig] || '#3a3f5c'}">${SELL_SIGNAL_LABEL[ssig] || ssig}</span>${gainBadge}`;

  return `<div class="card-exdiv-row">${dateHtml}</div>
    <div class="card-signal-row">
      <div class="card-signal" title="買入信號">📥 ${buySig}</div>
      <div class="card-signal" title="賣出信號">📤 ${sellSig}</div>
    </div>`;
}

async function fetchAndRenderCard(symbol) {
  const container = document.getElementById('watchlist');
  let card = document.getElementById(`card-${symbol}`);
  if (!card) {
    card = document.createElement('div');
    card.id = `card-${symbol}`;
    card.className = 'stock-card' + (symbol === activeSymbol ? ' active' : '');
    card.onclick = () => selectStock(symbol);
    container.appendChild(card);
  }
  try {
    // 同時抓取報價、配息、除權息分析（fill-analysis 含 nextExDivEstimate + signal）
    const [quoteRes, divRes, fillRes] = await Promise.all([
      apiFetch(`/api/stock/${symbol}`),
      apiFetch(`/api/stock/${symbol}/dividends`),
      apiFetch(`/api/stock/${symbol}/fill-analysis`),
    ]);
    const q    = await quoteRes.json();
    const d    = divRes.ok  ? await divRes.json()  : null;
    const fill = fillRes.ok ? await fillRes.json() : null;

    if (q.error) {
      const _canRm = !_activeListReadonly;
      card.innerHTML = `
        ${_canRm ? `<button class="btn-remove" onclick="removeStock(event,'${symbol}')">✕</button>` : ''}
        <div class="symbol">${symbol}</div>
        <div class="error-msg" style="font-size:.8rem">${q.error}</div>`;
      return;
    }

    watchlistData[symbol] = { quote: q, div: d, fill };

    const isQ    = d?.isQuarterly;
    const chg    = q.change ?? 0;
    const chgPct = q.changePercent ?? 0;
    const chgClass = chg >= 0 ? 'up' : 'down';
    const sign     = chg >= 0 ? '+' : '';
    const nextEx      = fill?.nextExDivEstimate || null;
    const signal      = fill?.signal     || 'UNKNOWN';
    const sellSignal  = fill?.sellSignal  || 'UNKNOWN';
    const sellGainPct = fill?.sellGainPct ?? null;

    const code = symbol.replace('.TW', '');
    // 唯讀清單（共用清單 + 非管理員）→ 隱藏移除按鈕
    const canRemove = !_activeListReadonly;
    card.innerHTML = `
      ${canRemove ? `<button class="btn-remove" onclick="removeStock(event,'${symbol}')">✕</button>` : ''}
      <div class="card-top">
        <div class="card-identity">
          <div class="card-code">${code}</div>
          <div class="card-name">${q.shortName || code}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="price ${chgClass}">${fmt(q.price)}</div>
          <div class="change ${chgClass}">${sign}${fmt(chg)} (${sign}${fmt(chgPct)}%)</div>
        </div>
      </div>
      ${exDivBadgeHtml(nextEx, signal, sellSignal, sellGainPct)}
      ${isQ ? `<div class="quarterly-badge">★ 季配息 · 年均${d.avgAnnualCount}次</div>` : ''}
    `;
    card.className = 'stock-card' + (symbol === activeSymbol ? ' active' : '');
    card.onclick = () => selectStock(symbol);

    // 每次卡片更新後重新套用排序
    applySort();
  } catch {
    const _canRm = !_activeListReadonly;
    card.innerHTML = `
      ${_canRm ? `<button class="btn-remove" onclick="removeStock(event,'${symbol}')">✕</button>` : ''}
      <div class="symbol">${symbol}</div>
      <div style="color:var(--muted);font-size:.8rem">資料載入失敗</div>`;
  }
}

// 根據唯讀狀態更新搜尋 input 的提示文字和新增按鈕的可用狀態
function _updateAddStockUI() {
  const input  = document.getElementById('search-input');
  const addBtn = document.querySelector('.btn-add');
  if (!input || !addBtn) return;
  if (_activeListReadonly) {
    input.placeholder  = '（共用清單由管理員管理）';
    input.disabled     = true;
    addBtn.disabled    = true;
    addBtn.style.opacity = '0.4';
  } else {
    input.placeholder  = '輸入股票代碼（如 2330）';
    input.disabled     = false;
    addBtn.disabled    = false;
    addBtn.style.opacity = '';
  }
}

async function addStock() {
  if (_activeListReadonly) return showToast('共用清單由管理員管理，請切換至個人清單', 'error');
  let sym = document.getElementById('search-input').value.trim().toUpperCase();
  if (!sym) return showToast('請輸入股票代碼', 'error');
  if (!sym.endsWith('.TW')) sym += '.TW';

  // 按鈕 loading 狀態（防重複點擊）
  const addBtn = document.querySelector('.btn-add');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = '…'; }

  try {
    const res = await apiFetch(`/api/watchlist?list=${_activeListId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym }),
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'error'); return; }

    // 同步 localStorage：合併而非覆蓋（新 Render 實例只知道剛加的那支）
    {
      const _lk  = `etf_wl_${_activeListId}`;
      const _dlk = `etf_del_${_activeListId}`;
      const _ex  = (() => { try { return JSON.parse(localStorage.getItem(_lk)  || '[]'); } catch { return []; } })();
      const _dl  = (() => { try { return JSON.parse(localStorage.getItem(_dlk) || '[]'); } catch { return []; } })();
      const _sv  = Array.isArray(data.watchlist) ? data.watchlist : [sym];
      localStorage.setItem(_lk, JSON.stringify([...new Set([..._ex, ..._sv])]));
      // 若此股票之前被刪除又重新新增，清除刪除記錄
      if (_dl.includes(sym)) localStorage.setItem(_dlk, JSON.stringify(_dl.filter(s => s !== sym)));
    }

    document.getElementById('search-input').value = '';
    showToast(`已加入 ${sym}`, 'success');
    const wl = document.getElementById('watchlist');
    if (wl.querySelector('.loading')) wl.innerHTML = '';
    await fetchAndRenderCard(sym);
    selectStock(sym);
    // 立即更新 badge（不等 server round-trip）
    // 注意：不再呼叫 _refreshListTabs()，避免背景拉取到 Render 新實例的 count:0 覆蓋 badge
    _updateTabBadge(_activeListId, +1);
  } catch (e) {
    if (e.message !== 'Unauthorized')
      showToast('新增失敗：' + (e.message || '請稍後再試'), 'error');
  } finally {
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = '＋'; }
  }
}

async function removeStock(e, symbol) {
  e.stopPropagation();
  try {
    const delRes = await apiFetch(`/api/watchlist/${symbol}?list=${_activeListId}`, { method: 'DELETE' });
    try { await delRes.json(); } catch {}   // consume body
    // localStorage 直接刪除該支（合併策略下唯一能減少股票的操作）
    {
      const _lk  = `etf_wl_${_activeListId}`;
      const _dlk = `etf_del_${_activeListId}`;
      const _ex  = (() => { try { return JSON.parse(localStorage.getItem(_lk)  || '[]'); } catch { return []; } })();
      const _dl  = (() => { try { return JSON.parse(localStorage.getItem(_dlk) || '[]'); } catch { return []; } })();
      localStorage.setItem(_lk, JSON.stringify(_ex.filter(s => s !== symbol)));
      // 記錄刪除，防止 loadWatchlist 合併時把此股票從伺服器舊資料帶回
      if (!_dl.includes(symbol)) { _dl.push(symbol); localStorage.setItem(_dlk, JSON.stringify(_dl)); }
    }
    document.getElementById(`card-${symbol}`)?.remove();
    delete watchlistData[symbol];
    if (activeSymbol === symbol) {
      activeSymbol = null;
      document.getElementById('main-panel').innerHTML = '<div class="empty-state"><div class="icon">🔍</div><div>請選擇一支股票查看分析</div></div>';
    }
    const wl = document.getElementById('watchlist');
    if (!wl.children.length) {
      wl.innerHTML = '<div class="loading" style="padding:20px;text-align:center">尚無觀察股票</div>';
    }
    showToast(`已移除 ${symbol}`, 'success');
    // 立即更新 badge（不再呼叫 _refreshListTabs，防止 count 被舊資料覆蓋）
    _updateTabBadge(_activeListId, -1);
  } catch (err) {
    if (err.message !== 'Unauthorized') showToast('移除失敗：' + (err.message || '請稍後再試'), 'error');
  }
}

// Enter 鍵新增
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addStock();
});

// ── 手機：切換至詳情頁 ─────────────────────────────────────────
function mobileShowDetail() {
  if (window.innerWidth <= 768)
    document.getElementById('app-layout')?.classList.add('mobile-detail');
}
function mobileShowList() {
  document.getElementById('app-layout')?.classList.remove('mobile-detail');
}

// ── 選取股票，渲染主面板 ─────────────────────────────────────
async function selectStock(symbol) {
  if (activeSymbol === symbol) {
    // 手機：即使重複點同一股票也要切到詳情
    mobileShowDetail();
    return;
  }
  activeSymbol = symbol;

  // 更新側欄 active 樣式
  document.querySelectorAll('.stock-card').forEach(c => c.classList.remove('active'));
  document.getElementById(`card-${symbol}`)?.classList.add('active');

  mobileShowDetail();
  renderMainPanel(symbol);
}

async function renderMainPanel(symbol) {
  const panel = document.getElementById('main-panel');
  panel.innerHTML = '<div class="loading">載入股票資料中…</div>';

  try {
    const [quoteRes, histRes, divRes, fillRes] = await Promise.all([
      apiFetch(`/api/stock/${symbol}`),
      apiFetch(`/api/stock/${symbol}/history?interval=1d`),   // 預設日K
      apiFetch(`/api/stock/${symbol}/dividends`),
      apiFetch(`/api/stock/${symbol}/fill-analysis`),
    ]);
    const q = await quoteRes.json();
    const hist = await histRes.json();
    const div = divRes.ok ? await divRes.json() : null;
    const fill = fillRes.ok ? await fillRes.json() : null;

    if (q.error) { panel.innerHTML = `<div class="error-msg">${q.error}</div>`; return; }

    const backBtn = `<button class="mobile-back-btn" onclick="mobileShowList()">
      <span class="material-symbols-outlined">arrow_back</span>返回清單
    </button>`;
    panel.innerHTML = backBtn + buildHeroHTML(q, div) + buildYieldHTML(q, div, fill) + buildFillHTML(fill) + buildChartHTML() + buildDividendHTML(div);

    // 初始化日K圖 + tab 切換
    drawPriceChart(hist);
    setupKChartTabs(symbol);
    // 初始化收益試算表格（預設 10 萬）
    window._yieldCalc(document.getElementById('invest-amount')?.value || '100000');
  } catch (err) {
    panel.innerHTML = `<div class="error-msg">載入失敗：${err.message}</div>`;
  }
}

// ── Hero card ────────────────────────────────────────────────
function buildHeroHTML(q, div) {
  const chg = q.change ?? 0;
  const pct = q.changePercent ?? 0;
  const cls = chg >= 0 ? 'up' : 'down';
  const sign = chg >= 0 ? '+' : '';
  const isOpen = q.marketState === 'REGULAR';
  const dotCls = isOpen ? 'live' : 'closed';
  const stateLabel = isOpen ? '即時報價' : '收盤價';

  return `
  <div class="stock-hero">
    <div class="hero-top">
      <div class="hero-title">
        <h2>${q.symbol.replace('.TW', '')}</h2>
        <span class="company">${q.shortName || ''}</span>
        ${div?.isQuarterly ? `<span class="quarterly-badge">★ 季配息 · 年均${div.avgAnnualCount}次</span>` : ''}
      </div>
      <div class="hero-price">
        <div class="price-big ${cls}">${fmt(q.price)} <small style="font-size:.9rem">${q.currency || 'TWD'}</small></div>
        <div class="price-change ${cls}">${sign}${fmt(chg)} (${sign}${fmt(pct)}%)</div>
        <div style="font-size:.75rem;color:var(--muted);margin-top:4px">
          <span class="status-dot ${dotCls}"></span>${stateLabel}
        </div>
      </div>
    </div>
    <div class="hero-stats">
      <div class="stat"><span class="label">本益比</span><span class="value">${fmt(q.trailingPE) === '—' ? '—' : fmt(q.trailingPE, 1) + 'x'}</span></div>
      <div class="stat"><span class="label">殖利率</span><span class="value up">${q.dividendYield ? fmt(q.dividendYield, 2) + '%' : '—'}</span></div>
      <div class="stat"><span class="label">52週高</span><span class="value">${fmt(q.fiftyTwoWeekHigh)}</span></div>
      <div class="stat"><span class="label">52週低</span><span class="value">${fmt(q.fiftyTwoWeekLow)}</span></div>
      <div class="stat"><span class="label">成交量</span><span class="value">${q.volume ? (q.volume / 1000).toFixed(0) + 'K' : '—'}</span></div>
      <div class="stat"><span class="label">市值</span><span class="value">${q.marketCap ? (q.marketCap / 1e8).toFixed(0) + ' 億' : '—'}</span></div>
    </div>
  </div>`;
}

// ── 預估收益分析 ─────────────────────────────────────────────
function buildYieldHTML(q, div, fill) {
  // ── 計算近期平均配息 ──
  const recent = (div?.allDividends || []).slice(-8);
  const avgDiv = recent.length
    ? recent.reduce((s, d) => s + d.amount, 0) / recent.length
    : null;
  const periodsPerYear = div?.avgAnnualCount || 4;
  const estAnnualDiv = avgDiv != null ? avgDiv * periodsPerYear : null;
  const currentPrice = q.price || 0;

  // 買入情境
  const scenarios = [
    { key: 'strong', icon: '🔥', label: '積極買入',  price: fill?.buyLow  },
    { key: 'sweet',  icon: '🎯', label: '甜蜜點',    price: fill?.buyMid  },
    { key: 'safe',   icon: '🛡', label: '保守買入',  price: fill?.buyHigh },
    { key: 'now',    icon: '💹', label: '現價',       price: currentPrice  },
  ].filter(s => s.price != null && s.price > 0);

  // 下次除息時程
  const nextEx = fill?.nextExDivEstimate;
  const daysToEx = daysUntil(nextEx);
  const winStart = fill?.buyWindowStart;
  const winEnd   = fill?.buyWindowEnd;
  const today    = new Date().toISOString().split('T')[0];
  const inWindow = winStart && winEnd && today >= winStart && today <= winEnd;
  const urgentEx = daysToEx !== null && daysToEx >= 0 && daysToEx <= 14;

  // 預估未來4次配息日
  let futureEx = [];
  if (nextEx && avgDiv != null) {
    const daysPerPeriod = Math.round(365 / periodsPerYear);
    for (let i = 0; i < 4; i++) {
      const d = new Date(nextEx);
      d.setDate(d.getDate() + i * daysPerPeriod);
      futureEx.push({ date: d.toISOString().split('T')[0], amount: avgDiv });
    }
  }

  // 互動計算函式（會被 oninput 呼叫）
  window._yieldCalc = function(investInput) {
    const investAmt = Math.max(0, parseFloat(investInput) || 0);
    const tbody = document.getElementById('yield-tbody');
    const lotsHint = document.getElementById('yield-lots-hint');
    if (!tbody) return;

    const rows = scenarios.map(s => {
      const costPerLot = s.price * 1000;
      const lots = investAmt > 0 ? Math.floor(investAmt / costPerLot) : null;
      const shares = lots != null ? lots * 1000 : null;
      const annualIncome = (estAnnualDiv != null && shares != null) ? estAnnualDiv * shares : null;
      const yieldPct = estAnnualDiv != null ? (estAnnualDiv / s.price * 100) : null;
      const fillDays = fill?.avgFillDays;

      const lotsStr     = lots  != null ? `<strong>${lots}</strong> 張` : '—';
      const incomeStr   = annualIncome != null
        ? `<strong>${annualIncome >= 10000 ? (annualIncome / 10000).toFixed(2) + ' 萬' : annualIncome.toFixed(0) + ' 元'}</strong>`
        : '—';
      const yieldColor  = yieldPct >= 6 ? 'var(--accent2)' : yieldPct >= 4 ? 'var(--yellow)' : 'var(--muted)';
      const yieldStr    = yieldPct != null ? `<strong style="color:${yieldColor}">${fmt(yieldPct, 2)}%</strong>` : '—';
      const fillStr     = s.key !== 'now' && fillDays ? `${fillDays} 天` : '—';

      return `<tr>
        <td>${s.icon} ${s.label}</td>
        <td><strong>${fmt(s.price)}</strong></td>
        <td>${lotsStr}</td>
        <td>${fmt(avgDiv)} 元 × ${periodsPerYear} 次</td>
        <td>${incomeStr}</td>
        <td>${yieldStr}</td>
        <td style="color:var(--muted)">${fillStr}</td>
      </tr>`;
    });
    tbody.innerHTML = rows.join('');

    // 投入金額提示
    if (lotsHint && scenarios.length && investAmt > 0) {
      const base = scenarios.find(s => s.key === 'sweet') || scenarios[0];
      const lots = Math.floor(investAmt / (base.price * 1000));
      const leftover = investAmt - lots * base.price * 1000;
      lotsHint.textContent = `(甜蜜點可買 ${lots} 張，剩 ${leftover.toFixed(0)} 元)`;
    } else {
      if (lotsHint) lotsHint.textContent = '';
    }
  };

  const timingHtml = nextEx ? `
    <div class="yield-timing">
      <div class="yt-row ${urgentEx ? 'yt-urgent' : ''}">
        <span class="yt-icon">${urgentEx ? '⚠️' : '🗓'}</span>
        <span>下次除息日 <strong>${nextEx}</strong>（${daysToEx} 天後）
          ${urgentEx ? ' ── 距離除息不足14天，本次配息可能未及入帳，建議等下次' : ''}
        </span>
      </div>
      ${winStart ? `<div class="yt-row ${inWindow ? 'yt-now' : ''}">
        <span class="yt-icon">${inWindow ? '✅' : '⏰'}</span>
        <span>${inWindow ? '<strong>現在正在買入窗口內！</strong>' : '建議買入窗口：'} ${winStart} ～ ${winEnd}</span>
      </div>` : ''}
      ${futureEx.length ? `
      <div class="yt-cal">
        <div class="yt-cal-title">📅 未來配息預估（依歷史週期推算）</div>
        ${futureEx.map((f, i) => `
          <div class="yt-cal-item ${i === 0 ? 'yt-cal-next' : ''}">
            <span class="yt-cal-date">${f.date}</span>
            <span class="yt-cal-div">約 <strong>${fmt(f.amount)}</strong> 元/股</span>
            ${i === 0 ? '<span class="yt-cal-badge">下次</span>' : ''}
          </div>`).join('')}
        <div style="font-size:.7rem;color:var(--muted);margin-top:4px">※ 依歷史平均週期推算，非官方資料，僅供參考</div>
      </div>` : ''}
    </div>` : '';

  const noDataMsg = estAnnualDiv == null
    ? '<div class="loading" style="color:var(--muted);padding:16px">配息資料不足，無法估算收益</div>'
    : '';

  return `
  <div class="yield-section">
    <div class="section-header" style="margin-bottom:14px">
      <h3>💹 預估收益分析</h3>
      ${avgDiv != null ? `<span style="font-size:.8rem;color:var(--muted)">近8次平均每股配息 ${fmt(avgDiv)} 元，年均 ${fmt(estAnnualDiv)} 元</span>` : ''}
    </div>
    ${noDataMsg}
    ${estAnnualDiv != null ? `
    <div class="yield-input-row">
      <span class="yi-label">💰 投入金額</span>
      <input type="number" id="invest-amount" class="yi-input" value="100000" min="0" step="10000"
        oninput="window._yieldCalc(this.value)">
      <span class="yi-unit">元</span>
      <span id="yield-lots-hint" class="yi-hint"></span>
    </div>
    <div class="yield-table-wrap">
      <table class="yield-table">
        <thead>
          <tr>
            <th>情境</th><th>買入價</th><th>可買張數</th>
            <th>每股年均配息</th><th>預估年收益</th><th>殖利率</th><th>平均填息</th>
          </tr>
        </thead>
        <tbody id="yield-tbody"></tbody>
      </table>
    </div>
    ${timingHtml}
    ` : ''}
  </div>`;
}

// ── Fill Analysis HTML ───────────────────────────────────────
function buildFillHTML(fill) {
  if (!fill || !fill.hasData) {
    const msg = fill?.message || '配息紀錄不足，無法進行回補分析';
    return `<div class="fill-section"><div class="loading" style="color:var(--muted)">${msg}</div></div>`;
  }

  const SIGNAL_META = {
    BUY:        { icon: '🟢', label: '建議買入',         cls: 'BUY' },
    BUY_STRONG: { icon: '🔥', label: '強烈建議買入',     cls: 'BUY_STRONG' },
    WAIT:       { icon: '🟡', label: '等待跌深再進場',   cls: 'WAIT' },
    WAIT_NEXT:  { icon: '⏳', label: '等下次除息後進場', cls: 'WAIT_NEXT' },
    HOLD:       { icon: '🔵', label: '持有等填息',       cls: 'HOLD' },
    AVOID:      { icon: '🔴', label: '建議避開',         cls: 'AVOID' },
    UNKNOWN:    { icon: '⚪', label: '資料不足',         cls: 'UNKNOWN' },
  };
  const SELL_META = {
    SELL_STRONG:  { icon: '🔴', label: '強力賣出',     cls: 'SELL_STRONG' },
    SELL:         { icon: '🟠', label: '建議賣出',     cls: 'SELL' },
    TAKE_PROFIT:  { icon: '🟡', label: '考慮部分賣出', cls: 'TAKE_PROFIT' },
    HOLD_PROFIT:  { icon: '🟢', label: '持有等更高點', cls: 'HOLD_PROFIT' },
    WAIT_FILL:    { icon: '⬜', label: '持有等填息',   cls: 'WAIT_FILL' },
    EVALUATE:     { icon: '🔵', label: '評估是否停損', cls: 'EVALUATE' },
    HOLD:         { icon: '⬜', label: '持有中',       cls: 'HOLD' },
    UNKNOWN:      { icon: '⚪', label: '資料不足',     cls: 'UNKNOWN' },
  };
  const sm   = SIGNAL_META[fill.signal]     || SIGNAL_META.UNKNOWN;
  const ssm  = SELL_META[fill.sellSignal]   || SELL_META.UNKNOWN;

  // 填息率顏色
  const frColor = fill.fillRate >= 80 ? 'var(--accent2)' : fill.fillRate >= 50 ? 'var(--yellow)' : 'var(--red)';
  const fdColor = fill.avgFillDays <= 20 ? 'var(--accent2)' : fill.avgFillDays <= 60 ? 'var(--yellow)' : 'var(--red)';

  // 目前跌幅 vs 除息前
  let currentDropHTML = '';
  if (fill.currentPrice && fill.lastExDiv) {
    const dropPct = ((fill.lastExDiv.prePrice - fill.currentPrice) / fill.lastExDiv.prePrice * 100);
    const inZone = dropPct >= fill.avgDepthPct - fill.stdDepthPct && dropPct <= fill.avgDepthPct + fill.stdDepthPct;
    const isUp = dropPct < 0;
    const dropColor = inZone ? 'var(--accent2)' : isUp ? 'var(--accent2)' : 'var(--muted)';
    const dropLabel = isUp
      ? `漲 +${fmt(Math.abs(dropPct), 1)}%`
      : `跌 ${fmt(dropPct, 1)}%`;
    currentDropHTML = `<span class="pr-current" style="color:${dropColor}">現價 ${fmt(fill.currentPrice)} (${dropLabel})</span>`;
  }

  // 週期賣出彙總資料
  const hasMax = fill.avgCapGainPct != null;

  // 歷史紀錄表格（含期間最高賣出點）
  const rows = [...fill.history].reverse().map(h => {
    const pm = h.periodMax;
    const capColor = pm && pm.capGainPct >= 0 ? 'var(--accent2)' : 'var(--red)';
    const totColor = pm && pm.totalRetPct >= 0 ? 'var(--accent2)' : 'var(--red)';
    return `<tr>
      <td>${h.exDate}</td>
      <td>${fmt(h.divAmount)} 元</td>
      <td>${fmt(h.prePrice)}</td>
      <td>${fmt(h.troughPrice)} <small style="color:var(--muted)">(-${fmt(h.troughDepthPct, 1)}%)</small></td>
      <td style="color:var(--muted)">${h.troughDay} 天</td>
      <td class="${h.filled ? 'filled-yes' : 'filled-no'}">${h.filled ? `✔ 第${h.fillDay}天` : '✗ 未填息'}</td>
      <td>${pm ? `<strong>${fmt(pm.price)}</strong><br><small style="color:var(--muted)">${pm.date}</small>` : '—'}</td>
      <td style="color:${capColor}">${pm ? `+${fmt(pm.capGainPct, 1)}%` : '—'}</td>
      <td style="color:${totColor}">${pm ? `<strong>+${fmt(pm.totalRetPct, 1)}%</strong>` : '—'}</td>
    </tr>`;
  }).join('');

  return `
  <div class="fill-section">
    <div class="section-header" style="margin-bottom:16px">
      <h3>📐 除息回補分析</h3>
      <span style="font-size:.8rem;color:var(--muted)">分析近 ${fill.totalAnalyzed} 次配息</span>
    </div>

    <!-- 雙信號列：買入 + 賣出並排 -->
    <div class="dual-signal-row">
      <div class="signal-banner ${sm.cls}">
        <div class="signal-icon">${sm.icon}</div>
        <div class="signal-body">
          <div class="signal-tag">📥 買入時機</div>
          <div class="signal-label">${sm.label}</div>
          <div class="signal-reason">${fill.signalReason}</div>
        </div>
      </div>
      <div class="signal-banner sell-banner ${ssm.cls}">
        <div class="signal-icon">${ssm.icon}</div>
        <div class="signal-body">
          <div class="signal-tag">📤 賣出時機
            ${fill.sellGainPct != null ? `<span class="sell-gain-badge ${fill.sellGainPct >= 0 ? 'up' : 'down'}">${fill.sellGainPct >= 0 ? '+' : ''}${fmt(fill.sellGainPct, 1)}%</span>` : ''}
          </div>
          <div class="signal-label">${ssm.label}</div>
          <div class="signal-reason">${fill.sellReason || '資料不足'}</div>
        </div>
      </div>
    </div>

    <div class="fill-stats-grid">
      <div class="fill-stat">
        <div class="fs-label">填息率</div>
        <div class="fs-value" style="color:${frColor}">${fill.fillRate}%</div>
        <div class="fs-sub">${fill.filledCount}/${fill.totalAnalyzed} 次成功</div>
      </div>
      <div class="fill-stat">
        <div class="fs-label">平均填息天數</div>
        <div class="fs-value" style="color:${fdColor}">${fill.avgFillDays ?? '—'} 天</div>
        <div class="fs-sub">約 ${fill.avgFillDays ? Math.round(fill.avgFillDays / 5) : '—'} 週</div>
      </div>
      <div class="fill-stat">
        <div class="fs-label">平均最深跌幅</div>
        <div class="fs-value" style="color:var(--yellow)">${fmt(fill.avgDepthPct, 1)}%</div>
        <div class="fs-sub">±${fmt(fill.stdDepthPct, 1)}% 標準差</div>
      </div>
      <div class="fill-stat">
        <div class="fs-label">最低點通常在</div>
        <div class="fs-value" style="color:var(--accent)">第 ${fill.avgTroughDay} 天</div>
        <div class="fs-sub">除息後</div>
      </div>
      ${(() => {
        if (fill.nav != null && fill.premiumPct != null) {
          const p = fill.premiumPct;
          const pColor = p > 5 ? 'var(--red)' : p > 3 ? '#ff8c00' : p > 1.5 ? 'var(--yellow)' : p > 0 ? 'var(--muted)' : 'var(--accent2)';
          const pLabel = p > 5 ? '⛔ 溢價極高' : p > 3 ? '⚠️ 溢價偏高' : p > 1.5 ? '溢價略高' : p > 0 ? '小幅溢價' : p < -1 ? '📉 折價' : '接近淨值';
          const pSign = p >= 0 ? '+' : '';
          return `<div class="fill-stat" style="${p > 3 ? 'border:1px solid var(--red);border-radius:6px;padding:8px;' : ''}">
            <div class="fs-label">溢價／折價</div>
            <div class="fs-value" style="color:${pColor}">${pSign}${fmt(p, 2)}%</div>
            <div class="fs-sub">${pLabel}｜淨值 ${fmt(fill.nav)}</div>
          </div>`;
        }
        return `<div class="fill-stat">
          <div class="fs-label">溢價／折價</div>
          <div class="fs-value" style="color:var(--muted)">—</div>
          <div class="fs-sub">淨值資料暫無</div>
        </div>`;
      })()}
    </div>

    ${fill.buyLow != null ? `
    <div class="buy-zone-bar">
      <h4>🎯 建議買入價位區間（上次除息後）</h4>
      <div class="price-range">
        <span class="pr-label">保守</span>
        <span class="pr-val">${fmt(fill.buyHigh)}</span>
        <span class="pr-arrow">→</span>
        <span class="pr-label">甜蜜點</span>
        <span class="pr-val target">${fmt(fill.buyMid)}</span>
        <span class="pr-arrow">→</span>
        <span class="pr-label">積極</span>
        <span class="pr-val">${fmt(fill.buyLow)}</span>
        ${currentDropHTML}
      </div>
    </div>` : ''}

    <div class="timing-box">
      <div class="timing-item">
        <span class="ti-label">上次除息日</span>
        <span class="ti-value">${fill.lastExDiv?.date ?? '—'}</span>
      </div>
      <div class="timing-item">
        <span class="ti-label">距上次除息</span>
        <span class="ti-value">${fill.daysSinceLastExDiv ?? '—'} 天</span>
      </div>
      <div class="timing-item">
        <span class="ti-label">預計下次除息</span>
        <span class="ti-value" style="color:var(--accent)">${fill.nextExDivEstimate ?? '—'}</span>
      </div>
      <div class="timing-item">
        <span class="ti-label">下次預計最佳買入窗口</span>
        <span class="ti-value" style="color:var(--accent2)">${fill.buyWindowStart} ～ ${fill.buyWindowEnd}</span>
      </div>
    </div>

    ${hasMax ? (() => {
      const cg  = fill.capGainStat;
      const tr  = fill.totalRetStat;
      const dm  = fill.dayToMaxStat;
      const row = (label, stat, unit = '%', prefix = '+') => {
        if (!stat) return '';
        const pf = v => v >= 0 ? `${prefix}${fmt(v, 1)}${unit}` : `${fmt(v, 1)}${unit}`;
        return `
        <tr>
          <td class="sps-row-label">${label}</td>
          <td class="sps-max">${dm && unit==='天' ? stat.max+'天' : pf(stat.max)}</td>
          <td class="sps-avg">${dm && unit==='天' ? stat.avg+'天' : pf(stat.avg)}</td>
          <td class="sps-min">${dm && unit==='天' ? stat.min+'天' : pf(stat.min)}</td>
        </tr>`;
      };
      return `
    <div class="sell-peak-summary">
      <div class="sps-title">📈 除息週期賣出點統計（最低點買入 → 期間最高點賣出）</div>
      <div class="sps-table-wrap">
        <table class="sps-table">
          <thead>
            <tr>
              <th></th>
              <th class="sps-max">🔼 最高</th>
              <th class="sps-avg">⬛ 平均</th>
              <th class="sps-min">🔽 最低</th>
            </tr>
          </thead>
          <tbody>
            ${row('資本利得', cg, '%', '+')}
            ${row('含息總報酬', tr, '%', '+')}
            ${dm ? `<tr>
              <td class="sps-row-label">低→高 天數</td>
              <td class="sps-max">${dm.max} 天</td>
              <td class="sps-avg">${dm.avg} 天</td>
              <td class="sps-min">${dm.min} 天</td>
            </tr>` : ''}
          </tbody>
        </table>
      </div>
      <div class="sps-note">💡 策略：除息後第 <strong>${fill.avgTroughDay}</strong> 天左右逢低買入，持有約 <strong>${dm?.avg ?? '—'}</strong> 天至期間高點賣出，歷史平均可獲 <strong style="color:var(--accent2)">+${fmt(fill.avgTotalRetPct, 1)}%</strong> 含息報酬（最高可達 <strong style="color:var(--accent2)">+${fmt(fill.totalRetStat?.max, 1)}%</strong>）</div>
    </div>`;
    })() : ''}

    <div class="section-header" style="margin-bottom:10px">
      <h3 style="font-size:.9rem">歷史除息紀錄 + 週期賣出點</h3>
    </div>
    <div class="fill-history-table">
      <table>
        <thead>
          <tr>
            <th>除息日</th><th>配息</th><th>除息前價</th>
            <th>最低點</th><th>最低點日</th><th>填息結果</th>
            <th>期間最高</th><th>資本利得</th><th>含息報酬</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ── Chart section HTML ───────────────────────────────────────
function buildChartHTML() {
  return `
  <div class="charts-section">
    <div class="section-header">
      <h3>📊 技術線圖</h3>
      <div class="tab-group">
        <button class="k-tab k-tab--active" data-interval="1d">日K</button>
        <button class="k-tab" data-interval="1wk">週K</button>
        <button class="k-tab" data-interval="1mo">月K</button>
      </div>
    </div>
    <!-- MA 圖例 -->
    <div class="ma-legend">
      <span class="ma-dot" style="background:#fbbf24"></span><span>MA5</span>
      <span class="ma-dot" style="background:#4f7cff"></span><span>MA20</span>
      <span class="ma-dot" style="background:#ff4d6d"></span><span>MA60</span>
    </div>
    <div id="k-chart-wrap" class="k-chart-wrap">
      <div id="k-chart" class="k-chart-main"></div>
      <div id="k-vol"   class="k-chart-vol"></div>
    </div>
    <div id="k-loading" class="k-chart-loading" style="display:none">載入中…</div>
  </div>`;
}

// ── Dividend section HTML ────────────────────────────────────
function buildDividendHTML(div) {
  if (!div || !div.allDividends?.length) {
    return `<div class="dividends-section"><div class="loading" style="color:var(--muted)">無配息資料</div></div>`;
  }

  const yearCards = div.yearSummary
    .sort((a, b) => b.year - a.year)
    .map(y => `
      <div class="div-year-card">
        <div class="year">${y.year} 年</div>
        <div class="count">${y.count} 次</div>
        <div class="total">合計 ${fmt(y.total)} 元</div>
        <div class="q-tag">${y.count >= 4 ? '季配息' : y.count >= 2 ? '半年配' : '年配息'}</div>
      </div>
    `).join('');

  const rows = div.allDividends
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map((d, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${d.date}</td>
        <td class="up"><strong>${fmt(d.amount)}</strong> 元</td>
        <td>${new Date(d.date).getFullYear()} Q${Math.ceil((new Date(d.date).getMonth() + 1) / 3)}</td>
      </tr>
    `).join('');

  return `
  <div class="dividends-section">
    <div class="section-header">
      <h3>💰 3年配息紀錄</h3>
      ${div.isQuarterly
        ? `<span class="quarterly-badge" style="font-size:.8rem">✔ 確認為季配息（年均${div.avgAnnualCount}次）</span>`
        : `<span style="font-size:.8rem;color:var(--muted)">非季配息（年均${div.avgAnnualCount}次）</span>`
      }
    </div>
    <div class="div-grid">${yearCards}</div>
    <div class="div-table-wrap">
      <table>
        <thead><tr><th>#</th><th>配息日期</th><th>每股配息</th><th>季度</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ── Lightweight Charts K線圖 ─────────────────────────────────
let _lwChart = null;          // 主圖 chart 實例
let _candleSeries = null;
let _volSeries = null;
let _maSeries = {};
let _currentKSymbol = null;
let _currentInterval = '1d';

// 計算均線
function calcMA(data, period) {
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((s, d) => s + d.close, 0);
    result.push({ time: data[i].date, value: Math.round(sum / period * 100) / 100 });
  }
  return result;
}

function destroyKChart() {
  if (_lwChart) { _lwChart.remove(); _lwChart = null; }
  _candleSeries = null; _volSeries = null; _maSeries = {};
}

function buildKChart(rawData) {
  destroyKChart();

  const mainEl = document.getElementById('k-chart');
  const volEl  = document.getElementById('k-vol');
  if (!mainEl || !volEl) return;

  // 過濾掉 OHLC 有 null 的資料
  const data = rawData.filter(d => d.open != null && d.high != null && d.low != null && d.close != null);
  if (!data.length) { mainEl.innerHTML = '<div style="color:var(--muted);padding:40px;text-align:center">無足夠資料</div>'; return; }

  // ── 主圖（K線 + MA）────────────────────────────────────────
  const CHART_OPTS = {
    width: mainEl.clientWidth || mainEl.offsetWidth || 600,
    height: mainEl.clientHeight || 300,
    layout: { background: { type: 'solid', color: '#1a1d27' }, textColor: '#7c85a2' },
    grid: { vertLines: { color: '#2e3250' }, horzLines: { color: '#2e3250' } },
    crosshair: { mode: 1 },
    rightPriceScale: { borderColor: '#2e3250' },
    timeScale: { borderColor: '#2e3250', timeVisible: true, secondsVisible: false },
    handleScroll: true, handleScale: true,
  };
  _lwChart = LightweightCharts.createChart(mainEl, CHART_OPTS);

  // K 線蠟燭
  _candleSeries = _lwChart.addCandlestickSeries({
    upColor: '#00d084', downColor: '#ff4d6d',
    borderUpColor: '#00d084', borderDownColor: '#ff4d6d',
    wickUpColor: '#00d084', wickDownColor: '#ff4d6d',
  });
  _candleSeries.setData(data.map(d => ({
    time: d.date, open: d.open, high: d.high, low: d.low, close: d.close,
  })));

  // MA 線
  const MA_CFG = [
    { period: 5,  color: '#fbbf24', key: 'ma5'  },
    { period: 20, color: '#4f7cff', key: 'ma20' },
    { period: 60, color: '#ff4d6d', key: 'ma60' },
  ];
  for (const { period, color, key } of MA_CFG) {
    if (data.length <= period) continue;
    const s = _lwChart.addLineSeries({
      color, lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    s.setData(calcMA(data, period));
    _maSeries[key] = s;
  }

  // ── 成交量圖（獨立 chart，共用時間軸）──────────────────────
  const _volChart = LightweightCharts.createChart(volEl, {
    ...CHART_OPTS,
    height: volEl.clientHeight || 80,
    rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0 }, borderColor: '#2e3250' },
    timeScale: { borderColor: '#2e3250', timeVisible: true },
  });

  _volSeries = _volChart.addHistogramSeries({
    color: '#4f7cff44',
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  });
  _volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
  _volSeries.setData(data
    .filter(d => d.volume != null && d.volume > 0)
    .map(d => ({
      time: d.date,
      value: d.volume,
      color: d.close >= d.open ? '#00d08444' : '#ff4d6d44',
    }))
  );

  // 同步滾動
  _lwChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (range) _volChart.timeScale().setVisibleLogicalRange(range);
  });
  _volChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (range) _lwChart.timeScale().setVisibleLogicalRange(range);
  });

  // 自動縮放
  _lwChart.timeScale().fitContent();
  _volChart.timeScale().fitContent();

  // 響應式 resize
  const ro = new ResizeObserver(() => {
    const w = mainEl.clientWidth;
    _lwChart.applyOptions({ width: w });
    _volChart.applyOptions({ width: w });
  });
  ro.observe(mainEl);
}

async function loadKChart(symbol, interval) {
  const loadEl = document.getElementById('k-loading');
  const wrapEl = document.getElementById('k-chart-wrap');
  if (loadEl) { loadEl.style.display = ''; wrapEl.style.opacity = '.3'; }
  try {
    const res = await apiFetch(`/api/stock/${symbol}/history?interval=${interval}`);
    const data = await res.json();
    buildKChart(Array.isArray(data) ? data : []);
  } catch (e) {
    const mainEl = document.getElementById('k-chart');
    if (mainEl) mainEl.innerHTML = `<div style="color:var(--red);padding:40px;text-align:center">載入失敗：${e.message}</div>`;
  } finally {
    if (loadEl) { loadEl.style.display = 'none'; wrapEl.style.opacity = '1'; }
  }
}

function setupKChartTabs(symbol) {
  _currentKSymbol = symbol;
  document.querySelectorAll('.k-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.k-tab').forEach(b => b.classList.remove('k-tab--active'));
      btn.classList.add('k-tab--active');
      _currentInterval = btn.dataset.interval;
      await loadKChart(_currentKSymbol, _currentInterval);
    });
  });
}

// 向後相容舊呼叫點（renderMainPanel 呼叫 drawPriceChart + setupChartTabs）
function drawPriceChart(data) { buildKChart(data); }
function setupChartTabs(_hist) { /* 由 setupKChartTabs 接管 */ }

// ── 排序 ────────────────────────────────────────────────────
function applySort() {
  const container = document.getElementById('watchlist');
  if (!container) return;
  const cards = [...container.querySelectorAll('.stock-card')];
  if (cards.length < 2) return;

  cards.sort((a, b) => {
    const sa = watchlistData[a.id.replace('card-', '')];
    const sb = watchlistData[b.id.replace('card-', '')];

    if (sortMode === 'exdiv') {
      const da = daysUntil(sa?.fill?.nextExDivEstimate);
      const db = daysUntil(sb?.fill?.nextExDivEstimate);
      // 未來日期排最前（小的在前），null 排最後
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      // 已過日期排到最後
      const effA = da < 0 ? 99999 + da : da;
      const effB = db < 0 ? 99999 + db : db;
      return effA - effB;
    }
    if (sortMode === 'signal') {
      const ra = SIGNAL_RANK[sa?.fill?.signal] ?? 8;
      const rb = SIGNAL_RANK[sb?.fill?.signal] ?? 8;
      return ra - rb;
    }
    if (sortMode === 'change') {
      const ca = sa?.quote?.changePercent ?? 0;
      const cb = sb?.quote?.changePercent ?? 0;
      return cb - ca;  // 漲最多排最前
    }
    // 'default' — 代號字母順
    return a.id.localeCompare(b.id);
  });

  // DOM 重排（不重建 DOM，避免閃爍）
  cards.forEach(c => container.appendChild(c));
}

function renderSortBar() {
  if (document.getElementById('sort-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'sort-bar';
  bar.className = 'sort-bar';
  const modes = [
    { key: 'exdiv',  label: '🗓 除權息日' },
    { key: 'signal', label: '📊 買進信號' },
    { key: 'change', label: '📈 漲跌幅' },
    { key: 'default',label: '🔤 代號' },
  ];
  bar.innerHTML = modes.map(m =>
    `<button class="sort-btn${sortMode === m.key ? ' sort-btn--active' : ''}" data-sort="${m.key}">${m.label}</button>`
  ).join('');
  bar.addEventListener('click', e => {
    const btn = e.target.closest('.sort-btn');
    if (!btn) return;
    sortMode = btn.dataset.sort;
    bar.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('sort-btn--active', b.dataset.sort === sortMode));
    applySort();
  });
  // 插入到 watchlist 容器之前
  const watchlistEl = document.getElementById('watchlist');
  watchlistEl?.parentNode?.insertBefore(bar, watchlistEl);
}

// ── 自動刷新 ─────────────────────────────────────────────────
async function refreshAll() {
  let list;
  try {
    const res = await apiFetch(`/api/watchlist`);
    list = await res.json();
    if (Array.isArray(list)) lsSave(list);
  } catch { return; }   // 連線失敗時靜默，沿用現有 UI
  if (!Array.isArray(list)) return;
  await Promise.all(list.map(sym => fetchAndRenderCard(sym)));
  if (activeSymbol && list.includes(activeSymbol)) {
    // 僅更新 hero 的即時價格，不重繪圖表
    const qRes = await apiFetch(`/api/stock/${activeSymbol}`);
    const q = await qRes.json();
    if (!q.error) {
      const chg = q.change ?? 0;
      const pct = q.changePercent ?? 0;
      const cls = chg >= 0 ? 'up' : 'down';
      const sign = chg >= 0 ? '+' : '';
      const priceBig = document.querySelector('.price-big');
      const priceChg = document.querySelector('.price-change');
      if (priceBig) { priceBig.className = `price-big ${cls}`; priceBig.innerHTML = `${fmt(q.price)} <small style="font-size:.9rem">${q.currency||'TWD'}</small>`; }
      if (priceChg) { priceChg.className = `price-change ${cls}`; priceChg.textContent = `${sign}${fmt(chg)} (${sign}${fmt(pct)}%)`; }
    }
  }
}

// ── 初始化（由 etf-auth.js 在登入成功後呼叫）────────────────────
// ── 手機版 Header 收合 ──────────────────────────────────────
function initHeaderCollapse() {
  const btn    = document.getElementById('header-collapse-btn');
  const header = document.getElementById('app-header');
  const icon   = document.getElementById('header-collapse-icon');
  if (!btn || !header) return;

  // 恢復上次狀態
  const isCollapsed = localStorage.getItem('etf_header_collapsed') === '1';
  if (isCollapsed) header.classList.add('collapsed');

  btn.addEventListener('click', () => {
    const collapsed = header.classList.toggle('collapsed');
    localStorage.setItem('etf_header_collapsed', collapsed ? '1' : '0');
  });
}

// ── 多清單 UI ─────────────────────────────────────────────────
async function initLists() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  // 先確認容器不重複
  if (document.getElementById('list-tabs-bar')) return;

  // 建立清單 tabs 列
  const bar = document.createElement('div');
  bar.id = 'list-tabs-bar';
  bar.className = 'list-tabs-bar';
  sidebar.insertBefore(bar, sidebar.querySelector('.sidebar-header'));

  // ── 存檔按鈕（立即把清單資料存到 GitHub）──────────────────────
  const saveRow = document.createElement('div');
  saveRow.className = 'save-row';
  sidebar.insertBefore(saveRow, sidebar.querySelector('.sidebar-header'));

  const saveBtn = document.createElement('button');
  saveBtn.id        = 'btn-cloud-save';
  saveBtn.className = 'btn-cloud-save';
  saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle">cloud_upload</span> 存檔';
  saveBtn.title     = '立即將觀察清單存至 GitHub 雲端備份';
  saveRow.appendChild(saveBtn);

  const saveStatus = document.createElement('span');
  saveStatus.className = 'save-status';
  saveRow.appendChild(saveStatus);

  let _saveTimer = null;
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle">sync</span> 儲存中…';
    saveStatus.textContent = '';
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    try {
      const r = await apiFetch('/api/sync/push', { method: 'POST' });
      const d = await r.json();
      if (d.result === 'success') {
        saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle">cloud_done</span> 已存檔';
        saveBtn.classList.add('saved');
        saveStatus.textContent = '';
      } else if (d.result === 'no_change') {
        saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle">cloud_done</span> 無變更';
        saveBtn.classList.add('saved');
      } else {
        saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle">cloud_off</span> 失敗';
        saveBtn.classList.add('save-error');
        saveStatus.textContent = d.error || '';
      }
    } catch {
      saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle">cloud_off</span> 失敗';
      saveBtn.classList.add('save-error');
    }
    _saveTimer = setTimeout(() => {
      saveBtn.disabled = false;
      saveBtn.classList.remove('saved', 'save-error');
      saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle">cloud_upload</span> 存檔';
      saveStatus.textContent = '';
    }, 4000);
  });

  async function refreshListTabs() {
    // 網路請求獨立 try：失敗就直接 return，不影響後續 DOM
    let lists;
    try {
      const res = await apiFetch('/api/watchlists');
      lists = await res.json();
      console.log('[refreshListTabs] 取得清單:', lists.map(l => `${l.name}(${l.id})`).join(', '));
    } catch (err) {
      console.warn('[refreshListTabs] GET /api/watchlists 失敗:', err?.message || err);
      return;
    }
    try {

      // ── pending lists 合併：server 未持有的新清單從 localStorage 補回 ──
      // Render 重啟後 in-memory 資料可能遺失，但 localStorage 仍有記錄
      if (_pendingLists.length) {
        const serverIds = new Set(lists.map(l => l.id));
        for (let i = _pendingLists.length - 1; i >= 0; i--) {
          const pl = _pendingLists[i];
          if (serverIds.has(pl.id)) {
            // server 已確認，從 pending 移除
            _pendingLists.splice(i, 1);
            try { localStorage.setItem('etf_pending_lists', JSON.stringify(_pendingLists)); } catch {}
          } else {
            // server 尚未持有，補入清單（顯示用）
            const lsCount = (() => { try { return JSON.parse(localStorage.getItem(`etf_wl_${pl.id}`) || '[]').length; } catch { return 0; } })();
            lists.push({ id: pl.id, name: pl.name, count: lsCount, readonly: false });
          }
        }
      }

      // 初始化時若停在共用清單，自動切到第一個個人清單（管理員也切，
      // 避免被鎖在無法改名的共用清單；想管理共用清單再手動點回去）
      if (_activeListId === SHARED_ID) {
        const firstPersonal = lists.find(l => !l.readonly);
        if (firstPersonal) {
          _activeListId = firstPersonal.id;
          localStorage.setItem('etf_active_list', _activeListId);
        }
      }
      // 確保 _activeListId 指向一個存在的清單（否則取第一個）
      // ⚠ pending lists は既に lists に補入済みなので、ここで見つからなければ本当に存在しない
      if (!lists.find(l => l.id === _activeListId)) {
        console.warn('[refreshListTabs] _activeListId not found in server list:', _activeListId, lists.map(l=>l.id));
        const firstPersonal = lists.find(l => !l.readonly) || lists[0];
        if (firstPersonal) {
          _activeListId = firstPersonal.id;
          localStorage.setItem('etf_active_list', _activeListId);
        }
      }
      // 更新唯讀狀態
      const activeList = lists.find(l => l.id === _activeListId);
      _activeListReadonly = !!(activeList?.readonly && !window._fbIsAdmin);
      _updateAddStockUI();

      // 套用本地暫存的重命名（server 尚未確認前不讓舊名稱覆蓋）
      lists.forEach(l => {
        if (_pendingRenames[l.id] !== undefined) {
          if (l.name === _pendingRenames[l.id]) {
            delete _pendingRenames[l.id];  // server 已確認新名稱，清除暫存
            try { localStorage.setItem('etf_pending_renames', JSON.stringify(_pendingRenames)); } catch {}
          } else {
            l.name = _pendingRenames[l.id];  // 用本地名稱覆蓋 server 舊名稱
          }
        }
      });

      bar.innerHTML = lists.map(l => {
        const isActive   = l.id === _activeListId;
        const isReadonly = !!l.readonly;
        const editBtns   = isReadonly
          ? `<span class="list-tab-readonly-badge" title="共用預設清單，管理員可管理">🔒</span>`
          : `<button class="list-tab-rename" data-id="${l.id}" data-name="${l.name}" title="重命名">✏️</button>
             <button class="list-tab-del" data-id="${l.id}" data-name="${l.name}" title="刪除清單">✕</button>`;
        // badge：取 max(server count, localStorage 筆數)
        // 新 Render 實例 count 可能為 0，但 localStorage 已有資料
        const _lsCount = (() => {
          try { return JSON.parse(localStorage.getItem(`etf_wl_${l.id}`) || '[]').length; } catch { return 0; }
        })();
        const _dispCount = Math.max(l.count || 0, _lsCount);
        return `
        <div class="list-tab-wrap${isActive ? ' list-tab-wrap--active' : ''}" data-id="${l.id}">
          <button class="list-tab-label" data-id="${l.id}" title="切換至「${l.name}」">
            ${l.name}<span class="list-tab-count">${_dispCount}</span>
          </button>
          ${editBtns}
        </div>`;
      }).join('') +
      `<button class="list-tab-add" id="btn-add-list" title="新增清單">＋ 新增清單</button>`;

      // ── 切換清單 ──
      bar.querySelectorAll('.list-tab-label').forEach(btn => {
        btn.addEventListener('click', async () => {
          _activeListId = btn.dataset.id;
          localStorage.setItem('etf_active_list', _activeListId);
          // 立即更新唯讀狀態（從 lists 陣列找）
          const found = lists.find(l => l.id === _activeListId);
          _activeListReadonly = !!(found?.readonly && !window._fbIsAdmin);
          _updateAddStockUI();
          bar.querySelectorAll('.list-tab-wrap').forEach(w => w.classList.toggle('list-tab-wrap--active', w.dataset.id === _activeListId));
          watchlistData = {};
          activeSymbol = null;
          const mp = document.getElementById('main-panel');
          if (mp) mp.innerHTML = '<div class="empty-state"><div class="icon">🔍</div><div>請選擇一支股票</div></div>';
          await loadWatchlist();
          applySort();
        });
      });

      // ── 重命名 ──
      bar.querySelectorAll('.list-tab-rename').forEach(btn => {
        btn.addEventListener('click', async e => {
          e.stopPropagation();
          const oldName = btn.dataset.name;
          const newName = await showInputModal(`重命名清單「${oldName}」：`, oldName);
          if (!newName || newName === oldName) return;
          try {
            const r = await apiFetch(`/api/watchlists/${btn.dataset.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newName })
            });
            if (!r.ok) {
              const d = await r.json().catch(() => ({}));
              return showToast(d.error || '重命名失敗', 'error');
            }
            // ① 記錄 pending rename（保護後續 refreshListTabs 不被 server 舊資料覆蓋）
            // 同時存進 localStorage，確保 Ctrl+F5 後仍有效
            _pendingRenames[btn.dataset.id] = newName;
            try { localStorage.setItem('etf_pending_renames', JSON.stringify(_pendingRenames)); } catch {}
            // ② 直接更新 DOM
            const wrap = bar.querySelector(`.list-tab-wrap[data-id="${btn.dataset.id}"]`);
            if (wrap) {
              const label = wrap.querySelector('.list-tab-label');
              if (label) {
                Array.from(label.childNodes).forEach(n => { if (n.nodeType === Node.TEXT_NODE) n.remove(); });
                label.insertBefore(document.createTextNode(newName), label.firstChild);
                label.title = `切換至「${newName}」`;
              }
              wrap.querySelectorAll('[data-name]').forEach(el => { el.dataset.name = newName; });
            }
            // ③ 同步更新 lists 快取（供 tab 切換時的 readonly 判斷使用）
            const cached = lists.find(l => l.id === btn.dataset.id);
            if (cached) cached.name = newName;
            showToast(`已重命名為「${newName}」`);
          } catch { showToast('重命名失敗', 'error'); }
        });
      });

      // ── 刪除 ──
      bar.querySelectorAll('.list-tab-del').forEach(btn => {
        btn.addEventListener('click', async e => {
          e.stopPropagation();
          const ok = await showConfirmModal(`確定刪除清單「${btn.dataset.name}」？\n清單內的股票也會一併移除。`);
          if (!ok) return;
          try {
            const r = await apiFetch(`/api/watchlists/${btn.dataset.id}`, { method: 'DELETE' });
            if (!r.ok) {
              if (r.status === 404) {
                // 伺服器找不到（Render 重啟後 in-memory 遺失）→ 當作已刪除，清理本地端
                console.warn('[deleteList] 404，視為已刪除，清理 localStorage:', btn.dataset.id);
              } else {
                const d = await r.json().catch(() => ({}));
                return showToast(d.error || '刪除失敗', 'error');
              }
            }
            showToast(`「${btn.dataset.name}」已刪除`);
            // pending lists 與 localStorage 資料一併清除
            const _pidx = _pendingLists.findIndex(l => l.id === btn.dataset.id);
            if (_pidx !== -1) {
              _pendingLists.splice(_pidx, 1);
              try { localStorage.setItem('etf_pending_lists', JSON.stringify(_pendingLists)); } catch {}
            }
            // 清除該清單的股票快取
            try { localStorage.removeItem(`etf_wl_${btn.dataset.id}`); } catch {}
            try { localStorage.removeItem(`etf_del_${btn.dataset.id}`); } catch {}
            if (_activeListId === btn.dataset.id) {
              const remaining = lists.filter(l => l.id !== btn.dataset.id);
              _activeListId = remaining[0]?.id || 'default';
              localStorage.setItem('etf_active_list', _activeListId);
            }
            await refreshListTabs();
            await loadWatchlist();
          } catch { showToast('刪除失敗', 'error'); }
        });
      });

    } catch (e) { console.error('[refreshListTabs DOM error]', e); }
  }

  // ── 新增清單（事件委任：bar 本身永久存在，innerHTML 換掉也不影響）──
  // async function refreshListTabs() 是函式宣告，已 hoist，此處可安全呼叫
  bar.addEventListener('click', async e => {
    if (!e.target.closest('#btn-add-list')) return;
    const name = await showInputModal('新清單名稱：');
    if (!name) { showToast('未輸入名稱，已取消', 'error'); return; }
    showToast(`「${name}」建立中…`);
    try {
      const res2 = await apiFetch('/api/watchlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res2.ok) {
        const d = await res2.json().catch(() => ({}));
        return showToast(d.error || `建立失敗（HTTP ${res2.status}）`, 'error');
      }
      const newList = await res2.json();
      if (newList.error) return showToast(newList.error, 'error');
      if (!newList.id) return showToast('伺服器未回傳清單 ID，請重試', 'error');
      console.log('[newList] POST 成功, id=', newList.id, 'name=', newList.name);
      _activeListId = newList.id;
      localStorage.setItem('etf_active_list', _activeListId);

      // ── pending lists に追加（server 重啟後の備援）──────────────
      if (!_pendingLists.find(l => l.id === newList.id)) {
        _pendingLists.push({ id: newList.id, name: newList.name });
        try { localStorage.setItem('etf_pending_lists', JSON.stringify(_pendingLists)); } catch {}
      }

      // ── 樂觀更新：立即插入新標籤到 DOM ─────────────────────────
      // 避免 refreshListTabs() GET 失敗時標籤不出現
      bar.querySelectorAll('.list-tab-wrap').forEach(w => w.classList.remove('list-tab-wrap--active'));
      const _optWrap = document.createElement('div');
      _optWrap.className = 'list-tab-wrap list-tab-wrap--active';
      _optWrap.dataset.id = newList.id;
      _optWrap.innerHTML = `
        <button class="list-tab-label" data-id="${newList.id}" title="切換至「${newList.name}」">
          ${newList.name}<span class="list-tab-count">0</span>
        </button>
        <button class="list-tab-rename" data-id="${newList.id}" data-name="${newList.name}" title="重命名">✏️</button>
        <button class="list-tab-del" data-id="${newList.id}" data-name="${newList.name}" title="刪除清單">✕</button>
      `;
      const _optAddBtn = bar.querySelector('#btn-add-list');
      if (_optAddBtn) bar.insertBefore(_optWrap, _optAddBtn);
      else bar.appendChild(_optWrap);
      // ────────────────────────────────────────────────────────────

      // 同步伺服器狀態（失敗也不影響，標籤已顯示）
      await refreshListTabs();
      await loadWatchlist();
      showToast(`清單「${name}」已建立 ✓`);
    } catch (err) {
      if (err.message !== 'Unauthorized')
        showToast('建立失敗：' + (err.message || '請稍後再試'), 'error');
    }
  });

  _refreshListTabs = refreshListTabs;  // 暴露給外部（addStock 等）使用
  await refreshListTabs();
}

// ── 搜尋 UI ────────────────────────────────────────────────────
function initSearch() {
  const headerEl = document.querySelector('.sidebar-header');
  if (!headerEl || document.getElementById('search-wrap')) return;

  const origInput = document.getElementById('search-input');
  if (!origInput) return;

  // 在現有 input 加自動完成下拉
  const wrap = document.createElement('div');
  wrap.id = 'search-wrap';
  wrap.className = 'search-wrap';
  origInput.parentNode.insertBefore(wrap, origInput);
  wrap.appendChild(origInput);

  const dropdown = document.createElement('div');
  dropdown.id = 'search-dropdown';
  dropdown.className = 'search-dropdown';
  dropdown.style.display = 'none';
  wrap.appendChild(dropdown);

  let searchTimer;
  origInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = origInput.value.trim();
    if (!q) { dropdown.style.display = 'none'; return; }
    searchTimer = setTimeout(async () => {
      try {
        const res  = await apiFetch(`/api/stocks/search?q=${encodeURIComponent(q)}`);
        const list = await res.json();
        if (!list.length) { dropdown.style.display = 'none'; return; }
        dropdown.innerHTML = list.map(s =>
          `<div class="sd-item" data-ticker="${s.ticker}" data-name="${s.name}">
            <span class="sd-code">${s.code}</span>
            <span class="sd-name">${s.name}</span>
          </div>`
        ).join('');
        dropdown.style.display = '';
        dropdown.querySelectorAll('.sd-item').forEach(item => {
          item.addEventListener('click', () => {
            origInput.value = item.dataset.ticker.replace('.TW', '');
            dropdown.style.display = 'none';
            addStock();
          });
        });
      } catch {}
    }, 300);
  });

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) dropdown.style.display = 'none';
  });
}

window.ETFApp = {
  async start() {
    // ── 使用者切換偵測：不同帳號登入時清除前一位使用者的 localStorage ──
    const _prevUser = localStorage.getItem('etf_current_user');
    const _currUser = window._fbEmail || '';
    if (_prevUser && _currUser && _prevUser !== _currUser) {
      console.log('[ETFApp] 使用者切換:', _prevUser, '→', _currUser, '，清除 localStorage 與記憶體快取');
      // localStorage 全部清除
      Object.keys(localStorage)
        .filter(k => k.startsWith('etf_'))
        .forEach(k => localStorage.removeItem(k));
      // 記憶體上的 module-level 變數也一併歸零
      // （app.js 讀取時就已從 localStorage 載入，localStorage 清除後仍留在記憶體）
      _pendingLists.splice(0);
      Object.keys(_pendingRenames).forEach(k => delete _pendingRenames[k]);
      _activeListId = 'default';
    }
    if (_currUser) localStorage.setItem('etf_current_user', _currUser);

    initHeaderCollapse();
    await initLists();
    initSearch();
    renderSortBar();
    await loadWatchlist();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshAll, 30000);
  },
  stop() {
    clearInterval(refreshTimer);
    refreshTimer = null;
    mobileShowList();   // 返回清單頁
    const wl = document.getElementById('watchlist');
    if (wl) wl.innerHTML = '<div class="loading" style="padding:20px;text-align:center">載入中…</div>';
    const mp = document.getElementById('main-panel');
    if (mp) mp.innerHTML = '<div class="empty-state" id="empty-state"><div class="icon">🔍</div><div>請在左側輸入股票代碼加入觀察清單</div></div>';
    activeSymbol = null;
    watchlistData = {};
  }
};
