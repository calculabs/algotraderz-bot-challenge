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

const dailyBody = (id, range) => ({ tradingAccountId: id, startTradeDay: range.start, endTradeDay: range.end });
const accountNameOf = (id) => call(`/Statistics/getAccountName?tradingAccountId=${id}`).catch(() => null);
const todayStatsOf = (id) => call(`/Statistics/todaystats?accountId=${id}`, { method: "POST", body: {} }).catch(() => null);

// Fetch everything we need for one account, scoped to a { start, end } window.
export async function fetchAccountStats(accountId, range) {
  const id = Number(accountId);
  const [shared, accountName, daily, todaystats] = await Promise.all([
    checkSharing(id),
    accountNameOf(id),
    call("/Statistics/daily", { method: "POST", body: dailyBody(id, range) }).catch(() => []),
    todayStatsOf(id)
  ]);

  return {
    accountId: id,
    accountName: typeof accountName === "string" ? accountName : null,
    shared,
    daily: Array.isArray(daily) ? daily : [],
    todaystats,
    range
  };
}

// Lean variant for the in-browser panel: per-day series + live current-day stats +
// the account name (which encodes the account size).
export async function fetchWeeklyStats(accountId, range) {
  const id = Number(accountId);
  const [accountName, daily, todaystats] = await Promise.all([
    accountNameOf(id),
    call("/Statistics/daily", { method: "POST", body: dailyBody(id, range) }).catch(() => []),
    todayStatsOf(id)
  ]);
  return { accountId: id, accountName: typeof accountName === "string" ? accountName : null, daily: Array.isArray(daily) ? daily : [], todaystats };
}
