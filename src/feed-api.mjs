// Client for performance feeds: stats documents shaped like TopstepX's public share API, for
// accounts TopstepX can't share (today zandobot's Rithmic paper account). The Discord bot's
// Worker serves them at <worker>/feed/<id>; a feed's public link is this site's own stats page,
// share.html?feed=<id>, so a feed competitor is configured exactly like a TopstepX one.
//
// A feed document carries the same `daily` / `todaystats` rows, `intradayLows` map and `trades`
// rows that fetchAccountStats builds from TopstepX, so computeMetrics scores both the same way. Its
// trades are the latest week's, in exit order, each with its MFE and MAE and without any time.

import { ROSTER_ENDPOINT } from "./roster.mjs";

export const FEED_BASE = ROSTER_ENDPOINT.replace(/\/roster$/, "/feed/");
const FEED_ID = /^[a-z0-9-]{1,40}$/;

// The feed id of a share.html?feed=<id> link, or null for anything else (a TopstepX link).
export function parseFeedId(input) {
  if (input === null || input === undefined) return null;
  try {
    const id = new URL(String(input).trim()).searchParams.get("feed");
    return id && FEED_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export async function fetchFeed(id) {
  const res = await fetch(FEED_BASE + id, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET feed ${id} -> HTTP ${res.status}`);
  const doc = await res.json();
  if (!Array.isArray(doc?.daily) || !Array.isArray(doc?.todaystats) || typeof doc?.intradayLows !== "object") {
    throw new Error(`feed ${id} is missing daily, todaystats or intradayLows`);
  }
  return doc;
}

// Same object fetchAccountStats returns, scoped to the { start, end } window the way TopstepX
// scopes /Statistics/daily by startTradeDay / endTradeDay.
export async function fetchFeedStats(id, range) {
  const doc = await fetchFeed(id);
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  const inRange = (row) => {
    const t = Date.parse(row.tradeDay);
    return t >= start && t < end;
  };
  return {
    accountId: null,
    feed: id,
    accountName: doc.accountName,
    shared: doc.shared === true,
    daily: doc.daily.filter(inRange),
    todaystats: doc.todaystats.filter(inRange),
    intradayLows: doc.intradayLows,
    trades: Array.isArray(doc.trades) ? doc.trades.filter(inRange) : null,
    asOf: doc.asOf,
    range
  };
}
