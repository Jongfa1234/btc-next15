// Automatic predictions: run every few minutes by GitHub Actions (.github/workflows/auto-predict.yml).
// For the 15-minute window that just started, it records the model's up/down chance using only data from
// before the window began, plus Robinhood's (Kalshi's) target and crowd price. When windows finish, it checks
// them against Coinbase's real prices. The log lives on the "data" branch as log.json, which the app reads.
import fs from "node:fs";

const LOG = process.argv[2] || "log.json";
const Q = 900000, CB = "https://api.exchange.coinbase.com", BUS = "https://api.binance.us/api/v3";
const KAL = ["https://external-api.kalshi.com/trade-api/v2", "https://api.elections.kalshi.com/trade-api/v2"];
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const M = new Function("module", html.match(/<script id="model">([\s\S]*?)<\/script>/)[1] + ";return module.exports")({ exports: {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pos = (x) => { x = +x; return isFinite(x) && x > 0 ? x : null; };

async function getJSON(url, tries = 3) {
  for (let a = 1; ; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "btc-next15-logger" }, signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.json();
      const err = new Error(`${url.split("/")[2]} answered ${r.status}`);
      if (r.status < 500 && r.status !== 429) { err.final = true; throw err; }
      throw err;
    } catch (e) { if (a >= tries || e.final) throw e; await sleep(1000 * a); }
  }
}
async function coinbaseCandles(granSec, count) {
  const step = granSec * 1000, now = Date.now(), have = new Map(), windows = [];
  for (let e = now; windows.length * 300 < count; e -= 300 * step) windows.push([e - 299 * step, e]);
  for (let i = 0; i < windows.length; i += 4) {
    await Promise.all(windows.slice(i, i + 4).map(async ([s, e]) => {
      const rows = await getJSON(`${CB}/products/BTC-USD/candles?granularity=${granSec}&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`);
      for (const [t, l, h, o, c, v] of rows) have.set(t * 1000, { t: t * 1000, o: +o, h: +h, l: +l, c: +c, v: +v, tb: null });
    }));
    if (i + 4 < windows.length) await sleep(350);
  }
  return [...have.values()].sort((a, b) => a.t - b.t);
}
async function addTradeFlow(cs) {
  try {
    const calls = []; for (let s = cs[0].t; s < Date.now(); s += 1000 * Q) calls.push(getJSON(`${BUS}/klines?symbol=BTCUSDT&interval=15m&startTime=${s}&limit=1000`));
    const m = new Map(); for (const rows of await Promise.all(calls)) for (const r of rows) if (+r[5] > 0) m.set(r[0], +r[9] / +r[5]);
    if (cs.filter((x) => m.has(x.t)).length < cs.length * 0.8) return cs;
    return cs.map((x) => ({ ...x, tb: x.v * (m.get(x.t) ?? 0.5) }));
  } catch { return cs; }
}
async function kalshiMarkets() {
  for (const base of KAL) {
    try {
      const j = await getJSON(`${base}/markets?series_ticker=KXBTC15M&status=open&limit=50`, 2);
      return (j.markets || []).map((m) => ({ end: Date.parse(m.close_time), strike: pos(m.floor_strike) ?? pos(m.functional_strike) ?? pos(m.custom_strike) ?? pos(m.cap_strike),
        bid: pos(m.yes_bid_dollars), ask: pos(m.yes_ask_dollars), last: pos(m.last_price_dollars) })).filter((m) => m.strike);
    } catch {}
  }
  return null;
}
function priceAt(ms, minute) { // close of the 1-minute candle ending at ms
  let best = null; for (const k of minute) { if (k.t + 60000 <= ms + 1000) best = k; else break; }
  return best && ms - (best.t + 60000) < 3 * 60000 ? best.c : null;
}

async function main() {
  const now = Date.now(), start = Math.floor(now / Q) * Q, end = start + Q;
  let log = { entries: [] };
  try { const j = JSON.parse(fs.readFileSync(LOG, "utf8")); if (Array.isArray(j.entries)) log = j; } catch {}
  const E = log.entries, notes = [];

  // 1. Predict the window that just started, using only candles that closed before it began.
  if (!E.some((e) => e.start === start)) {
    let cs = await coinbaseCandles(900, 8700);
    cs = await addTradeFlow(cs);
    const closed = cs.filter((k) => k.t + Q <= start);
    const bt = await M.backtest(closed, {});
    const live = M.liveCall(closed, {}, bt); // predicts the candle after the last closed one = this window
    const bestP = Math.max(live.p, 1 - live.p), past = M.score(bt.rows, M.playTh(bestP));
    E.push({ start, end, made: new Date(now).toISOString(), lateMin: Math.round((now - start) / 6000) / 10, pUp: Math.round(live.p * 10000) / 10000,
      setup: M.VARIANTS[live.v].name, flow: closed[0].tb != null,
      past: { acc: Math.round(past.acc * 10000) / 10000, calls: past.calls, luck: Math.round(past.luck * 10000) / 10000 }, strike: null, crowd: null, startPrice: null, endPrice: null, up: null, right: null });
    notes.push(`predicted ${new Date(start).toISOString()} pUp=${live.p.toFixed(3)}`);
  }
  // 2. Record Robinhood's target and crowd price for this window the first time it shows up.
  const cur = E.find((e) => e.start === start);
  if (cur && cur.strike == null) {
    const ms = await kalshiMarkets();
    const m = ms && ms.find((x) => Math.abs(x.end - end) < 60000);
    if (m) {
      cur.strike = m.strike; cur.crowd = m.bid && m.ask ? Math.round((m.bid + m.ask) / 2 * 1000) / 1000 : m.last; cur.crowdAt = new Date(now).toISOString();
      // Assume the best call is followed: buy the likelier side at Robinhood's ask (or mid) if every check passes.
      const up = cur.pUp >= 0.5, bestP = Math.max(cur.pUp, 1 - cur.pUp);
      const price = up ? (m.ask ?? cur.crowd) : (m.bid != null ? 1 - m.bid : (cur.crowd != null ? 1 - cur.crowd : null));
      const pc = M.playCheck(bestP, cur.past && { ...cur.past }, price);
      cur.follow = { play: pc.play, side: up ? "above" : "below", price: price != null ? Math.round(price * 1000) / 1000 : null, minutesIn: Math.round((now - start) / 6000) / 10 };
      notes.push(`kalshi strike ${m.strike}, ${pc.play ? "PLAY " + cur.follow.side : "skip"}`);
    }
    else if (!ms) notes.push("kalshi unreachable");
  }
  // 3. Check finished windows.
  const pending = E.filter((e) => e.right == null && !e.expired && now >= e.end + 60000);
  if (pending.length) {
    const minute = await coinbaseCandles(60, 300).catch(() => []);
    for (const e of pending) {
      const a = priceAt(e.start, minute), b = priceAt(e.end, minute);
      if (a != null && b != null) {
        Object.assign(e, { startPrice: a, endPrice: b, up: b > a, right: (e.pUp >= 0.5) === (b > a) });
        if (e.strike) { e.aboveStrike = b > e.strike; e.rightVsStrike = (e.pUp >= 0.5) === e.aboveStrike; if (e.crowd != null) e.crowdRight = (e.crowd >= 0.5) === e.aboveStrike;
          if (e.follow && e.follow.play && e.follow.price != null) { const won = (e.follow.side === "above") === e.aboveStrike; e.follow.won = won; e.follow.pnl = Math.round(((won ? 1 : 0) - e.follow.price - M.FEE) * 1000) / 1000; } }
      } else if (now - e.end > 4 * 3600000) e.expired = true;
    }
    notes.push(`checked ${pending.length}`);
  }
  log.entries = E.sort((a, b) => a.start - b.start).slice(-3000);
  const done = log.entries.filter((e) => e.right != null), rh = done.filter((e) => e.crowdRight != null);
  log.summary = { updated: new Date(now).toISOString(), predictions: log.entries.length, checked: done.length, right: done.filter((e) => e.right).length,
    withRobinhood: rh.length, appRightVsStrike: rh.filter((e) => e.rightVsStrike).length, crowdRight: rh.filter((e) => e.crowdRight).length,
    followed: (() => { const f = log.entries.filter((e) => e.follow && e.follow.pnl != null);
      return { plays: f.length, won: f.filter((e) => e.follow.won).length, skipped: log.entries.filter((e) => e.follow && !e.follow.play).length,
        pnlPerDollarContract: Math.round(f.reduce((a, e) => a + e.follow.pnl, 0) * 100) / 100 }; })() };
  fs.writeFileSync(LOG, JSON.stringify(log));
  console.log(notes.join("; ") || "nothing to do", JSON.stringify(log.summary));
}
await main();
