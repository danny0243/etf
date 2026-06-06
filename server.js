import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { exec } from 'child_process';
import { promisify } from 'util';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const execAsync = promisify(exec);

// web-push（CJS 套件，用 createRequire 引入）
const _require = createRequire(import.meta.url);
const webpush   = _require('web-push');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Firebase Admin（優先讀環境變數，本機開發才讀本地檔案）──────
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf-8')
  );
} else {
  serviceAccount = JSON.parse(
    readFileSync(join(__dirname, '../config/serviceAccountKey.json'), 'utf-8')
  );
}
initializeApp({ credential: cert(serviceAccount) });
const firebaseAuth = getAuth();

// ── ETF 管理員設定（獨立於主系統，放在 ETF/config/ 底下）────────
const ETF_CONFIG_PATH = join(__dirname, 'config', 'etf_admin_config.json');
mkdirSync(join(__dirname, 'config'), { recursive: true });

let etfConfig = { isPublic: false, allowedDomains: [], admins: ['mr.yu.shiang@gmail.com'], allowedUsers: [] };
try {
  etfConfig = JSON.parse(readFileSync(ETF_CONFIG_PATH, 'utf-8'));
} catch {
  writeFileSync(ETF_CONFIG_PATH, JSON.stringify(etfConfig, null, 2), 'utf-8');
}

// ── 自動 git push（設定變更後同步回 GitHub）────────────────────
let _gitPushTimer      = null;
let _renderDeployTimer = null; // 保留宣告避免舊版程式碼 clearTimeout 時報錯

// 同步狀態記錄（供管理員面板查詢）
const _syncStatus = {
  lastPushAt:      null,   // Date ISO string
  lastPushResult:  null,   // 'success' | 'failed' | 'no_change'
  lastPushMessage: null,   // commit message
  lastPushError:   null,   // error message if failed
  lastDeployAt:    null,
  lastDeployResult: null,  // 'success' | 'failed' | 'skipped'
  startupPullAt:   null,
  startupPullResult: null, // 'success' | 'failed' | 'skipped'
};

function scheduleGitPush(message) {
  if (!process.env.GITHUB_TOKEN) return;
  clearTimeout(_gitPushTimer);
  // 1 秒防抖，push 完成後才觸發 Render 重新部署（避免時序競爭）
  _gitPushTimer = setTimeout(() => gitPush(message), 1_000);
}

async function triggerRenderDeploy() {
  if (!process.env.RENDER_DEPLOY_HOOK_URL) return;
  try {
    await fetch(process.env.RENDER_DEPLOY_HOOK_URL, { method: 'POST' });
    _syncStatus.lastDeployAt     = new Date().toISOString();
    _syncStatus.lastDeployResult = 'success';
    console.log('[Render] 已觸發重新部署');
  } catch (e) {
    _syncStatus.lastDeployAt     = new Date().toISOString();
    _syncStatus.lastDeployResult = 'failed';
    console.warn('[Render] 觸發部署失敗:', e.message);
  }
}

async function gitPush(message) {
  try {
    const token  = process.env.GITHUB_TOKEN;
    const remote = `https://x-access-token:${token}@github.com/danny0243/etf.git`;

    // ① 先把最新資料讀進記憶體（後續 git 操作可能覆蓋檔案）
    const configContent    = readFileSync(ETF_CONFIG_PATH, 'utf-8');
    const watchlistContent = readFileSync(LISTS_FILE,      'utf-8');

    await execAsync('git config user.email "etf-server@auto.push"', { cwd: __dirname });
    await execAsync('git config user.name "ETF Auto Push"',         { cwd: __dirname });

    // ② fetch + hard reset：讓本機 git 與 GitHub 完全同步，消除所有衝突風險
    await execAsync(`git fetch ${remote} main`, { cwd: __dirname });
    await execAsync('git reset --hard FETCH_HEAD',            { cwd: __dirname });

    // ③ 把剛才讀進來的資料寫回（覆蓋掉 GitHub 舊版本）
    writeFileSync(ETF_CONFIG_PATH, configContent,    'utf-8');
    writeFileSync(LISTS_FILE,      watchlistContent, 'utf-8');

    // ④ 確認是否真的有變更
    await execAsync('git add config/etf_admin_config.json watchlist.json', { cwd: __dirname });
    const { stdout } = await execAsync('git diff --cached --name-only', { cwd: __dirname });
    if (!stdout.trim()) {
      _syncStatus.lastPushAt      = new Date().toISOString();
      _syncStatus.lastPushResult  = 'no_change';
      _syncStatus.lastPushMessage = message;
      _syncStatus.lastPushError   = null;
      return;
    }

    // ⑤ commit & push（HEAD:main 在 detached HEAD 狀態也能用）
    await execAsync(`git commit -m "${message} [skip ci]"`, { cwd: __dirname });
    await execAsync(`git push ${remote} HEAD:main`,          { cwd: __dirname });
    _syncStatus.lastPushAt      = new Date().toISOString();
    _syncStatus.lastPushResult  = 'success';
    _syncStatus.lastPushMessage = message;
    _syncStatus.lastPushError   = null;
    console.log('[Git] 自動推送成功：', message);
    // ✅ push 成功後才觸發 Render 重新部署
    await triggerRenderDeploy();
  } catch (e) {
    _syncStatus.lastPushAt      = new Date().toISOString();
    _syncStatus.lastPushResult  = 'failed';
    _syncStatus.lastPushError   = e.stderr || e.message;
    console.warn('[Git] 自動推送失敗:', e.stderr || e.message);
  }
}

function saveEtfConfig() {
  writeFileSync(ETF_CONFIG_PATH, JSON.stringify(etfConfig, null, 2), 'utf-8');
  scheduleGitPush('update: etf admin config');
}

// ── Web Push VAPID 金鑰 ──────────────────────────────────────
const VAPID_PATH = join(__dirname, 'config', 'vapid.json');
const SUBS_PATH  = join(__dirname, 'config', 'push_subs.json');

let vapidKeys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else {
  try {
    vapidKeys = JSON.parse(readFileSync(VAPID_PATH, 'utf-8'));
  } catch {
    vapidKeys = webpush.generateVAPIDKeys();
    writeFileSync(VAPID_PATH, JSON.stringify(vapidKeys, null, 2), 'utf-8');
    console.log('[PWA] 已生成 VAPID 金鑰，請將以下金鑰存入環境變數：');
    console.log('VAPID_PUBLIC_KEY=' + vapidKeys.publicKey);
    console.log('VAPID_PRIVATE_KEY=' + vapidKeys.privateKey);
  }
}
webpush.setVapidDetails(
  'mailto:mr.yu.shiang@gmail.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// 訂閱清單 CRUD
function loadSubs() {
  try { return JSON.parse(readFileSync(SUBS_PATH, 'utf-8')); } catch { return []; }
}
function saveSubs(subs) {
  writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2), 'utf-8');
}

// 發送推播給所有訂閱者（自動清除失效訂閱）
async function sendPushToAll(payload) {
  const subs = loadSubs();
  const dead = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
      else console.warn('[PWA Push] 發送失敗:', e.message);
    }
  }
  if (dead.length) {
    saveSubs(loadSubs().filter(s => !dead.includes(s.endpoint)));
    console.log(`[PWA Push] 已移除 ${dead.length} 個失效訂閱`);
  }
}

// ── 存取驗證（與主系統邏輯一致）────────────────────────────────
async function verifyAccess(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const idToken = authHeader.split('Bearer ')[1];
    const decoded = await firebaseAuth.verifyIdToken(idToken);
    const email   = decoded.email || '';
    const uid     = decoded.uid   || '';
    const isAdmin = etfConfig.admins.includes(email);
    if (isAdmin) return { allowed: true, isAdmin: true, uid, email };
    if (etfConfig.isPublic) return { allowed: true, isAdmin: false, uid, email };
    if (etfConfig.allowedUsers.includes(email)) return { allowed: true, isAdmin: false, uid, email };
    const domain = email.split('@')[1];
    if (domain && etfConfig.allowedDomains.includes(domain)) return { allowed: true, isAdmin: false, uid, email };
    throw new Error(`帳號 ${email} 無 ETF 系統存取權限`);
  }
  if (etfConfig.isPublic) return { allowed: true, isAdmin: false, uid: null, email: null };
  throw new Error('請先登入');
}

// ── Express 認證中介層 ──────────────────────────────────────────
async function requireAuth(req, res, next) {
  // 允許排程器的內部呼叫（localhost）
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    req.access = { allowed: true, isAdmin: false, uid: null, email: null };
    return next();
  }
  try {
    req.access = await verifyAccess(req);
    next();
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const WATCHLIST_FILE = join(__dirname, 'watchlist.json');

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : [];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── 存取權限確認（登入後第一步呼叫）─────────────────────────────
// 200 = 有權限  /  401 = 無權限（前端應登出並顯示錯誤）
app.get('/api/auth/check', async (req, res) => {
  try {
    const access = await verifyAccess(req);
    res.json({ allowed: true, isAdmin: access.isAdmin, email: access.email });
  } catch (e) {
    res.status(401).json({ allowed: false, error: e.message });
  }
});

// ── 管理員設定 API ─────────────────────────────────────────────
app.get('/api/admin/config', async (req, res) => {
  try {
    const access = await verifyAccess(req);
    if (!access.isAdmin) return res.status(403).json({ error: '權限不足：限管理員操作' });
    res.json(etfConfig);
  } catch (e) { res.status(401).json({ error: e.message }); }
});

app.post('/api/admin/config', async (req, res) => {
  try {
    const access = await verifyAccess(req);
    if (!access.isAdmin) return res.status(403).json({ error: '權限不足：限管理員操作' });
    etfConfig = { ...etfConfig, ...req.body };
    saveEtfConfig();
    res.json({ success: true, config: etfConfig });
  } catch (e) { res.status(401).json({ error: e.message }); }
});

// ── 同步狀態查詢（管理員用）────────────────────────────────────
app.get('/api/sync/status', async (req, res) => {
  try {
    const access = await verifyAccess(req);
    if (!access.isAdmin) return res.status(403).json({ error: '限管理員' });
    res.json({
      githubToken:      !!process.env.GITHUB_TOKEN,
      renderDeployHook: !!process.env.RENDER_DEPLOY_HOOK_URL,
      ..._syncStatus,
    });
  } catch (e) { res.status(401).json({ error: e.message }); }
});

// ── Push 通知 API ─────────────────────────────────────────────
// 取得 VAPID 公鑰（訂閱時需要）
app.get('/api/push/vapid-public-key', requireAuth, (_req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// 儲存訂閱
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub  = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: '無效的訂閱資料' });
  const subs = loadSubs();
  if (!subs.some(s => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    saveSubs(subs);
    console.log('[PWA] 新增推播訂閱，目前共', subs.length, '筆');
  }
  res.json({ success: true, count: subs.length });
});

// 取消訂閱
app.delete('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: '缺少 endpoint' });
  const before = loadSubs();
  saveSubs(before.filter(s => s.endpoint !== endpoint));
  res.json({ success: true });
});

// 手動觸發測試通知（管理員用）
app.post('/api/push/test', requireAuth, async (req, res) => {
  try {
    const access = await verifyAccess(req).catch(() => null);
    if (!access?.isAdmin) return res.status(403).json({ error: '限管理員' });
    await sendPushToAll({
      title: '🔔 ETF 推播測試',
      body: '推播通知功能運作正常！明天有除息時會自動提醒。',
      url: '/',
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Yahoo Finance headers to avoid 403
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

// TWSE 即時報價 headers
const TWSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Referer': 'https://www.twse.com.tw/',
};

function toTicker(symbol) {
  const s = symbol.toUpperCase().replace('.TW', '');
  return `${s}.TW`;
}
function toStockNo(symbol) {
  return symbol.toUpperCase().replace('.TW', '');
}

// ── TTL 快取（大幅提升 YF API 重複查詢速度）────────────────────
const _cache = new Map();
function getCached(key, ttlMs) {
  const c = _cache.get(key);
  return c && Date.now() - c.ts < ttlMs ? c.v : null;
}
function setCached(key, v) {
  _cache.set(key, { v, ts: Date.now() });
  if (_cache.size > 800) {                     // 防記憶體洩漏
    const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    _cache.delete(oldest[0]);
  }
}
async function withCache(key, ttlMs, fn) {
  const v = getCached(key, ttlMs);
  if (v !== null) return v;
  const result = await fn();
  setCached(key, result);
  return result;
}

// ── 台灣股票中文名稱對照表（常用 ETF + 個股）─────────────────
const TW_NAMES = {
  '0050':'元大台灣50','0051':'元大中型100','0052':'富邦科技',
  '0053':'元大電子','0054':'元大台商50','0055':'元大MSCI金融',
  '0056':'元大高股息','0057':'富邦摩台','0058':'富邦發達',
  '0061':'元大寶滬深','006208':'富邦台50',
  '00631L':'元大台灣50正2','00632R':'元大台灣50反1',
  '00636':'國泰中國A150','00639':'富邦深100',
  '00646':'元大S&P500','00647L':'元大S&P500正2',
  '00648U':'元大S&P黃金','00649':'國泰標普低波動',
  '00655':'國泰臺灣低波動30','00659':'元大美債20年',
  '00660':'元大歐洲50','00661':'元大日本','00662':'富邦NASDAQ',
  '00670L':'富邦NASDAQ正2','00671L':'元大S&P500正2',
  '00676':'兆豐藍籌30','00677U':'富邦油正2',
  '00678':'群益投資級公司債','00679B':'元大美債20年',
  '00681B':'元大投資級公司債','00685L':'群益台灣精選高息',
  '00686B':'國泰投資級公司債','00687B':'元大AAA至A公司債',
  '00688B':'國泰20年美債','00689':'富邦越南',
  '00692':'富邦公司債','00700':'富邦全球洗潔',
  '00701':'國泰主要市場','00703':'台新MSCI多因子台灣',
  '00705':'國泰台灣ESG永續高股息','00706':'元大MSCI全球',
  '00712':'復華富時台灣高息低波','00713':'元大台灣高息低波',
  '00716':'復華S&P500高息低波','00717':'富邦台灣中小型',
  '00727':'第一金工業30','00730':'富邦臺灣優質高息',
  '00733':'富邦台灣中小A級動能50',
  '00762':'元大全球AI','00770':'國泰美國短期公債',
  '00773':'中信美國不動產','00779':'元大MSCI台灣ESG永續',
  '00782':'富邦臺灣半導體','00783':'富邦特選高股息30',
  '00786':'凱基優選高股息30','00858':'野村台灣首選',
  '00865B':'國泰20年美債月配','00870':'統一高息動能',
  '00878':'國泰永續高股息','00881':'國泰台灣5G+',
  '00882':'中信中國高股息','00883':'國泰台灣ESG低碳高息',
  '00884':'永豐台灣ESG低碳','00885':'富邦全球優質高息',
  '00888':'永豐ESG低碳高息',
  '00891':'中信關鍵半導體','00892':'富邦台灣半導體Top10',
  '00893':'國泰智能電動車','00894':'中信小資高價30',
  '00895':'富邦未來車','00900':'富邦特選高股息',
  '00901':'永豐優息存股','00903':'野村全球低波高息',
  '00906':'凱基台灣精選非金電','00907':'永豐台灣ESG優質高息',
  '00910':'第一金太空衛星科技','00911':'台新北美科技巨擘',
  '00913':'兆豐台灣晶圓','00915':'凱基優選泛亞高股息',
  '00916':'國泰全球品牌50','00918':'大華優利高填息30',
  '00919':'群益台灣精選高息','00920':'富邦全球電動車',
  '00921':'兆豐美國高息股','00922':'國泰台灣受益信託',
  '00926':'台新主流','00927':'台新2000',
  '00929':'復華台灣科技優息','00930':'永豐ESG永續',
  '00932':'兆豐永續高息','00933':'國泰台灣領袖50',
  '00934':'中信成長高股息','00935':'野村台灣高息動能',
  '00936':'台新台灣特色',
  '00938':'永豐台灣科技高息','00939':'統一台灣高息動能',
  '00940':'元大台灣價值高息','00941':'台新核心台灣',
  '00942':'凱基優質台灣ESG永續','00943':'野村高息成長',
  '00946':'永豐台灣ESG低波高息','00947':'元大台灣高息ESG',
  // 個股
  '2330':'台積電','2317':'鴻海','2454':'聯發科',
  '2412':'中華電','2882':'國泰金','2881':'富邦金',
  '2886':'兆豐金','2891':'中信金','2884':'玉山金',
  '2885':'元大金','2892':'第一金','5880':'合庫金',
  '2883':'開發金','1301':'台塑','1303':'南亞',
  '2002':'中鋼','2308':'台達電','2382':'廣達',
  '3008':'大立光','3045':'台灣大','4904':'遠傳',
  '2357':'華碩','2379':'瑞昱','2395':'研華',
  '2345':'智邦','2327':'國巨','3034':'聯詠',
  '4938':'和碩','3711':'日月光投控','2382':'廣達',
  '2303':'聯電','6505':'台塑化',
};

function getCnName(stockNo) {
  return TW_NAMES[stockNo] || null;
}

// ── 多清單 Watchlist 系統（每位使用者獨立）───────────────────────
const LISTS_FILE = join(__dirname, 'watchlist.json');

// 讀取原始檔案（含舊格式自動遷移）
function _loadRawData() {
  try {
    const raw = JSON.parse(readFileSync(LISTS_FILE, 'utf8'));
    // 新格式：{ byUser: { email: { lists: [...] } } }
    if (raw?.byUser) return raw;
    // 舊格式：{ lists: [...] } → 遷移至管理員帳號
    if (Array.isArray(raw?.lists)) {
      const adminEmail = etfConfig.admins?.[0] || 'mr.yu.shiang@gmail.com';
      return { byUser: { [adminEmail]: { lists: raw.lists } } };
    }
    // 更舊格式：flat array
    if (Array.isArray(raw)) {
      const adminEmail = etfConfig.admins?.[0] || 'mr.yu.shiang@gmail.com';
      return { byUser: { [adminEmail]: { lists: [{ id: 'default', name: '自選股', stocks: raw }] } } };
    }
  } catch {}
  return { byUser: {} };
}

// 讀取指定使用者的清單
function loadUserLists(email) {
  if (!email) return [{ id: 'default', name: '自選股', stocks: [] }];
  const data = _loadRawData();
  const userLists = data.byUser?.[email]?.lists;
  if (Array.isArray(userLists) && userLists.length) return userLists;
  return [{ id: 'default', name: '自選股', stocks: [] }];
}

// 儲存指定使用者的清單
function saveUserLists(email, lists) {
  if (!email) return;
  const data = _loadRawData();
  if (!data.byUser) data.byUser = {};
  data.byUser[email] = { lists };
  writeFileSync(LISTS_FILE, JSON.stringify(data, null, 2));
  scheduleGitPush('update: watchlist');
}

// 取得指定使用者的某一個清單
function getUserList(email, id = 'default') {
  const all = loadUserLists(email);
  return all.find(l => l.id === id) || all[0] || { id: 'default', name: '自選股', stocks: [] };
}

// 取全部使用者股票聯集（推播排程用，不區分帳號）
function loadAllStocksForAlerts() {
  try {
    const data = _loadRawData();
    const all  = new Set();
    for (const userData of Object.values(data.byUser || {})) {
      for (const list of (userData.lists || [])) {
        for (const s of (list.stocks || [])) all.add(s);
      }
    }
    return [...all];
  } catch { return []; }
}

// ── 數字解析輔助：'-' 或空值視為 null ──────────────────────────
function safeNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── 即時報價：TWSE mis API ───────────────────────────────────
async function fetchTWSEQuote(stockNo) {
  for (const ex of ['tse', 'otc']) {
    try {
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.asp?ex_ch=${ex}_${stockNo}.tw&json=1&delay=0`;
      const res = await fetch(url, { headers: TWSE_HEADERS, signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      if (!data.msgArray?.length) continue;
      const m = data.msgArray[0];

      // m.z = 成交價（開盤前或無成交時為 '-'），m.y = 昨收
      const price     = safeNum(m.z) ?? safeNum(m.y);
      const prevClose = safeNum(m.y);
      if (!price) continue;   // 完全無有效價格，換交易所試

      return {
        price,
        prevClose: prevClose ?? price,
        change:        prevClose ? price - prevClose : 0,
        changePercent: prevClose ? (price - prevClose) / prevClose * 100 : 0,
        volume: parseInt(m.v || '0') * 1000,
        high:  safeNum(m.h) ?? price,
        low:   safeNum(m.l) ?? price,
        open:  safeNum(m.o) ?? price,
        name:  m.n || stockNo,
        ex,
      };
    } catch { /* try next */ }
  }
  return null;
}

// ── Yahoo Finance Chart API（帶 TTL 快取）────────────────────
async function fetchYFChart(ticker, interval = '1wk', range = '3y') {
  const key  = `yf:${ticker}:${interval}:${range}`;
  // 快取 TTL：quote=30s, 日K=2分, 週/月K=15分, 配息/分析=20分
  const ttl  = { '1d': 120_000, '1wk': 900_000, '1mo': 900_000 }[interval] ?? 300_000;
  return withCache(key, ttl, async () => {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}&events=div`;
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`YF Chart HTTP ${res.status}`);
    return res.json();
  });
}

// ── 清單管理 API ───────────────────────────────────────────────
app.get('/api/watchlists', requireAuth, (req, res) => {
  const email = req.access.email;
  res.json(loadUserLists(email).map(({ id, name, stocks }) => ({ id, name, count: stocks.length })));
});

app.post('/api/watchlists', requireAuth, (req, res) => {
  const email = req.access.email;
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: '缺少清單名稱' });
  const lists = loadUserLists(email);
  const id    = Date.now().toString(36);
  lists.push({ id, name: name.trim(), stocks: [] });
  saveUserLists(email, lists);
  res.json({ id, name: name.trim(), count: 0 });
});

app.put('/api/watchlists/:id', requireAuth, (req, res) => {
  const email = req.access.email;
  const { name } = req.body || {};
  const lists = loadUserLists(email);
  const idx   = lists.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '清單不存在' });
  if (name?.trim()) lists[idx].name = name.trim();
  saveUserLists(email, lists);
  res.json({ success: true });
});

app.delete('/api/watchlists/:id', requireAuth, (req, res) => {
  const email = req.access.email;
  const lists = loadUserLists(email);
  const filtered = lists.filter(l => l.id !== req.params.id);
  if (filtered.length === lists.length) return res.status(404).json({ error: '清單不存在' });
  if (filtered.length === 0) return res.status(400).json({ error: '至少保留一個清單' });
  saveUserLists(email, filtered);
  res.json({ success: true });
});

// ── 股票搜尋 ───────────────────────────────────────────────────
app.get('/api/stocks/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim().toUpperCase().replace('.TW', '');
  if (!q) return res.json([]);

  // 1. 先從靜態表比對（代號 + 名稱）
  const results = [];
  for (const [code, name] of Object.entries(TW_NAMES)) {
    if (code.startsWith(q) || name.includes(q) || q.includes(name)) {
      results.push({ code, name, ticker: code + '.TW' });
    }
    if (results.length >= 8) break;
  }

  // 2. 若靜態表無命中，嘗試 Yahoo Finance search
  if (!results.length) {
    try {
      const yfUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q+'.TW')}&lang=zh-TW&region=TW&quotesCount=5`;
      const r = await withCache(`search:${q}`, 300_000, async () => {
        const resp = await fetch(yfUrl, { headers: YF_HEADERS, signal: AbortSignal.timeout(8000) });
        return resp.ok ? resp.json() : null;
      });
      if (r?.quotes) {
        for (const s of r.quotes) {
          if (!s.symbol?.endsWith('.TW')) continue;
          const code = s.symbol.replace('.TW', '');
          const name = TW_NAMES[code] || s.shortname || s.longname || code;
          results.push({ code, name, ticker: s.symbol });
        }
      }
    } catch {}
  }

  res.json(results);
});

// ── 取得股票基本資訊 ─────────────────────────────────────────
app.get('/api/stock/:symbol', requireAuth, async (req, res) => {
  const stockNo = toStockNo(req.params.symbol);
  const ticker = toTicker(req.params.symbol);

  try {
    // 同時抓取即時報價和YF基本資訊
    const [twseQ, yfRes] = await Promise.allSettled([
      fetchTWSEQuote(stockNo),
      fetchYFChart(ticker, '1d', '5d'),
    ]);

    const twse = twseQ.status === 'fulfilled' ? twseQ.value : null;

    // 從 YF chart meta 取得即時價 + 基本資訊
    let yfMeta = {};
    if (yfRes.status === 'fulfilled') {
      const chart = yfRes.value?.chart?.result?.[0];
      if (chart) {
        const m = chart.meta || {};
        yfMeta = {
          shortName:        m.longName || m.shortName || '',
          currency:         m.currency || 'TWD',
          fiftyTwoWeekHigh: m.fiftyTwoWeekHigh,
          fiftyTwoWeekLow:  m.fiftyTwoWeekLow,
          trailingPE:       m.trailingPE,
          dividendYield:    m.dividendYield,
          marketCap:        m.marketCap,
          marketState:      m.marketState || 'CLOSED',
          // ── 即時價格（TWSE 失敗時使用）──────────────────────────
          regularMarketPrice: safeNum(m.regularMarketPrice),
          chartPreviousClose: safeNum(m.chartPreviousClose) || safeNum(m.previousClose),
        };
      }
    }

    if (!twse && !yfMeta.shortName) {
      return res.status(404).json({ error: `找不到股票代碼：${stockNo}` });
    }

    // TWSE 優先；TWSE 失敗時以 Yahoo Finance regularMarketPrice 補位
    const price      = twse?.price      ?? yfMeta.regularMarketPrice ?? 0;
    const prevClose  = twse?.prevClose  ?? yfMeta.chartPreviousClose ?? 0;
    const change     = twse?.change     ?? (price && prevClose ? +(price - prevClose).toFixed(2) : 0);
    const changePercent = twse?.changePercent ?? (prevClose ? +((price - prevClose) / prevClose * 100).toFixed(2) : 0);

    if (!price) console.warn(`[Quote] ${ticker} 價格為 0，TWSE=${JSON.stringify(twse)}, YF=${yfMeta.regularMarketPrice}`);

    res.json({
      symbol: ticker,
      shortName: getCnName(stockNo) || twse?.name || yfMeta.shortName || ticker,
      price,
      change,
      changePercent,
      volume: twse?.volume || 0,
      high: twse?.high,
      low: twse?.low,
      open: twse?.open,
      prevClose,
      marketCap: yfMeta.marketCap,
      fiftyTwoWeekHigh: yfMeta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: yfMeta.fiftyTwoWeekLow,
      trailingPE: yfMeta.trailingPE,
      dividendYield: yfMeta.dividendYield != null ? yfMeta.dividendYield * 100 : null,
      currency: yfMeta.currency || 'TWD',
      marketState: yfMeta.marketState || (twse ? 'REGULAR' : 'CLOSED'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 股價歷史（支援 ?interval=1d|1wk|1mo）────────────────────
app.get('/api/stock/:symbol/history', requireAuth, async (req, res) => {
  const ticker = toTicker(req.params.symbol);
  const VALID_INTERVALS = { '1d': '3mo', '1wk': '2y', '1mo': '5y' };
  const interval = VALID_INTERVALS[req.query.interval] ? req.query.interval : '1wk';
  const range    = VALID_INTERVALS[interval];
  try {
    const data = await fetchYFChart(ticker, interval, range);
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: '無歷史資料' });

    const timestamps = result.timestamp || [];
    const quotes = result.indicators?.quote?.[0] || {};
    const history = timestamps.map((ts, i) => ({
      date: new Date(ts * 1000).toISOString().split('T')[0],
      open: quotes.open?.[i],
      high: quotes.high?.[i],
      low: quotes.low?.[i],
      close: quotes.close?.[i],
      volume: quotes.volume?.[i],
    })).filter(d => d.close != null);

    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 配息歷史 ─────────────────────────────────────────────────
app.get('/api/stock/:symbol/dividends', requireAuth, async (req, res) => {
  const ticker = toTicker(req.params.symbol);
  try {
    const data = await fetchYFChart(ticker, '1mo', '3y');
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: '無資料' });

    const divEvents = result.events?.dividends || {};
    const allDividends = Object.values(divEvents).map(d => ({
      date: new Date(d.date * 1000).toISOString().split('T')[0],
      amount: d.amount,
    })).sort((a, b) => new Date(a.date) - new Date(b.date));

    // 按年分組
    const byYear = {};
    allDividends.forEach(d => {
      const year = new Date(d.date).getFullYear();
      if (!byYear[year]) byYear[year] = [];
      byYear[year].push(d);
    });

    const yearSummary = Object.entries(byYear).map(([year, divs]) => ({
      year: parseInt(year),
      count: divs.length,
      total: divs.reduce((s, d) => s + d.amount, 0),
      dividends: divs,
    }));

    const recentYears = yearSummary.filter(y => y.year >= new Date().getFullYear() - 2);
    const avgCount = recentYears.length > 0
      ? recentYears.reduce((s, y) => s + y.count, 0) / recentYears.length
      : 0;
    const isQuarterly = avgCount >= 3;

    res.json({
      ticker,
      isQuarterly,
      avgAnnualCount: Math.round(avgCount * 10) / 10,
      yearSummary,
      allDividends,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 除息回補分析 ─────────────────────────────────────────────
app.get('/api/stock/:symbol/fill-analysis', requireAuth, async (req, res) => {
  const ticker = toTicker(req.params.symbol);
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=3y&events=div`;
    const resp = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`YF HTTP ${resp.status}`);
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: '無資料' });

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const divEvents = result.events?.dividends || {};

    // 建立日期→收盤價對應表
    const priceMap = {};
    timestamps.forEach((ts, i) => {
      if (closes[i] != null) priceMap[new Date(ts * 1000).toISOString().split('T')[0]] = closes[i];
    });
    const sortedDates = Object.keys(priceMap).sort();

    const divList = Object.values(divEvents).sort((a, b) => a.date - b.date);
    if (divList.length < 2) return res.json({ ticker, hasData: false, message: '配息紀錄不足' });

    // 分析每次除息後的價格行為（最多取最近12次）
    const analyses = [];
    for (const div of divList.slice(-12)) {
      const exDate = new Date(div.date * 1000).toISOString().split('T')[0];
      const preDate = sortedDates.filter(d => d < exDate).slice(-1)[0];
      if (!preDate || !priceMap[preDate]) continue;
      const prePrice = priceMap[preDate];

      const postDates = sortedDates.filter(d => d >= exDate).slice(0, 90);
      if (postDates.length < 3) continue;

      // 尋找最低點（前45個交易日）
      const troughWindow = postDates.slice(0, 45);
      let troughPrice = Infinity, troughDay = 0, troughDate = '';
      troughWindow.forEach((d, i) => {
        if (priceMap[d] < troughPrice) {
          troughPrice = priceMap[d]; troughDay = i + 1; troughDate = d;
        }
      });
      if (troughPrice === Infinity) continue;

      // 尋找填息日（價格回到除息前）
      let fillDay = null, fillDate = null;
      for (let i = 0; i < postDates.length; i++) {
        if (priceMap[postDates[i]] >= prePrice) { fillDay = i + 1; fillDate = postDates[i]; break; }
      }

      analyses.push({
        exDate,
        divAmount: Math.round(div.amount * 1000) / 1000,
        prePrice: Math.round(prePrice * 100) / 100,
        troughPrice: Math.round(troughPrice * 100) / 100,
        troughDay,
        troughDate,
        troughDepthPct: Math.round((prePrice - troughPrice) / prePrice * 10000) / 100,
        divPct: Math.round(div.amount / prePrice * 10000) / 100,
        filled: fillDay !== null,
        fillDay,
        fillDate,
      });
    }

    if (analyses.length < 2) return res.json({ ticker, hasData: false, message: '可分析配息次數不足' });

    // ── 計算每個除息週期的最高賣出點 ────────────────────────────
    // 週期定義：本次除息日 → 下次除息日（最後一筆用至今）
    const todayDateStr = new Date().toISOString().split('T')[0];
    for (let i = 0; i < analyses.length; i++) {
      const periodStart = analyses[i].exDate;
      const periodEnd   = i < analyses.length - 1 ? analyses[i + 1].exDate : todayDateStr;

      const periodDates = sortedDates.filter(d => d >= periodStart && d < periodEnd);
      if (!periodDates.length) { analyses[i].periodMax = null; continue; }

      let maxPrice = -Infinity, maxDate = '';
      for (const d of periodDates) {
        if ((priceMap[d] ?? -Infinity) > maxPrice) {
          maxPrice = priceMap[d]; maxDate = d;
        }
      }

      if (maxPrice === -Infinity) { analyses[i].periodMax = null; continue; }

      const trough   = analyses[i].troughPrice;
      const divAmt   = analyses[i].divAmount;
      // 資本利得：從最低點買、期間最高點賣
      const capGainPct   = trough > 0 ? (maxPrice - trough) / trough * 100 : 0;
      // 含息總報酬：(最高賣出 - 最低買入 + 股息) / 最低買入
      const totalRetPct  = trough > 0 ? (maxPrice - trough + divAmt) / trough * 100 : 0;
      // 相對上次除息前高：最高點 vs 除息前價
      const vsPrePct     = analyses[i].prePrice > 0 ? (maxPrice - analyses[i].prePrice) / analyses[i].prePrice * 100 : 0;

      analyses[i].periodMax = {
        price:        Math.round(maxPrice * 100) / 100,
        date:         maxDate,
        dayFromTrough: maxDate && analyses[i].troughDate
          ? Math.round((new Date(maxDate) - new Date(analyses[i].troughDate)) / 86400000)
          : null,
        capGainPct:   Math.round(capGainPct * 100) / 100,
        totalRetPct:  Math.round(totalRetPct * 100) / 100,
        vsPrePct:     Math.round(vsPrePct * 100) / 100,
      };
    }

    // 彙總統計
    const filled = analyses.filter(a => a.filled);
    const fillRate = Math.round(filled.length / analyses.length * 100);
    const avgFillDays = filled.length > 0 ? Math.round(filled.reduce((s, a) => s + a.fillDay, 0) / filled.length) : null;
    const depths = analyses.map(a => a.troughDepthPct);
    const avgDepth = depths.reduce((s, v) => s + v, 0) / depths.length;
    const stdDepth = Math.sqrt(depths.reduce((s, v) => s + (v - avgDepth) ** 2, 0) / depths.length);
    const avgTroughDay = Math.round(analyses.reduce((s, a) => s + a.troughDay, 0) / analyses.length);

    // 最後一次除息後的現況
    const last = analyses[analyses.length - 1];
    const todayDate = new Date().toISOString().split('T')[0];
    const latestPrice = [...sortedDates].reverse().find(d => d <= todayDate);
    const currentPrice = latestPrice ? priceMap[latestPrice] : null;

    // divList 最新實際除息日（Taiwan UTC+8 修正）
    const rawLastDiv     = divList.at(-1);
    const rawLastDivDate = (() => {
      const corrected = new Date(rawLastDiv.date * 1000 + 8 * 3600 * 1000);
      return corrected.toISOString().split('T')[0];
    })();
    const actualLastExDate = rawLastDivDate > last.exDate ? rawLastDivDate : last.exDate;
    const daysSince = Math.round((new Date(todayDate) - new Date(actualLastExDate)) / 86400000);

    // 計算建議買入區間
    const buyLow  = last ? Math.round(last.prePrice * (1 - (avgDepth + stdDepth) / 100) * 100) / 100 : null;
    const buyMid  = last ? Math.round(last.prePrice * (1 - avgDepth / 100) * 100) / 100 : null;
    const buyHigh = last ? Math.round(last.prePrice * (1 - Math.max(0, avgDepth - stdDepth) / 100) * 100) / 100 : null;

    // ── 估算下次除息日（修正版）────────────────────────────────
    // 問題1：舊版只用最後兩次間隔，容易因偶發異常偏移 → 改用全部歷史平均
    // 問題2：analyses 會過濾掉最近未完成週期的除息日 → 改以 divList 最新實際日期為基準

    // 計算所有相鄰除息間隔的平均（排除異常值：< 7天 或 > 400天）
    const allIntervalMs = analyses.slice(1).map((a, i) =>
      new Date(a.exDate).getTime() - new Date(analyses[i].exDate).getTime()
    ).filter(ms => ms >= 7 * 86400000 && ms <= 400 * 86400000);

    const avgIntervalMs = allIntervalMs.length > 0
      ? Math.round(allIntervalMs.reduce((s, v) => s + v, 0) / allIntervalMs.length)
      : 90 * 86400000;

    // 基準：取兩者的較新者
    const baseExMs = Math.max(
      new Date(rawLastDivDate).getTime(),
      new Date(last.exDate).getTime()
    );

    const nextExEstDate  = new Date(baseExMs + avgIntervalMs).toISOString().split('T')[0];
    const buyWindowStart = new Date(baseExMs + avgIntervalMs + (avgTroughDay - 3) * 86400000).toISOString().split('T')[0];
    const buyWindowEnd   = new Date(baseExMs + avgIntervalMs + (avgTroughDay + 5) * 86400000).toISOString().split('T')[0];

    // 決策邏輯
    let signal = 'UNKNOWN', signalReason = '';
    if (fillRate < 40) {
      signal = 'AVOID';
      signalReason = `填息率僅 ${fillRate}%，長期貼息風險高`;
    } else if (currentPrice != null && last) {
      const currentDropPct = (last.prePrice - currentPrice) / last.prePrice * 100;
      const inBuyZone = currentDropPct >= avgDepth - stdDepth && currentDropPct <= avgDepth + stdDepth;
      const overBought = currentDropPct < 0; // 已超過除息前價格
      const tooDeep = currentDropPct > avgDepth + stdDepth * 1.5;

      if (overBought) {
        signal = 'WAIT_NEXT'; signalReason = `股價已高於上次除息前，等下次除息後再進場`;
      } else if (inBuyZone) {
        signal = 'BUY'; signalReason = `跌幅 ${currentDropPct.toFixed(1)}% 落在歷史甜蜜點 ${(avgDepth - stdDepth).toFixed(1)}%～${(avgDepth + stdDepth).toFixed(1)}%`;
      } else if (tooDeep) {
        signal = 'BUY_STRONG'; signalReason = `跌幅已超過歷史最大區間，超跌反彈機率高`;
      } else if (daysSince > (avgFillDays || 60) * 1.2) {
        signal = 'HOLD'; signalReason = `已過最佳買入窗口（平均 ${avgFillDays} 天），持倉等填息`;
      } else {
        signal = 'WAIT'; signalReason = `尚未到達甜蜜點，預計還有 ${(avgDepth - stdDepth - currentDropPct).toFixed(1)}% 空間`;
      }
    }

    // ── 賣出信號（假設在最低點附近買入）─────────────────────────
    // 先計算 capGainStat 需要的 completedPeriods 以取得目標獲利
    const _completed4Sell = analyses.slice(0, -1).filter(a => a.periodMax);
    const _capGains4Sell  = _completed4Sell.map(a => a.periodMax.capGainPct);
    const _avgCapGain4Sell = _capGains4Sell.length
      ? _capGains4Sell.reduce((s, v) => s + v, 0) / _capGains4Sell.length
      : null;

    let sellSignal = 'UNKNOWN', sellReason = '', sellGainPct = null;

    if (currentPrice != null && last?.troughPrice > 0) {
      const buyPrice   = last.troughPrice;                       // 假設買在最低點
      const fillTarget = last.prePrice;                          // 填息目標（除息前價）
      sellGainPct = Math.round((currentPrice - buyPrice) / buyPrice * 10000) / 100;
      const targetGain = _avgCapGain4Sell ?? (fillTarget - buyPrice) / buyPrice * 100;
      const daysToNextEx = nextExEstDate
        ? Math.round((new Date(nextExEstDate) - new Date(todayDate)) / 86400000)
        : null;

      if (sellGainPct >= targetGain * 0.85) {
        // 獲利已達歷史均值 85% 以上 → 強力賣出
        sellSignal = 'SELL_STRONG';
        sellReason = `獲利 +${sellGainPct.toFixed(1)}% 已達歷史平均峰值（${targetGain.toFixed(1)}%）的 ${Math.round(sellGainPct / targetGain * 100)}%，建議獲利了結`;
      } else if (currentPrice >= fillTarget && daysToNextEx !== null && daysToNextEx <= 20) {
        // 已填息 + 距下次除息 ≤ 20 天
        sellSignal = 'SELL';
        sellReason = `已填息且距下次除息僅 ${daysToNextEx} 天，建議趁高賣出、等下次再買`;
      } else if (sellGainPct >= targetGain * 0.6) {
        // 獲利達均值 60%
        sellSignal = 'SELL';
        sellReason = `獲利 +${sellGainPct.toFixed(1)}% 已達目標的 ${Math.round(sellGainPct / targetGain * 100)}%，可考慮賣出`;
      } else if (currentPrice >= fillTarget && sellGainPct >= targetGain * 0.3) {
        // 已填息，獲利在 30-60% 目標之間
        sellSignal = 'TAKE_PROFIT';
        sellReason = `已填息，獲利 +${sellGainPct.toFixed(1)}%，可考慮部分獲利了結，留倉等更高點`;
      } else if (currentPrice >= fillTarget) {
        // 已填息但獲利偏低
        sellSignal = 'HOLD_PROFIT';
        sellReason = `已填息（獲利 +${sellGainPct.toFixed(1)}%），尚未到歷史高點，繼續持有`;
      } else if (sellGainPct > 0) {
        // 未填息但有正收益
        sellSignal = 'WAIT_FILL';
        sellReason = `持有中，浮盈 +${sellGainPct.toFixed(1)}%，等待填息（目標 +${((fillTarget - buyPrice) / buyPrice * 100).toFixed(1)}%）`;
      } else if (daysSince > (avgFillDays || 60) * 1.5) {
        // 超過填息時間 1.5 倍仍虧損
        sellSignal = 'EVALUATE';
        sellReason = `持有超過填息均值 1.5 倍（${daysSince}天），目前浮虧 ${sellGainPct.toFixed(1)}%，建議評估是否停損`;
      } else {
        sellSignal = 'HOLD';
        sellReason = `持有等待填息，目前距填息目標 ${((fillTarget - currentPrice) / currentPrice * 100).toFixed(1)}%`;
      }
    }

    // 週期最高點彙總（過濾掉最後一筆未完成的週期）
    const completedPeriods = _completed4Sell;  // 複用上面已計算的
    const r2 = v => Math.round(v * 100) / 100;

    function periodStat(arr) {
      if (!arr.length) return null;
      const min = r2(Math.min(...arr));
      const max = r2(Math.max(...arr));
      const avg = r2(arr.reduce((s, v) => s + v, 0) / arr.length);
      return { min, avg, max };
    }

    const capGains   = completedPeriods.map(a => a.periodMax.capGainPct);
    const totalRets  = completedPeriods.map(a => a.periodMax.totalRetPct);
    const daysToMaxA = completedPeriods.filter(a => a.periodMax.dayFromTrough != null).map(a => a.periodMax.dayFromTrough);

    const capGainStat  = periodStat(capGains);
    const totalRetStat = periodStat(totalRets);
    const dayToMaxStat = daysToMaxA.length ? {
      min: Math.min(...daysToMaxA), avg: Math.round(daysToMaxA.reduce((s,v)=>s+v,0)/daysToMaxA.length), max: Math.max(...daysToMaxA)
    } : null;

    // 向後相容欄位
    const avgCapGainPct  = capGainStat?.avg ?? null;
    const avgTotalRetPct = totalRetStat?.avg ?? null;
    const avgDayToMax    = dayToMaxStat?.avg ?? null;

    res.json({
      ticker, hasData: true,
      fillRate, avgFillDays, avgDepthPct: Math.round(avgDepth * 100) / 100,
      stdDepthPct: Math.round(stdDepth * 100) / 100,
      avgTroughDay, totalAnalyzed: analyses.length, filledCount: filled.length,
      buyLow, buyMid, buyHigh,
      currentPrice: currentPrice ? Math.round(currentPrice * 100) / 100 : null,
      daysSinceLastExDiv: daysSince,
      lastExDiv: last ? {
        date:      actualLastExDate,          // 實際最新除息日（修正版）
        prePrice:  last.prePrice,
        divAmount: rawLastDiv.amount,
      } : null,
      nextExDivEstimate: nextExEstDate,
      buyWindowStart, buyWindowEnd,
      signal, signalReason,
      sellSignal, sellReason, sellGainPct,  // 賣出信號（假設在最低點附近買入）
      // 週期賣出點彙總（含最高/平均/最低）
      avgCapGainPct, avgTotalRetPct, avgDayToMax,
      capGainStat, totalRetStat, dayToMaxStat,
      history: analyses,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 觀察清單 CRUD（需登入）────────────────────────────────────
// 取得指定清單（支援 ?list=id，預設取第一個）
app.get('/api/watchlist', requireAuth, (req, res) => {
  const email = req.access.email;
  const l = getUserList(email, req.query.list);
  res.json({ listId: l.id, listName: l.name, stocks: l.stocks });
});

app.post('/api/watchlist', requireAuth, (req, res) => {
  const email  = req.access.email;
  const { symbol } = req.body;
  const listId = req.query.list || req.body.listId;
  if (!symbol) return res.status(400).json({ error: '缺少股票代碼' });
  const ticker = toTicker(symbol);
  const lists  = loadUserLists(email);
  const target = lists.find(l => l.id === listId) || lists[0];
  if (!target) return res.status(404).json({ error: '清單不存在' });
  if (!target.stocks.includes(ticker)) target.stocks.push(ticker);
  saveUserLists(email, lists);
  res.json({ success: true, watchlist: target.stocks });
});

app.delete('/api/watchlist/:symbol', requireAuth, (req, res) => {
  const email  = req.access.email;
  const ticker = toTicker(req.params.symbol);
  const listId = req.query.list;
  const lists  = loadUserLists(email);
  const target = lists.find(l => l.id === listId) || lists[0];
  if (!target) return res.status(404).json({ error: '清單不存在' });
  target.stocks = target.stocks.filter(s => toTicker(s) !== ticker);
  saveUserLists(email, lists);
  res.json({ success: true, watchlist: target.stocks });
});

// ── 每日除息提醒排程 ─────────────────────────────────────────
// 每分鐘檢查，台灣時間早上 8:00 執行
// 計算距今 N 天後的日期字串（YYYY-MM-DD）
function dateAfterDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// 各提醒天數的文字設定
const ALERT_DAYS = [
  { days: 1, label: '明日',  emoji: '🔴', urgency: '⚠️ 明天就除息，請確認買入計畫！' },
  { days: 3, label: '3天後', emoji: '🟡', urgency: '📌 距除息日還有3天，建議確認持股或買點。' },
  { days: 5, label: '5天後', emoji: '🟢', urgency: '📋 距除息日5天，可以開始規劃買入窗口。' },
];

async function runExDivAlerts() {
  const watchlist = loadAllStocksForAlerts();
  if (!watchlist.length) return;

  // 預先計算 1、3、5 天後的日期
  const targetDates = ALERT_DAYS.map(a => ({ ...a, dateStr: dateAfterDays(a.days) }));

  // 每支股票只需抓一次配息資料，對三個目標日期都比對
  const stockData = [];
  for (const ticker of watchlist) {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=3y&events=div`;
      const resp = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(15000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;

      const divEvents = Object.values(result.events?.dividends || {})
        .map(d => ({ date: new Date(d.date * 1000).toISOString().split('T')[0], amount: d.amount }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      if (divEvents.length < 2) continue;

      // 估算下次除息日
      const intervals = divEvents.slice(1).map((d, i) =>
        new Date(d.date) - new Date(divEvents[i].date)
      );
      const avgMs  = intervals.reduce((s, v) => s + v, 0) / intervals.length;
      const estNext = new Date(new Date(divEvents.at(-1).date).getTime() + avgMs)
        .toISOString().split('T')[0];

      stockData.push({ ticker, estNext, lastAmount: divEvents.at(-1).amount });
    } catch (e) {
      console.warn(`[ExDiv Scheduler] ${ticker} 取得失敗:`, e.message);
    }
  }

  if (!stockData.length) return;

  // 對每個提醒天數各別發送推播
  for (const { days, label, emoji, urgency, dateStr } of targetDates) {
    const hits = stockData.filter(s => s.estNext === dateStr);
    if (!hits.length) continue;

    const title = `${emoji} 除息提醒（${label} / ${hits.length} 支）`;
    const body  = [
      urgency,
      ...hits.map(h => `• ${h.ticker.replace('.TW', '')}  上次配息 ${h.lastAmount.toFixed(2)} 元，預計 ${dateStr} 除息`),
    ].join('\n');

    console.log(`[ExDiv Scheduler] 發送 ${days}天前提醒：`, hits.map(h => h.ticker));
    await sendPushToAll({ title, body, url: '/', tag: `etf-exdiv-${days}d-${dateStr}` });
  }
}

// ── 訊號推播（收盤後掃描買入／賣出訊號）────────────────────────
async function runSignalAlerts() {
  const watchlist = loadAllStocksForAlerts();
  if (!watchlist.length) return;

  const buyHits  = [];
  const sellHits = [];

  for (const ticker of watchlist) {
    try {
      const res  = await fetch(`http://localhost:${PORT}/api/stock/${ticker}/fill-analysis`);
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.hasData) continue;

      const code  = ticker.replace('.TW', '');
      const price = data.currentPrice != null ? ` ${data.currentPrice}元` : '';

      if (data.signal === 'BUY' || data.signal === 'BUY_STRONG') {
        const label = data.signal === 'BUY_STRONG' ? '強烈建議買入 🔥' : '可買進 🟢';
        buyHits.push(`• ${code}${price}　${label}\n  ${data.signalReason || ''}`);
      }

      if (data.sellSignal === 'TAKE_PROFIT') {
        sellHits.push(`• ${code}${price}　考慮部分賣出 🟡\n  ${data.sellReason || ''}`);
      } else if (data.sellSignal === 'EVALUATE') {
        sellHits.push(`• ${code}${price}　評估是否停損 🔵\n  ${data.sellReason || ''}`);
      }
    } catch (e) {
      console.warn(`[Signal Alert] ${ticker} 失敗:`, e.message);
    }
  }

  if (buyHits.length) {
    const today = new Date().toISOString().split('T')[0];
    await sendPushToAll({
      title: `🟢 買入訊號提醒（${buyHits.length} 支）`,
      body:  buyHits.join('\n'),
      url:   '/',
      tag:   `etf-buy-${today}`,
    });
    console.log(`[Signal Alert] 買入訊號推播：${buyHits.length} 支`);
  }

  if (sellHits.length) {
    const today = new Date().toISOString().split('T')[0];
    await sendPushToAll({
      title: `⚠️ 賣出／停損訊號提醒（${sellHits.length} 支）`,
      body:  sellHits.join('\n'),
      url:   '/',
      tag:   `etf-sell-${today}`,
    });
    console.log(`[Signal Alert] 賣出訊號推播：${sellHits.length} 支`);
  }
}

setInterval(() => {
  const now    = new Date();
  const twHour = (now.getUTCHours() + 8) % 24;
  const twMin  = now.getUTCMinutes();

  // 台灣時間 08:00 除息提醒
  if (twHour === 8 && twMin === 0) {
    runExDivAlerts().catch(e => console.error('[ExDiv Scheduler]', e.message));
  }
  // 台灣時間 14:30 訊號提醒（收盤後一小時）
  if (twHour === 14 && twMin === 30) {
    runSignalAlerts().catch(e => console.error('[Signal Scheduler]', e.message));
  }
}, 60_000);

// ── 啟動時從 GitHub 拉取最新資料，再開始監聽 ─────────────────────
async function gitPullOnStartup() {
  if (!process.env.GITHUB_TOKEN) {
    _syncStatus.startupPullAt     = new Date().toISOString();
    _syncStatus.startupPullResult = 'skipped';
    return;
  }
  try {
    const token  = process.env.GITHUB_TOKEN;
    const remote = `https://x-access-token:${token}@github.com/danny0243/etf.git`;
    await execAsync(`git pull ${remote} main`, { cwd: __dirname });
    _syncStatus.startupPullAt     = new Date().toISOString();
    _syncStatus.startupPullResult = 'success';
    console.log('[Git] 啟動時已從 GitHub 拉取最新資料');
  } catch (e) {
    _syncStatus.startupPullAt     = new Date().toISOString();
    _syncStatus.startupPullResult = 'failed';
    console.warn('[Git] 啟動時拉取失敗（使用現有資料）:', e.stderr || e.message);
  }
  // 重新載入設定檔（確保使用最新版本）
  try {
    etfConfig = JSON.parse(readFileSync(ETF_CONFIG_PATH, 'utf-8'));
    console.log('[Git] 已重新載入 etf admin config');
  } catch {}
}

gitPullOnStartup().finally(() => {
  app.listen(PORT, () => {
    console.log(`伺服器已啟動：http://localhost:${PORT}`);
  });
});
