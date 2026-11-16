// A competitor's link is either a TopstepX share link or a feed link (share.html?feed=<id>).
// The board and the scrape resolve and fetch through here so both kinds score identically.

import { fetchAccountStats, fetchWeeklyStats, parseAccountId } from "./topstep-api.mjs";
import { fetchFeedStats, parseFeedId } from "./feed-api.mjs";

// { kind: "feed", id } | { kind: "topstepx", id: <account id> } | null. The feed check runs
// first: parseAccountId would otherwise pick any run of digits out of a feed URL.
export function parseShare(input) {
  const feed = parseFeedId(input);
  if (feed) return { kind: "feed", id: feed };
  const accountId = parseAccountId(input);
  return accountId == null ? null : { kind: "topstepx", id: accountId };
}

export const shareOf = (p) => parseShare(p.accountId ?? p.share ?? p.url);

// TopstepX account id for a row, or null for a feed (it has no public account number).
export const shareAccountId = (share) => (share.kind === "topstepx" ? share.id : null);

export const shareLabel = (share) => (share.kind === "feed" ? `${share.id} feed` : `account ${share.id}`);

// `lean` picks the browser's lighter TopstepX fetch; a feed is one request either way.
export function fetchShareStats(share, range, { lean = false } = {}) {
  if (share.kind === "feed") return fetchFeedStats(share.id, range);
  return lean ? fetchWeeklyStats(share.id, range) : fetchAccountStats(share.id, range);
}
