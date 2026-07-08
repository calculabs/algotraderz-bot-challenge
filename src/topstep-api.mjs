// Direct client for the public TopstepX stats API.
//
// A shared "stats" page (https://topstepx.com/share/stats?share=<ID>) is backed by
// a public, unauthenticated JSON API at userapi.topstepx.com. Every stats call is
// keyed only by the numeric tradingAccountId (the `share` value in the URL), the
// responses set `Access-Control-Allow-Origin: *`, and no cookie / token / auth
// header is involved. So we can skip a headless browser entirely and just fetch.

// This module runs in both Node (the scrape) and the browser (the live "Add
// competitor" panel), so read the override defensively — `process` is undefined
// in the browser.
const BASE =
  (typeof process !== "undefined" && process.env && process.env.TOPSTEP_API_BASE) ||
  "https://userapi.topstepx.com";

// Accepts a raw numeric id, a share URL, or anything containing the id.
export function parseAccountId(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return Number(s);
  try {
    const u = new URL(s);
    for (const key of ["share", "tradingAccountId", "accountId", "account"]) {
      const v = u.searchParams.get(key);
      if (v && /^\d+$/.test(v)) return Number(v);
    }
  } catch {
    /* not a URL */
  }
  const m = s.match(/\d{4,}/);
  return m ? Number(m[0]) : null;
}

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function checkSharing(accountId) {
  try {
    return (await call(`/Statistics/checkSharing?tradingAccountId=${accountId}`)) === true;
  } catch {
    return false;
  }
}

// The weekly-reset drawdown starts every account at its account size on Sunday, so
// nothing before the week open matters — the per-day series is scoped to the week.
const dailyBody = (id, range) => ({ tradingAccountId: id, startTradeDay: range.start, endTradeDay: range.end });
const accountNameOf = (id) => call(`/Statistics/getAccountName?tradingAccountId=${id}`).catch(() => null);
const todayStatsOf = (id) => call(`/Statistics/todaystats?accountId=${id}`, { method: "POST", body: {} }).catch(() => null);
const tradesOf = (id, range) =>
  call("/Statistics/trades", { method: "POST", body: { tradingAccountId: id, startTradeDay: range.start, endTradeDay: range.end } }).catch(() => []);

// Net realized P&L of one trade. The daily/EOD balance is net of fees + commissions,
// so an intraday equity reconstruction has to be too.
const tradeNet = (t) => (Number(t.profitAndLoss) || 0) - (Number(t.fees) || 0) - (Number(t.commissions) || 0);

// Reconstruct each day's intraday equity low from the realized-trade stream. An MLL
// breach fires the instant intraday equity touches the line, so end-of-day balances
// miss it — an account can plunge tens of thousands intraday and still close green.
// For each tradeDay we walk fills in fill order, track the running cumulative net
// P&L, and keep its minimum (floored at 0 = the day's open). Returns
// { "YYYY-MM-DD": low } where each low <= 0 (loss relative to that day's open).
export function intradayLowsByDay(trades = []) {
  const byDay = new Map();
  for (const t of Array.isArray(trades) ? trades : []) {
    const day = String(t.tradeDay ?? "").slice(0, 10);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }
  const lows = {};
  for (const [day, rows] of byDay) {
    rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    let cum = 0;
    let low = 0;
    for (const t of rows) {
      cum += tradeNet(t);
      if (cum < low) low = cum;
    }
    lows[day] = Math.round(low * 100) / 100;
  }
  return lows;
}

// Fetch everything we need for one account, scoped to a { start, end } window.
export async function fetchAccountStats(accountId, range) {
  const id = Number(accountId);
  const [shared, accountName, daily, todaystats, trades] = await Promise.all([
    checkSharing(id),
    accountNameOf(id),
    call("/Statistics/daily", { method: "POST", body: dailyBody(id, range) }).catch(() => []),
    todayStatsOf(id),
    tradesOf(id, range)
  ]);

  return {
    accountId: id,
    accountName: typeof accountName === "string" ? accountName : null,
    shared,
    daily: Array.isArray(daily) ? daily : [],
    todaystats,
    intradayLows: intradayLowsByDay(trades),
    range
  };
}

// Lean variant for the in-browser panel: per-day series + live current-day stats +
// intraday lows (for the drawdown line) + the account name (which encodes the size).
export async function fetchWeeklyStats(accountId, range) {
  const id = Number(accountId);
  const [accountName, daily, todaystats, trades] = await Promise.all([
    accountNameOf(id),
    call("/Statistics/daily", { method: "POST", body: dailyBody(id, range) }).catch(() => []),
    todayStatsOf(id),
    tradesOf(id, range)
  ]);
  return {
    accountId: id,
    accountName: typeof accountName === "string" ? accountName : null,
    daily: Array.isArray(daily) ? daily : [],
    todaystats,
    intradayLows: intradayLowsByDay(trades)
  };
}
