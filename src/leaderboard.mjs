// Per-day + overall weekly metrics and ranking — all derived from the public API.
// The only per-competitor input is a share link (account id) and a display name.
//
// Standings can be viewed per day (each session's isolated P&L) or "overall"
// (cumulative across the week). The current, unfinished day shows in-motion P&L:
// its daily row updates as trades land, and `todaystats` overlays it live.

function toNum(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(String(value ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
// Percentage returns can be tiny (-$5 on $150k = -0.0034%); keep extra precision.
const round4 = (n) => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null);

// Account size drives the % return. Combine accounts encode it in their name
// ("50KTC-…", "100KTC-…", "150KTC-…"); practice ("PRAC-…") accounts are always 150k.
export function accountSizeFromName(name) {
  const m = String(name ?? "").match(/(\d+)\s*K/i);
  if (m) {
    const k = Number(m[1]);
    if (Number.isFinite(k) && k > 0) return k * 1000;
  }
  return null;
}

const pctOf = (pnl, size) => (size ? round4((pnl / size) * 100) : null);

// The API's totalPnL is GROSS; the account balance (and TopstepX's own calendar)
// use NET = gross - fees - commissions. On high-frequency, large-size days the fees
// are large, so we always rank on net P&L.
const netPnl = (r) => toNum(r.totalPnL) - toNum(r.totalFees) - toNum(r.totalCommissions);

// Topstep End-of-Day trailing Maximum Loss Limit, by account size.
export const MLL_BY_SIZE = { 50000: 2000, 100000: 3000, 150000: 4500 };

// End-of-day trailing drawdown. The loss limit trails the highest END-OF-DAY
// balance (never intraday) by the account's MLL, and locks at the starting balance
// once the account is up by the MLL. A breach is PERMANENT: the first day that
// closes below the threshold fails the account for good. It may keep trading after
// (a breached account effectively becomes a practice account) but is never "active"
// again, so a later recovery back above the threshold does NOT clear the breach.
// `cushion` is the room left before the threshold (only meaningful while un-breached).
// Returns { mll, threshold, balance, cushion, breached, breach_date } or null when
// the account size has no known MLL.
export function drawdownState(dailyRows = [], accountSize) {
  const mll = MLL_BY_SIZE[accountSize];
  if (!mll || !accountSize) return null;
  const start = accountSize;
  const rows = dailyRows
    .filter((r) => r && r.tradeDay && toNum(r.balance) > 0)
    .sort((a, b) => String(a.tradeDay).localeCompare(String(b.tradeDay)));
  let peak = start;
  let threshold = start - mll;
  let breached = false;
  let breachDate = null;
  for (const r of rows) {
    const bal = toNum(r.balance);
    peak = Math.max(peak, bal);
    threshold = Math.min(start, peak - mll); // trails up on new EOD highs, locks at start
    if (!breached && bal < threshold - 0.005) {
      breached = true;
      breachDate = String(r.tradeDay).slice(0, 10);
    }
  }
  const balance = rows.length ? round2(toNum(rows[rows.length - 1].balance)) : null;
  const cushion = balance == null ? null : round2(balance - threshold);
  return { mll, threshold: round2(threshold), balance, cushion, breached, breach_date: breachDate };
}

// todaystats may arrive as [] , [ {...} ] or {...}; pull the live current-day P&L.
function normalizeToday(t) {
  const row = Array.isArray(t) ? t[0] : t && typeof t === "object" ? t : null;
  return row && row.totalPnL != null ? row : null;
}

// weekDays: [{ day, date, state }] from the schedule. currentDay drives the live overlay.
export function computeMetrics(stats, weekDays = [], { currentDay = 0 } = {}) {
  const daily = [...(stats.daily || [])].filter((r) => r && r.tradeDay);
  const byDate = new Map(daily.map((r) => [String(r.tradeDay).slice(0, 10), r]));
  const balances = daily
    .sort((a, b) => String(a.tradeDay).localeCompare(String(b.tradeDay)))
    .map((r) => toNum(r.balance))
    .filter((b) => b > 0);
  const latestBalance = balances.length ? round2(balances[balances.length - 1]) : null;
  // Practice accounts are always 150k; combines carry their size in the name.
  const accountSize = accountSizeFromName(stats.accountName) ?? 150000;
  const today = normalizeToday(stats.todaystats);

  const days = {};
  let daysTraded = 0;
  for (const { day, date } of weekDays) {
    let row = byDate.get(date) || null;
    // Live overlay: if the current day has no settled row yet but todaystats has
    // in-motion P&L, use it.
    if (!row && day === currentDay && today) row = today;
    const traded = !!row;
    if (traded) daysTraded++;
    const pnl = row ? round2(netPnl(row)) : 0;
    const wins = row ? toNum(row.winningTrades) : 0;
    const losses = row ? toNum(row.losingTrades) : 0;
    days[day] = {
      day,
      date,
      traded,
      live: day === currentDay,
      pnl,
      return_pct: accountSize ? pctOf(pnl, accountSize) : null,
      trades: row ? toNum(row.totalTrades) : 0,
      win_rate: wins + losses ? round2((wins / (wins + losses)) * 100) : null,
      balance: row && row.balance != null ? round2(toNum(row.balance)) : null
    };
  }

  const weekRows = weekDays.map((d) => days[d.day]).filter((d) => d.traded);
  const overallPnl = round2(weekRows.reduce((a, d) => a + d.pnl, 0));
  const overallTrades = weekRows.reduce((a, d) => a + d.trades, 0);

  return {
    account_size: accountSize,
    balance: latestBalance,
    days_traded: daysTraded,
    drawdown: drawdownState(daily, accountSize),
    overall: {
      pnl: overallPnl,
      return_pct: pctOf(overallPnl, accountSize),
      trades: overallTrades,
      balance: latestBalance
    },
    days
  };
}

// One rich leaderboard row (carries every scope). Shared by scrape + browser.
export function buildRow(participant, accountId, metrics, { source, shared = null, error = null } = {}) {
  return {
    name: participant.name ?? participant.discord ?? String(accountId ?? "Unknown"),
    account_id: accountId ?? null,
    url: participant.url ?? (accountId != null ? `https://topstepx.com/share/stats?share=${accountId}` : null),
    source,
    shared,
    error,
    account_size: metrics.account_size ?? null,
    balance: metrics.balance ?? null,
    days_traded: metrics.days_traded ?? 0,
    drawdown: metrics.drawdown ?? null,
    overall: metrics.overall ?? { pnl: 0, return_pct: null, trades: 0, balance: null },
    days: metrics.days ?? {}
  };
}

// Flatten a rich row to a single scope ("overall" or a day number) for rendering.
// Always carries week-to-date and today's figures alongside the selected scope.
export function flattenScope(row, scope, currentDay = 0) {
  const scopeM = scope === "overall" ? row.overall : row.days?.[scope] ?? null;
  const todayM = row.days?.[currentDay] ?? null;
  const zero = row.account_size != null ? 0 : null;
  return {
    rank: null,
    name: row.name,
    account_id: row.account_id,
    url: row.url,
    account_size: row.account_size,
    source: row.source,
    drawdown: row.drawdown ?? null,
    pnl: scopeM ? scopeM.pnl : zero,
    return_pct: scopeM ? scopeM.return_pct : zero,
    traded: scopeM ? scopeM.traded ?? true : false,
    week_pnl: row.overall?.pnl ?? zero,
    week_return: row.overall?.return_pct ?? zero,
    today_pnl: todayM ? todayM.pnl : zero,
    today_return: todayM ? todayM.return_pct : zero
  };
}

// Rank the rows: highest wins, rows with no data sink to the bottom. `metric`
// picks the sort key:
//   "pct"   — % return on account size for the selected day/overall window (default)
//   "wpl"   — week-to-date dollar P&L
//   "today" — today's dollar P&L
// Breached accounts are out of the competition (they become practice accounts), so
// they always sort below every active account, ordered among themselves by metric.
const METRIC_KEY = { pct: "return_pct", wpl: "week_pnl", today: "today_pnl" };
export function rankRows(rows, metric = "pct") {
  const key = METRIC_KEY[metric] ?? "return_pct";
  const out = (r) => (r.drawdown?.breached ? 1 : 0);
  rows.sort((a, b) => out(a) - out(b) || (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
  rows.forEach((row, i) => (row.rank = i + 1));
  return rows;
}

export function rankByScope(rows, scope, currentDay = 0, metric = "pct") {
  return rankRows(rows.map((r) => flattenScope(r, scope, currentDay)), metric);
}

export function challengeInfo(challenge = {}) {
  return {
    title: challenge.title ?? "Bot Challenge",
    org: challenge.org ?? "Algo Traderz",
    rules: challenge.rules ?? ["Highest % return wins", "No manual trades", "Max loss limit"]
  };
}

export function toCsv(rows) {
  const columns = ["rank", "name", "account_size", "week_pnl", "return_pct", "today_pnl", "account_id"];
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((c) => escape(row[c])).join(","))].join("\n");
}
