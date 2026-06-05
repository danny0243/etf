/**
 * 掃描台灣所有 ETF，找出年均配息 3 次以上者，並加入 watchlist.json
 * 執行：node scripts/scan-quarterly-etfs.js
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCHLIST_FILE = join(__dirname, '..', 'watchlist.json');

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// ── 從 TWSE isin 服務取得所有上市 ETF 代碼 ──────────────────
async function fetchTWSEEtfList() {
  console.log('📡 從 TWSE 取得 ETF 清單...');
  try {
    const res = await fetch(
      'https://isin.twse.com.tw/isin/C_public.jsp?strMode=4',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }
    );
    const html = await res.text();
    // 解析 HTML 表格，找出代碼欄位
    const matches = [...html.matchAll(/([0-9A-Z]{4,6})\s+<\/td>\s*<td[^>]*>([^<]+ETF[^<]*)</gi)];
    const etfs = matches.map(m => m[1].trim()).filter(code => /^\d{4,6}$/.test(code));
    return [...new Set(etfs)];
  } catch (e) {
    console.warn('  TWSE isin 取得失敗，使用備用清單');
    return [];
  }
}

// ── 從 TWSE ETF 查詢頁取得 ETF 清單 ─────────────────────────
async function fetchTWSEEtfList2() {
  console.log('📡 從 TWSE ETF 查詢頁取得清單...');
  try {
    const res = await fetch(
      'https://www.twse.com.tw/ETF/list',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' }, signal: AbortSignal.timeout(15000) }
    );
    const text = await res.text();
    const matches = [...text.matchAll(/"([0-9]{4,6})"/g)];
    return [...new Set(matches.map(m => m[1]))].filter(c => /^\d{4,6}$/.test(c));
  } catch {
    return [];
  }
}

// ── 已知的台灣高股息/季配息 ETF 完整備用清單 ─────────────────
const KNOWN_DIVIDEND_ETFS = [
  // 高股息系列
  '0056','00713','00878','00900','00907','00915','00916','00918',
  '00919','00920','00921','00922','00923','00924','00925','00927',
  '00929','00930','00931','00932','00934','00935','00936','00939',
  '00940','00943','00944','00945','00947','00949','00950',
  // 廣基市值型（部分有季配）
  '0050','0051','0052','0053','0055','006208',
  '00646','00692','00636','00733','00850','00858',
  // 科技/主題型
  '00881','00882','00895','00896','00898','00902','00905',
  '00906','00908','00909','00910','00911','00912','00913','00914',
  '00916','00917','00926','00928','00933','00937','00938',
  '00941','00942','00946','00948','00951',
  // 上櫃ETF (TPEx)
  '006201','006203','006204','006205','006206',
];

// ── 查詢單一 ETF 的配息頻率 ──────────────────────────────────
async function checkDividend(stockNo) {
  const ticker = `${stockNo}.TW`;
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1mo&range=3y&events=div`;
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const shortName = meta?.shortName || meta?.longName || ticker;
    const divEvents = result.events?.dividends || {};
    const allDivs = Object.values(divEvents);

    if (!allDivs.length) return { stockNo, ticker, shortName, avgCount: 0, isQuarterly: false };

    // 按年分組
    const byYear = {};
    allDivs.forEach(d => {
      const yr = new Date(d.date * 1000).getFullYear();
      byYear[yr] = (byYear[yr] || 0) + 1;
    });

    const now = new Date().getFullYear();
    const recent = [now - 1, now - 2].map(y => byYear[y] || 0);
    const avgCount = recent.reduce((a, b) => a + b, 0) / recent.filter((_, i) => i < 2).length;

    return {
      stockNo,
      ticker,
      shortName,
      avgCount: Math.round(avgCount * 10) / 10,
      isQuarterly: avgCount >= 3,
      yearData: byYear,
    };
  } catch {
    return null;
  }
}

// ── 分批執行（避免 rate limit）────────────────────────────────
async function batchCheck(list, batchSize = 5, delayMs = 1200) {
  const results = [];
  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(checkDividend));
    results.push(...batchResults.filter(Boolean));
    const done = Math.min(i + batchSize, list.length);
    process.stdout.write(`\r  進度：${done}/${list.length} (已找到 ${results.filter(r => r.isQuarterly).length} 支季配息 ETF)`);
    if (i + batchSize < list.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.log('');
  return results;
}

// ── 主程式 ───────────────────────────────────────────────────
async function main() {
  console.log('🚀 開始掃描台灣季配息 ETF...\n');

  // 合併 TWSE 動態清單 + 已知清單
  const [twseList1, twseList2] = await Promise.all([
    fetchTWSEEtfList(),
    fetchTWSEEtfList2(),
  ]);

  const allCodes = [...new Set([
    ...twseList1,
    ...twseList2,
    ...KNOWN_DIVIDEND_ETFS,
  ])].filter(c => /^\d{4,6}$/.test(c)).sort();

  console.log(`\n📋 共取得 ${allCodes.length} 支 ETF 代碼，開始查詢配息紀錄...\n`);

  const results = await batchCheck(allCodes, 5, 1000);

  const quarterly = results
    .filter(r => r.isQuarterly)
    .sort((a, b) => b.avgCount - a.avgCount);

  const notQuarterly = results.filter(r => !r.isQuarterly && r.avgCount > 0);
  const noDivData = results.filter(r => r.avgCount === 0);

  console.log('\n══════════════════════════════════════════════');
  console.log(`✅ 季配息 ETF（年均≥3次）：共 ${quarterly.length} 支`);
  console.log('══════════════════════════════════════════════');
  quarterly.forEach(r => {
    const yearStr = Object.entries(r.yearData)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 3)
      .map(([y, c]) => `${y}:${c}次`)
      .join(', ');
    console.log(`  ${r.stockNo.padEnd(8)} ${r.shortName.slice(0, 25).padEnd(26)} 年均${r.avgCount}次  (${yearStr})`);
  });

  console.log(`\n⚠️  非季配息（年均<3次）：${notQuarterly.length} 支`);
  console.log(`❌ 無配息資料：${noDivData.length} 支`);

  // 讀取現有 watchlist
  let watchlist = [];
  if (existsSync(WATCHLIST_FILE)) {
    try { watchlist = JSON.parse(readFileSync(WATCHLIST_FILE, 'utf8')); }
    catch { watchlist = []; }
  }

  // 加入新的季配息 ETF
  let added = 0;
  for (const r of quarterly) {
    if (!watchlist.includes(r.ticker)) {
      watchlist.push(r.ticker);
      added++;
    }
  }

  writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2));

  console.log(`\n💾 已更新 watchlist.json`);
  console.log(`   新增 ${added} 支，現有清單共 ${watchlist.length} 支`);
  console.log('\n✨ 完成！請重新整理瀏覽器頁面查看結果。\n');
}

main().catch(console.error);
