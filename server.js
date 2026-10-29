// Stock Scanner — zero-dependency Node server.
// Fetches daily candles from Yahoo Finance, computes indicators, serves the UI.
// Run: node server.js  →  http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CACHE_MS = 5 * 60 * 1000;
const CONCURRENCY = 8;

const UNIVERSES = {
  nifty50: [
    'RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'BHARTIARTL', 'ITC', 'SBIN', 'LT', 'HINDUNILVR',
    'KOTAKBANK', 'AXISBANK', 'BAJFINANCE', 'MARUTI', 'ASIANPAINT', 'HCLTECH', 'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'WIPRO',
    'NTPC', 'POWERGRID', 'ONGC', 'M&M', 'TATASTEEL', 'JSWSTEEL', 'ADANIENT', 'ADANIPORTS', 'COALINDIA', 'BAJAJFINSV',
    'NESTLEIND', 'TECHM', 'GRASIM', 'HINDALCO', 'DRREDDY', 'CIPLA', 'BRITANNIA', 'EICHERMOT', 'HEROMOTOCO', 'APOLLOHOSP',
    'TATACONSUM', 'SBILIFE', 'HDFCLIFE', 'BAJAJ-AUTO', 'SHRIRAMFIN', 'TRENT', 'BEL', 'INDUSINDBK', 'ETERNAL', 'JIOFIN',
  ].map((s) => s + '.NS'),
  us: [
    'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'V',
    'MA', 'UNH', 'XOM', 'LLY', 'JNJ', 'WMT', 'PG', 'HD', 'COST', 'NFLX',
    'AMD', 'CRM', 'ORCL', 'ADBE', 'PEP', 'KO', 'BAC', 'INTC', 'CSCO', 'QCOM',
    'DIS', 'NKE', 'PFE', 'MRK', 'ABBV', 'CVX', 'T', 'VZ', 'PLTR', 'UBER',
  ],
};

const cache = new Map(); // symbol -> { at, data }

async function fetchCandles(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const r = json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.timestamp) throw new Error('no data');

  const q = r.indicators.quote[0];
  const candles = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null) continue;
    candles.push({
      t: r.timestamp[i] * 1000,
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0,
    });
  }
  const data = { meta: { name: r.meta.longName || r.meta.shortName || symbol, currency: r.meta.currency }, candles };
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

// ---------- indicators ----------
const sma = (arr, n) => (arr.length < n ? null : arr.slice(-n).reduce((a, b) => a + b, 0) / n);

function smaSeries(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function emaSeries(arr, n) {
  const k = 2 / (n + 1);
  const out = [];
  arr.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

function rsi(closes, n = 14) {
  if (closes.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

const pct = (a, b) => (a == null || b == null || b === 0 ? null : ((a - b) / b) * 100);

function analyze(symbol, { meta, candles }) {
  const closes = candles.map((c) => c.c);
  const vols = candles.map((c) => c.v);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const at = (back) => closes[closes.length - 1 - back];

  const sma20 = sma(closes, 20), sma50 = sma(closes, 50), sma200 = sma(closes, 200);
  const s50 = smaSeries(closes, 50), s200 = smaSeries(closes, 200);
  const ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
  const macd = ema12.map((v, i) => v - ema26[i]);
  const signal = emaSeries(macd, 9);
  const macdHist = macd[macd.length - 1] - signal[signal.length - 1];
  const macdHistPrev = macd[macd.length - 2] - signal[signal.length - 2];

  const hi52 = Math.max(...candles.map((c) => c.h));
  const lo52 = Math.min(...candles.map((c) => c.l));
  const avgVol20 = sma(vols.slice(0, -1), 20);
  const relVol = avgVol20 ? last.v / avgVol20 : null;
  const rsi14 = rsi(closes);

  // golden / death cross within last 10 sessions
  let cross = null;
  for (let i = s200.length - 10; i < s200.length; i++) {
    if (i < 1 || s200[i - 1] == null) continue;
    if (s50[i - 1] <= s200[i - 1] && s50[i] > s200[i]) cross = 'golden';
    if (s50[i - 1] >= s200[i - 1] && s50[i] < s200[i]) cross = 'death';
  }

  const signals = [];
  if (pct(last.c, hi52) > -2) signals.push('Near 52W High');
  if (pct(last.c, lo52) < 3) signals.push('Near 52W Low');
  if (rsi14 != null && rsi14 < 30) signals.push('RSI Oversold');
  if (rsi14 != null && rsi14 > 70) signals.push('RSI Overbought');
  if (relVol != null && relVol >= 2) signals.push('Volume Spike');
  if (cross === 'golden') signals.push('Golden Cross');
  if (cross === 'death') signals.push('Death Cross');
  if (macdHistPrev <= 0 && macdHist > 0) signals.push('MACD Bullish');
  if (macdHistPrev >= 0 && macdHist < 0) signals.push('MACD Bearish');

  return {
    symbol,
    name: meta.name,
    currency: meta.currency,
    price: last.c,
    change: pct(last.c, prev && prev.c),
    change5d: pct(last.c, at(5)),
    change1m: pct(last.c, at(21)),
    volume: last.v,
    relVol,
    rsi: rsi14,
    sma20, sma50, sma200,
    aboveSma50: sma50 != null && last.c > sma50,
    aboveSma200: sma200 != null && last.c > sma200,
    hi52, lo52,
    fromHigh: pct(last.c, hi52),
    macdHist,
    signals,
    spark: closes.slice(-30),
  };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const cleanSymbols = (s) => (s || '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9.&^=-]{1,20}$/.test(x)).slice(0, 100);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/scan') {
      const u = url.searchParams.get('universe') || 'nifty50';
      const symbols = u === 'custom' ? cleanSymbols(url.searchParams.get('symbols')) : UNIVERSES[u];
      if (!symbols || !symbols.length) return send(res, 400, { error: 'No symbols' });
      const failed = [];
      const rows = await pool(symbols, CONCURRENCY, async (s) => {
        try { return analyze(s, await fetchCandles(s)); } catch (e) { failed.push(s); return null; }
      });
      return send(res, 200, { rows: rows.filter(Boolean), failed, at: Date.now() });
    }

    if (url.pathname === '/api/history') {
      const [s] = cleanSymbols(url.searchParams.get('symbol'));
      if (!s) return send(res, 400, { error: 'Bad symbol' });
      const data = await fetchCandles(s);
      const closes = data.candles.map((c) => c.c);
      return send(res, 200, { ...data, sma50: smaSeries(closes, 50), sma200: smaSeries(closes, 200) });
    }

    const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Stock scanner running at http://localhost:${PORT}`));
