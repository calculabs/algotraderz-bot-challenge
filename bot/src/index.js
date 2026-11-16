// Cloudflare Worker — Discord slash-command bot for the Algo Traderz weekly bot
// challenge. Discord is the identity, so there's no login, no anonymous auth, and
// no per-browser token to lose: each competitor is keyed by their Discord user id.
//
// This one Worker serves three things:
//   POST /           Discord interactions endpoint (the slash commands)
//   GET  /roster     public JSON the leaderboard site reads (CORS: *)
//   GET|POST /feed/<id>  stats feeds for accounts TopstepX can't share (see "performance feeds")
//   GET  /health/discord  whether the champion post's bot token and channel still work
//
// The roster lives in a KV namespace (binding ROSTER), one key per competitor (see "entries"):
//   user:<discordId> -> { discordId, name, accounts: [...], updatedAt }
//
// Entries carry over from week to week. At the Sunday 1pm PT rollover (see calendar.mjs) an
// account that didn't trade in the week just finished drops off: every read here applies that
// from the rollover instant, and a cron then prunes the keys and posts the "new week" notice.
// A carried account that hasn't traded yet this week can still be swapped or dropped, so
// nobody is stuck all week on an account they reset over the weekend.
//
// The Worker needs no bot token (it only verifies request signatures with the app's
// public key and replies inline). The token is used solely by register.js, run once
// from your laptop to publish the command list.

import { weekSchedule } from "../../src/calendar.mjs";
import { MAX_ACCOUNTS_PER_PERSON } from "../../src/roster.mjs";
import { computeMetrics, podiumOf } from "../../src/leaderboard.mjs";
import { fetchWeekActivity } from "../../src/topstep-api.mjs";

const JSON_HEADERS = { "content-type": "application/json" };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };

// Discord interaction request types + response types.
const REQUEST = { PING: 1, COMMAND: 2 };
const RESPONSE = { PONG: 1, MESSAGE: 4 };
const EPHEMERAL = 64; // "only you can see this" flag — keeps management out of the channel

// Every command reply is ephemeral so the channel never fills with join/leave noise.
const reply = (content) =>
  new Response(JSON.stringify({ type: RESPONSE.MESSAGE, data: { content, flags: EPHEMERAL } }), { headers: JSON_HEADERS });

// ---- TopstepX share link handling (mirrors src/topstep-api.mjs) ----

// Accepts a raw numeric id, a share URL, or anything containing the id.
function parseAccountId(input) {
  if (input == null) return null;
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

const shareUrl = (id) => `https://topstepx.com/share/stats?share=${id}`;

// Best-effort: confirm the stats page is actually public before we celebrate a join,
// so a "sharing is off" link is caught at entry instead of showing as a blank row.
// Short timeout + fail-open: we never block a join on a slow/broken external call.
async function isShared(accountId) {
  try {
    const res = await fetch(`https://userapi.topstepx.com/Statistics/checkSharing?tradingAccountId=${accountId}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch {
    return false;
  }
}

// ---- KV roster ----
//
// user:<id> is the source of truth, but serving /roster by LISTing it and GETting each key
// costs 1 + N KV ops per request. The board polls /roster from every open tab, and the free
// tier allows only 1,000 LISTs a day — one person leaving the board open all day exhausts
// it on their own. So /roster is served from a single denormalized key (1 GET, no LIST),
// rebuilt on the rare mutations (join / link / leave / remove). ROSTER_ALL is a cache of
// the user:* keys, never the source of truth: if it's missing we rebuild it from them.
const rosterKey = (id) => `user:${id}`;
// Tombstone left behind by /leave: remembers which account you entered the week on, so a
// leave+rejoin can't be used to swap accounts mid-week. Cleared on rejoin and by /remove.
const leftKey = (id) => `left:${id}`;
const ROSTER_ALL = "roster:all";

// ---- the week boundary ----
//
// The weeks meet at the Sunday 1pm PT rollover, the instant the board flips to the new week.
// Entries carry across it, but an account that didn't trade in the week just finished does
// not: from that instant /roster hides it and the commands treat it as gone. The cron then
// prunes the keys and posts the notice, but nothing waits on it.
//
// The board used to clear every Sunday, and before that the reset was one cron wipe in a
// two-hour window. On 2026-08-16 that wipe didn't land: the roster carried into the live week,
// the swap lock froze it there, and a trader who'd reset their account over the weekend was
// stuck on a dead entry with no command that could free them. Two things keep that from coming
// back with carry-over: correctness never hangs on one cron fire (the clock and the recorded
// activity decide, at every read), and an account with no trades yet this week can be swapped
// or dropped any time, because it has no result to protect.
const stamp = (iso) => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0; // missing/garbage timestamps sort as ancient
};
const rolloverMs = (sched) => stamp(sched.rollover);
const DAY_MS = 24 * 60 * 60 * 1000;
// Which accounts traded in a finished week, recorded from its final standings (see
// recordWeekActivity), keyed by that week's start date.
const activeKey = (weekStartIso) => `active:${String(weekStartIso).slice(0, 10)}`;
// The week just finished's traded account ids, or null when they weren't recorded (then
// nothing is pruned). The date-only key absorbs the hour a DST change moves the open.
const readActive = (env, sched) => env.ROSTER.get(activeKey(new Date(stamp(sched.weekStart) - 7 * DAY_MS).toISOString()), "json");
// The accounts an entry still holds this week: those that traded in the week just finished,
// and any entered since this week's rollover.
function liveAccounts(entry, sched, active) {
  if (!Array.isArray(active)) return entry.accounts;
  return entry.accounts.filter((a) => active.includes(a.accountId) || stamp(a.joinedAt) >= rolloverMs(sched));
}
// A /leave tombstone from a finished week: it could only ever gate a rejoin during the week
// it was written in.
const staleTomb = (t, sched) => stamp(t?.leftAt) < rolloverMs(sched);

async function listRoster(env) {
  const list = await env.ROSTER.list({ prefix: "user:" });
  const entries = await Promise.all(list.keys.map((k) => env.ROSTER.get(k.name, "json")));
  return entries.filter(Boolean);
}

// Rebuild the denormalized key from the authoritative user:* keys. Called after a mutation.
async function rebuildRoster(env) {
  const entries = await listRoster(env);
  await env.ROSTER.put(ROSTER_ALL, JSON.stringify(entries));
  return entries;
}

// The board's roster: one row per entered account, owner = the Discord id that entered it.
async function readRoster(env, sched) {
  const cached = await env.ROSTER.get(ROSTER_ALL, "json");
  const all = Array.isArray(cached) ? cached : await rebuildRoster(env); // cold start / first deploy
  // The cache can still hold accounts that dropped off at the rollover — the cron hasn't pruned
  // them yet, or a rebuild raced it. Filtered here, so the board is right from the rollover
  // on, whatever KV holds.
  const active = await readActive(env, sched);
  return all
    .flatMap((e) => liveAccounts(e, sched, active).map((a) => ({
      name: accountName(e.name, a.slot), url: a.url, accountId: a.accountId, joinedAt: a.joinedAt, owner: e.discordId
    })));
}

// ---- Discord request-signature verification (Ed25519 via Web Crypto) ----
const hexToBytes = (hex) => Uint8Array.from(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

// ---- performance feeds ----
//
// A feed is a stats document shaped like TopstepX's public share API (`daily` and `todaystats`
// rows, `intradayLows`), for an account TopstepX can't share — today zandobot's Rithmic paper
// account. Its producer POSTs the whole document, signed with the feed's secret; the board and
// share.html GET it. One KV key per feed, written only when the producer's numbers change.
//
//   POST /feed/<id>   headers x-feed-timestamp (epoch ms) and x-feed-signature
//                     (hex HMAC-SHA256 of "<timestamp>.<body>" under FEED_KEYS[id])
//   GET  /feed/<id>   public JSON (CORS: *), edge-cached for 30 s
//
// FEED_KEYS is a Worker secret holding {"<id>": "<secret>"}; a feed id without one doesn't exist.
const feedKey = (id) => `feed:${id}`;
const FEED_PATH = /^\/feed\/([a-z0-9-]{1,40})$/;
const FEED_SKEW_MS = 5 * 60 * 1000;
const FEED_MAX_BYTES = 256 * 1024;

function feedSecret(env, id) {
  let keys;
  try {
    keys = JSON.parse(env.FEED_KEYS || "{}");
  } catch {
    return null;
  }
  const secret = keys?.[id];
  return typeof secret === "string" && secret.length >= 32 ? secret : null;
}

async function verifyFeedSignature(secret, message, signatureHex) {
  if (!/^[0-9a-f]{64}$/.test(signatureHex)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, hexToBytes(signatureHex), new TextEncoder().encode(message));
}

const feedReply = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

async function ingestFeed(request, env, ctx, id) {
  const secret = feedSecret(env, id);
  if (!secret) return feedReply(404, { error: `no feed named ${id}` });
  const ts = Number(request.headers.get("x-feed-timestamp"));
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > FEED_SKEW_MS) {
    return feedReply(401, { error: "x-feed-timestamp is missing or more than 5 minutes off" });
  }
  const body = await request.text();
  if (body.length > FEED_MAX_BYTES) return feedReply(413, { error: `feed documents are limited to ${FEED_MAX_BYTES} bytes` });
  if (!(await verifyFeedSignature(secret, `${ts}.${body}`, request.headers.get("x-feed-signature") || ""))) {
    return feedReply(401, { error: "x-feed-signature does not match" });
  }
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return feedReply(400, { error: "body is not JSON" });
  }
  if (doc?.feed !== id || !Array.isArray(doc.daily) || !Number.isFinite(doc.asOfMs)) {
    return feedReply(400, { error: "document needs feed (matching the path), daily[] and asOfMs" });
  }
  // The timestamp window stops a replay after 5 minutes; this stops one inside it from
  // putting an older document back over a newer one.
  const prev = await env.ROSTER.get(feedKey(id), "json");
  if (prev && Number(prev.asOfMs) > doc.asOfMs) return feedReply(409, { error: "a newer document is already stored" });
  await env.ROSTER.put(feedKey(id), body);
  ctx.waitUntil(caches.default.delete(new Request(new URL(`/feed/${id}`, request.url))));
  return feedReply(200, { ok: true, asOfMs: doc.asOfMs });
}

async function serveFeed(request, env, ctx, id) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const body = await env.ROSTER.get(feedKey(id));
  if (body == null) {
    return new Response(JSON.stringify({ error: `no feed named ${id}` }), { status: 404, headers: { ...JSON_HEADERS, ...CORS } });
  }
  const res = new Response(body, { headers: { ...JSON_HEADERS, ...CORS, "cache-control": "public, max-age=30, s-maxage=30" } });
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

async function verifySignature(request, rawBody, publicKeyHex) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signature), message);
  } catch {
    return false;
  }
}

// ---- command helpers ----
const optionValue = (interaction, name) => (interaction.data?.options || []).find((o) => o.name === name)?.value;
const userOf = (interaction) => interaction.member?.user || interaction.user; // guild vs. DM shape
const displayName = (u) => u.global_name || u.username || String(u.id);
const adminIds = (env) => String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

const truthy = (v) => /^(1|true|on|yes)$/i.test(String(v ?? "").trim());

// Three states, all read off the site's canonical CME calendar so the bot and the board
// can't drift:
//
//   "done"   Fri close → Sun 1pm PT   FROZEN. The week is finished; nothing on the board
//                                     may change until it rolls over.
//   "pre"    Sun 1pm → 3pm PT         OPEN. The board just rolled over: entries carried
//                                     over, idle accounts dropped off. Join, add, swap and
//                                     drop accounts as often as you like.
//   live     Sun 3pm → Fri close      First joins open (unless LOCK_JOIN); accounts that
//                                     have traded are set, untraded ones can still change.
//
// Freezing pins the finished week: the champion announced on Friday still matches the
// standings on Sunday, because no join, swap or leave can move them in between.
//
// Every command reads the phase once from weekSchedule(); the same schedule also carries the
// rollover instant that decides which accounts dropped off (see "the week boundary").

// What every refusal during the freeze tells you to do. The rollover is ~2h before the open.
const COMES_BACK_SUNDAY =
  "The board **rolls over every Sunday**, about 2h before the open: entries carry over (accounts that didn't trade that week drop off), and joining and account changes open the moment it does.";

// ---- entries: up to MAX_ACCOUNTS_PER_PERSON accounts per person ----
//
//   user:<id> -> { discordId, name, accounts: [{ accountId, url, slot, joinedAt }], updatedAt }
//   left:<id> -> { discordId, accounts, updatedAt, leftAt }   (the /leave tombstone)
//
// Each account is its own row on the board, named by its slot: "alice", "alice #2". A slot
// keeps its account for as long as the account stays on the board.
//
// What can change when, all to stop picking accounts after their P&L is known (TopstepX scores
// every account from the Sunday open, whenever it was entered):
//
//   pre (Sun rollover -> open)   join, add accounts, swap, drop single accounts — anything.
//   live (open -> Fri close)     a person's FIRST account can still join late (unless
//                                LOCK_JOIN). Adding another is locked. An account that has
//                                traded this week is set; one with no trades yet can be
//                                swapped or dropped, the same exposure as a late first join.
//                                Dropping out entirely is always allowed, and a rejoin
//                                brings back every account you left with.
//   done (Fri close -> rollover) frozen — see "the week, in three states" above.
const accountName = (name, slot) => (slot === 1 ? name : `${name} #${slot}`);
const freeSlot = (accounts) => {
  let slot = 1;
  while (accounts.some((a) => a.slot === slot)) slot++;
  return slot;
};
const accountLines = (name, accounts) =>
  accounts.map((a) => `**${accountName(name, a.slot)}** — account **${a.accountId}**\n${a.url}`).join("\n");

const NOT_A_LINK =
  "❌ That doesn't look like a TopstepX share link. Copy it from your stats page — e.g. `https://topstepx.com/share/stats?share=24801853`.";
const FROZEN = `🧊 The week is finished and the board is frozen until it rolls over. ${COMES_BACK_SUNDAY}`;
const SET_FOR_THE_WEEK =
  "Once the week is live, adding accounts waits for Sunday's rollover (~2h before the open), and an account that has traded is set until Friday's close. One with no trades yet can still be swapped (`/link`) or dropped (`/leave` with its link).";
const COULD_NOT_CHECK = (id) => `⚠️ I couldn't check TopstepX for account **${id}** just now, so I can't tell whether it has traded this week. Try again in a minute.`;

// Whether an account already has a result this week, read from TopstepX the way the board reads
// it. null when TopstepX didn't answer: "couldn't read" must never pass for "no trades".
async function tradedThisWeek(accountId, sched) {
  try {
    const stats = await fetchWeekActivity(accountId, { start: sched.weekStart, end: sched.weekEnd });
    return computeMetrics(stats, sched.days, { currentDay: sched.currentDay }).days_traded > 0;
  } catch {
    return null;
  }
}

// This week's state for one person: their entry with only the accounts still on the board
// (null when none are), the stored record (`found`), and a tombstone that can gate a rejoin.
// Only a tombstone written after this week opened counts — leaving before the open, or in an
// earlier week, pins nobody.
async function personState(env, u, sched) {
  const found = await env.ROSTER.get(rosterKey(u.id), "json");
  const accounts = found ? liveAccounts(found, sched, await readActive(env, sched)) : [];
  const entry = accounts.length ? { ...found, accounts } : null;
  const left = entry ? null : await env.ROSTER.get(leftKey(u.id), "json");
  const tomb = left && stamp(left.leftAt) >= stamp(sched.weekStart) ? left : null;
  return { entry, found, left, tomb };
}

async function saveAccounts(env, u, state, accounts) {
  await env.ROSTER.put(rosterKey(u.id), JSON.stringify({
    discordId: u.id, name: displayName(u), accounts, updatedAt: new Date().toISOString()
  }));
  if (state.left) await env.ROSTER.delete(leftKey(u.id)); // they're back; a stale one goes too
  await rebuildRoster(env);
}

async function sharingNote(accountId) {
  return (await isShared(accountId))
    ? ""
    : `\n⚠️ I couldn't confirm public sharing is on for **${accountId}**. If it doesn't show on the board within a minute, turn on **Share** on that TopstepX stats page.`;
}

async function joinAccount(interaction, env) {
  const u = userOf(interaction);
  const accountId = parseAccountId(optionValue(interaction, "link"));
  if (accountId == null) return reply(NOT_A_LINK);
  const sched = weekSchedule(new Date());
  // Checked before anything is read or written: between Friday's close and Sunday's rollover
  // there is no week to enter.
  if (sched.phase === "done") return reply(FROZEN);
  const state = await personState(env, u, sched);
  const accounts = state.entry?.accounts ?? [];
  const mine = accounts.find((a) => a.accountId === accountId);
  if (mine) return reply(`✅ Account **${accountId}** is already on the board as **${accountName(displayName(u), mine.slot)}**.`);
  if (sched.phase !== "pre") {
    if (state.entry) return reply(`🔒 You can't add another account mid-week. ${SET_FOR_THE_WEEK}`);
    if (state.tomb) {
      const back = state.tomb.accounts;
      if (!back.some((a) => a.accountId === accountId)) {
        return reply(`🔒 Leaving doesn't reset your accounts. You entered this week on ${back.map((a) => `**${a.accountId}**`).join(", ")} — you can rejoin with ${back.length === 1 ? "it" : "them"}, but not on a different account mid-week. ${COMES_BACK_SUNDAY}`);
      }
      // A rejoin restores everything you left with, so leaving can't be used to drop a loser.
      await saveAccounts(env, u, state, back);
      return reply(`✅ Welcome back — ${back.length === 1 ? "your account is" : `all ${back.length} of your accounts are`} on the board again:\n${accountLines(displayName(u), back)}`);
    }
    if (truthy(env.LOCK_JOIN)) return reply(`🔒 Joining is closed while the week is live. ${COMES_BACK_SUNDAY}`);
  }
  if (accounts.length >= MAX_ACCOUNTS_PER_PERSON) {
    return reply(`You already have ${MAX_ACCOUNTS_PER_PERSON} accounts on the board, the most allowed. Drop one with \`/leave\` and its link first (before the open).`);
  }
  const slot = freeSlot(accounts);
  const next = [...accounts, { accountId, url: shareUrl(accountId), slot, joinedAt: new Date().toISOString() }];
  await saveAccounts(env, u, state, next);
  const name = accountName(displayName(u), slot);
  const more = next.length < MAX_ACCOUNTS_PER_PERSON
    ? ` You can enter up to ${MAX_ACCOUNTS_PER_PERSON} accounts — \`/join\` each one${sched.phase === "pre" ? " before the open" : " next week before the open"}.`
    : "";
  return reply(`✅ You're on the board as **${name}** (account **${accountId}**).${more}${await sharingNote(accountId)}`);
}

// /link swaps one of your accounts for another: your only one, or the one named by `replace`.
async function swapAccount(interaction, env) {
  const u = userOf(interaction);
  const accountId = parseAccountId(optionValue(interaction, "link"));
  if (accountId == null) return reply(NOT_A_LINK);
  const sched = weekSchedule(new Date());
  if (sched.phase === "done") return reply(FROZEN);
  const state = await personState(env, u, sched);
  if (!state.entry) return joinAccount(interaction, env);
  const accounts = state.entry.accounts;
  if (accounts.some((a) => a.accountId === accountId)) return reply(`✅ Account **${accountId}** is already on the board.`);
  const replaceOption = optionValue(interaction, "replace");
  let old;
  if (replaceOption != null) {
    const oldId = parseAccountId(replaceOption);
    if (oldId == null) return reply(NOT_A_LINK);
    old = accounts.find((a) => a.accountId === oldId);
    if (!old) return reply(`Account **${oldId}** isn't one of yours on the board.`);
  } else if (accounts.length === 1) {
    old = accounts[0];
  } else {
    return reply(`You have ${accounts.length} accounts on the board — say which one this replaces: \`/link\` with \`replace\` set to its link.\n${accountLines(displayName(u), accounts)}`);
  }
  if (sched.phase !== "pre") {
    const traded = await tradedThisWeek(old.accountId, sched);
    if (traded === null) return reply(COULD_NOT_CHECK(old.accountId));
    if (traded) return reply(`🔒 Account **${old.accountId}** has already traded this week, so it's set until Friday's close. ${SET_FOR_THE_WEEK}`);
  }
  const next = accounts.map((a) => (a === old ? { accountId, url: shareUrl(accountId), slot: old.slot, joinedAt: new Date().toISOString() } : a));
  await saveAccounts(env, u, state, next);
  return reply(`🔁 Swapped — **${accountName(displayName(u), old.slot)}** is now account **${accountId}** (was **${old.accountId}**).${await sharingNote(accountId)}`);
}

const COMMANDS = {
  join: joinAccount,
  link: swapAccount,

  async mylink(interaction, env) {
    const u = userOf(interaction);
    const sched = weekSchedule(new Date());
    const state = await personState(env, u, sched);
    if (!state.entry) {
      if (state.found) return reply(`Your accounts didn't trade last week, so they dropped off at Sunday's rollover. \`/join\` to come back.`);
      return reply(sched.phase === "done"
        ? `You're not on the board. ${COMES_BACK_SUNDAY}`
        : "You're not on the board yet. Add yourself with `/join <your TopstepX share link>`.");
    }
    const next = sched.phase === "done"
      ? `Your entry carries into next week; an account that didn't trade this week drops off at Sunday's rollover. ${COMES_BACK_SUNDAY}`
      : sched.phase === "pre"
        ? `Add accounts with \`/join\` (up to ${MAX_ACCOUNTS_PER_PERSON}), swap with \`/link\`, or \`/leave\` to drop out.`
        : `${SET_FOR_THE_WEEK} \`/leave\` without a link drops you out entirely.`;
    return reply(`🔎 You're on the board with:\n${accountLines(state.entry.name, state.entry.accounts)}\n${next}`);
  },

  async leave(interaction, env) {
    const u = userOf(interaction);
    const linkOption = optionValue(interaction, "link");
    const sched = weekSchedule(new Date());
    const state = await personState(env, u, sched);
    if (!state.entry) {
      if (!state.found) return reply("You weren't on the board.");
      // Every account dropped off at the rollover; the cron just hasn't pruned the key yet.
      await env.ROSTER.delete(rosterKey(u.id));
      await rebuildRoster(env);
      return reply("Your accounts didn't trade last week, so they'd already dropped off at Sunday's rollover — you weren't on the board. `/join` to enter.");
    }
    // Frozen: the week is already scored and its champion announced off these standings.
    if (sched.phase === "done") {
      return reply(`🧊 The week is finished and the board is frozen until Sunday's rollover. If you don't want to carry into next week, \`/leave\` then — before the open.`);
    }
    const accounts = state.entry.accounts;
    if (linkOption != null) {
      const accountId = parseAccountId(linkOption);
      if (accountId == null) return reply(NOT_A_LINK);
      if (!accounts.some((a) => a.accountId === accountId)) return reply(`Account **${accountId}** isn't one of yours on the board.`);
      if (accounts.length > 1) {
        // Dropping one of several after it has a result this week is picking winners.
        if (sched.phase !== "pre") {
          const traded = await tradedThisWeek(accountId, sched);
          if (traded === null) return reply(COULD_NOT_CHECK(accountId));
          if (traded) return reply(`🔒 Account **${accountId}** has already traded this week, so it stays until Friday's close. \`/leave\` without a link drops you out entirely.`);
        }
        const rest = accounts.filter((a) => a.accountId !== accountId);
        await saveAccounts(env, u, { left: null }, rest);
        return reply(`👋 Dropped account **${accountId}**. Still on the board:\n${accountLines(state.entry.name, rest)}`);
      }
    }
    await env.ROSTER.delete(rosterKey(u.id));
    // Remember the accounts they left with (see leftKey) so a rejoin can't swap or drop any.
    await env.ROSTER.put(leftKey(u.id), JSON.stringify({
      discordId: u.id, accounts, updatedAt: state.entry.updatedAt, leftAt: new Date().toISOString()
    }));
    await rebuildRoster(env);
    const n = accounts.length;
    return reply(sched.phase === "pre"
      ? `👋 Removed you from the board. \`/join\` again any time.`
      : `👋 Removed you from the board. You can rejoin any time this week with \`/join\` — ${n === 1 ? `on the same account (**${accounts[0].accountId}**)` : `it brings back all ${n} accounts you left with`}.`);
  },

  leaderboard(interaction, env) {
    const site = env.SITE_URL || "https://calculabs.github.io/algotraderz-bot-challenge/";
    return reply(`🏆 Live leaderboard: ${site}`);
  },

  // Organizer-only: prune anyone (duplicates, no-shows, people who left the server).
  async remove(interaction, env) {
    const u = userOf(interaction);
    if (!adminIds(env).includes(u.id)) return reply("⛔ Only the organizer can remove other people.");
    const targetId = optionValue(interaction, "user");
    if (!targetId) return reply("Pick a competitor to remove.");
    const existed = await env.ROSTER.get(rosterKey(targetId));
    await env.ROSTER.delete(rosterKey(targetId));
    // Organizer override: a true reset, tombstone and all, so a pruned duplicate/no-show can
    // rejoin cleanly on any account. (/leave deliberately does NOT clear it.)
    await env.ROSTER.delete(leftKey(targetId));
    if (existed) await rebuildRoster(env);
    return reply(existed ? `🗑️ Removed <@${targetId}> from the board.` : "That person wasn't on the board.");
  },

  // Organizer-only: post the current champion to the announcements channel now. Same
  // path the weekly cron uses (a live end-to-end test + a manual re-post button).
  async announce(interaction, env) {
    const u = userOf(interaction);
    if (!adminIds(env).includes(u.id)) return reply("⛔ Only the organizer can post announcements.");
    const podium = pickPodium(await fetchStandings(env));
    if (!podium.length) return reply("Nothing to announce yet — no eligible (non-breached) accounts with results on the board.");
    const { ok, why } = await postToChannel(env, { embeds: [championEmbed(podium, env)] });
    if (!ok) return reply(`⚠️ Couldn't post: ${why}.`);
    // If the week is already finished, this manual post IS the week's crowning — claim the
    // marker so the hourly cron doesn't post a duplicate. Mid-week (a preview post), leave
    // the marker alone so Friday's automatic announcement still fires.
    const sched = weekSchedule(new Date());
    const crowned = sched.phase === "done";
    if (crowned) await env.ROSTER.put(announcedKey(sched), "1");
    return reply(`✅ Posted the champion (**${podium[0].name}**) to the announcements channel.` +
      (crowned ? " This week is now marked as announced, so the hourly cron won't repost it." : ""));
  }
  // Deliberately no manual /reset. Clearing is irreversible (KV has no undo), and the one
  // moment it's safe — the pre-open window — is the only moment the cron needs no help:
  // it gets ~12 attempts there and releases its claim if a wipe fails. Outside that window
  // a manual wipe would erase a live field, which is exactly what the phase gate exists to
  // forbid. Prune individuals with /remove instead.
};

// ---- weekly champion announcement ----
const siteBase = (env) => (env.SITE_URL || "https://calculabs.github.io/algotraderz-bot-challenge/").replace(/\/?$/, "/");

// Read the standings the site already publishes (CI keeps it current). After Friday's
// close it holds the finished week until Sunday's reset.
async function fetchStandings(env) {
  try {
    const res = await fetch(siteBase(env) + "data/leaderboard.json", { cf: { cacheTtl: 0 } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Top three champion-eligible accounts by % return — non-breached AND actually traded
// this week (a just-joined 0-trade account is not a champion) — with no more than the
// challenge's podiumMaxPerPerson from one person.
export function pickPodium(standings) {
  const ranked = (standings?.rows || [])
    .filter((r) => !r.drawdown?.breached && Number(r.overall?.trades) > 0 && Number.isFinite(Number(r.overall?.return_pct)))
    .sort((a, b) => b.overall.return_pct - a.overall.return_pct);
  return podiumOf(ranked, standings?.challenge?.podiumMaxPerPerson ?? 1);
}

export function championEmbed(podium, env) {
  const w = podium[0];
  const pct = (v) => (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%";
  const money = (v) => (v >= 0 ? "+" : "-") + "$" + Math.abs(Number(v)).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const runners = podium.slice(1).map((r, i) => `${["🥈", "🥉"][i]} **${r.name}** (${pct(r.overall.return_pct)})`).join("   ");
  return {
    title: `🏆 Champion of the Week — ${w.name}`,
    description:
      `**${pct(w.overall.return_pct)}** return · **${money(w.overall.pnl)}** weekly P&L` +
      (runners ? `\n\n${runners}` : "") +
      `\n\n[Full board](${siteBase(env)})\nEntries carry into next week; accounts that didn't trade this week drop off at Sunday's rollover, ~2h before the open — \`/join\` then to add or change accounts.`,
    color: 0xf4c04f
  };
}

// Post the announcement. Two routes:
//
//   1. ANNOUNCE_WEBHOOK_URL (preferred) — a channel webhook. It carries its own authority,
//      so it posts into PRIVATE channels the bot can't even see. #bot-challenge is private,
//      which is why the bot-token route below returns 50001 there.
//   2. DISCORD_BOT_TOKEN + ANNOUNCE_CHANNEL_ID — needs View Channel + Send Messages +
//      Embed Links granted to the bot on the target channel.
//
// Returns { ok, why }; `why` carries Discord's own error so a failed /announce says what's
// actually wrong instead of listing everything that might be.
async function postToChannel(env, payload) {
  // `configured: false` means there is nowhere to post — announcements are switched off, not
  // failing — so the cron jobs mark their week done instead of retrying every fire.
  const webhook = (env.ANNOUNCE_WEBHOOK_URL || "").trim();
  if (!webhook && !env.DISCORD_BOT_TOKEN) return { ok: false, configured: false, why: "neither `ANNOUNCE_WEBHOOK_URL` nor `DISCORD_BOT_TOKEN` is set on the Worker" };
  if (!webhook && !env.ANNOUNCE_CHANNEL_ID) return { ok: false, configured: false, why: "`ANNOUNCE_CHANNEL_ID` is blank in `wrangler.toml`" };
  const url = webhook
    ? `${webhook}?wait=true` // ?wait=true so Discord reports failures instead of a blind 204
    : `https://discord.com/api/v10/channels/${env.ANNOUNCE_CHANNEL_ID}/messages`;
  const headers = { "content-type": "application/json" };
  if (!webhook) headers.authorization = `Bot ${env.DISCORD_BOT_TOKEN}`;
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  } catch (e) {
    return { ok: false, why: `the request to Discord failed (${e.message})` };
  }
  if (res.ok) return { ok: true };
  const body = await res.text();
  let code = null;
  let message = body.slice(0, 140);
  try {
    const j = JSON.parse(body);
    code = j.code ?? null;
    message = j.message ?? message;
  } catch {}
  if (webhook) {
    const why = res.status === 401 || res.status === 404
      ? "that webhook URL is invalid or was deleted — recreate it and re-run `wrangler secret put ANNOUNCE_WEBHOOK_URL`"
      : `the webhook returned ${res.status}${code ? ` (code ${code})` : ""}: ${message}`;
    return { ok: false, why };
  }
  // The codes we can actually act on; anything else falls through verbatim.
  const known = {
    10003: "that channel id doesn't exist, or the bot can't see the channel (needs **View Channel**)",
    50001: "the bot has no access to that channel — it needs **View Channel** there. That channel is private; a webhook (`ANNOUNCE_WEBHOOK_URL`) avoids needing the permission at all",
    50013: "the bot is missing **Send Messages** in that channel",
    40001: "Discord refused the request as unauthorized — the `DISCORD_BOT_TOKEN` is likely stale (reset?)"
  };
  const why = res.status === 401
    ? "the `DISCORD_BOT_TOKEN` is invalid — it was probably reset after the secret was stored"
    : known[code] || `Discord said ${res.status}${code ? ` (code ${code})` : ""}: ${message}`;
  return { ok: false, why };
}

// GET /health/discord: can the champion post still go out? Checks the stored bot token with
// Discord and that the bot can see the announcements channel, without posting anything. A
// visible channel doesn't prove Send Messages / Embed Links; a post that lacks them fails with
// 50013. Cached for 5 minutes under one key whatever the query string, so the URL can't be used
// to spend the bot's Discord rate limit.
async function discordHealth(request, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL("/health/discord", request.url));
  const hit = await cache.match(key);
  if (hit) return hit;
  const webhook = (env.ANNOUNCE_WEBHOOK_URL || "").trim();
  const result = {
    checkedAt: new Date().toISOString(),
    announceRoute: webhook ? "webhook" : env.DISCORD_BOT_TOKEN ? "bot token" : "none"
  };
  if (!env.DISCORD_BOT_TOKEN) {
    result.token = "not set";
  } else {
    const headers = { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` };
    const me = await fetch("https://discord.com/api/v10/users/@me", { headers });
    result.token = me.ok ? "ok" : `rejected by Discord (${me.status})`;
    if (me.ok) result.bot = (await me.json()).username;
    if (me.ok && env.ANNOUNCE_CHANNEL_ID) {
      const channel = await fetch(`https://discord.com/api/v10/channels/${env.ANNOUNCE_CHANNEL_ID}`, { headers });
      let code = "";
      if (!channel.ok) {
        try { code = `, code ${(await channel.json()).code}`; } catch {}
      }
      result.announceChannel = channel.ok ? "visible" : `not visible (${channel.status}${code})`;
    }
  }
  const res = new Response(JSON.stringify(result), {
    headers: { ...JSON_HEADERS, "cache-control": "public, max-age=300, s-maxage=300" }
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// The once-per-week idempotency key. Deliberately the DATE only: a full ISO timestamp is
// hostage to any drift in how weekStart is computed, and the cron fires ~49 times between
// Friday's close and Sunday's open — a key that fails to match means 49 champion posts.
export const announcedKey = (sched) => `announced:${String(sched.weekStart).slice(0, 10)}`;

// Once per week, after Friday's close, crown the champion. Idempotent: a KV marker per
// week means repeated cron fires (or a redeploy) never double-post.
async function announceChampion(env, sched) {
  if (sched.phase !== "done") return; // week still running (or pre-season)
  const marker = announcedKey(sched);
  if (await env.ROSTER.get(marker)) return; // already crowned this week
  const podium = pickPodium(await fetchStandings(env));
  if (!podium.length) { await env.ROSTER.put(marker, "1"); return; } // nobody to crown; don't retry
  const { ok, configured, why } = await postToChannel(env, { embeds: [championEmbed(podium, env)] });
  // Only mark done on a real post (or when announcements are off), so a fixable failure retries next fire.
  if (ok || configured === false) await env.ROSTER.put(marker, "1");
  else console.error(`announce: champion post failed, will retry: ${why}`);
  console.log(`announce: ${ok ? "posted" : "did not post"} champion for week ${marker.slice(10)} (${podium[0].name})`);
}

// After Friday's close, record which accounts traded this week, from the first standings the
// site publishes after the close (its scrape runs every 15 minutes). Sunday's rollover drops
// the rest. A scrape with any unread account is skipped rather than taken as "no trades" — a
// TopstepX outage must not prune the field; if no clean post-close scrape lands all weekend,
// nothing is recorded and nothing is pruned.
async function recordWeekActivity(env, sched) {
  if (sched.phase !== "done") return;
  const key = activeKey(sched.weekStart);
  if ((await env.ROSTER.get(key)) != null) return;
  const standings = await fetchStandings(env);
  if (!standings || standings.week?.start !== sched.weekStart || stamp(standings.generated_at) < stamp(sched.close)) return;
  const rows = standings.rows || [];
  if (rows.some((r) => r.source === "error")) return;
  const traded = rows.filter((r) => r.account_id != null && (r.days_traded ?? 0) > 0).map((r) => r.account_id);
  await env.ROSTER.put(key, JSON.stringify(traded));
  console.log(`activity: ${traded.length} account(s) traded in week ${key.slice(7)}`);
}

// ---- Sunday rollover: prune + notice ----
//
// At the Sunday 1pm PT rollover every account that didn't trade in the week just finished is
// already off the board (see "the week boundary"): the cron's job here is to prune those keys
// and the finished week's tombstones, then post the "new week" notice. Neither gates anything,
// so this doesn't need to land in the two-hour pre-open window: it runs on the first fire
// after the rollover that gets through, whenever that is.
//
// The prune is idempotent — it only ever removes what liveAccounts() already hides — so it is
// safe to run late, to run twice, and to fail halfway and be retried. The marker is written
// only after it completes, and records what was pruned, not a claim.
//
// Budget: the free plan allows 50 subrequests per invocation and KV calls count. Each key
// costs a GET and at most one PUT or DELETE, so a fire handles at most SWEEP_KEYS keys and
// leaves the rest for the next fire ten minutes later. Worst case for a fire is
// 2·SWEEP_KEYS + 8 (two LISTs, the activity read, the markers, the Discord post) = 40.
export const clearedKey = (sched) => `cleared:${String(sched.weekStart).slice(0, 10)}`;
export const noticedKey = (sched) => `noticed:${String(sched.weekStart).slice(0, 10)}`;
const SWEEP_KEYS = 16;

export function newWeekEmbed(env, sched, { late = false } = {}) {
  const board = `[Board](${siteBase(env)})`;
  if (!late) {
    return {
      title: "🧹 New week — entries carried over",
      description:
        "If you traded last week you're **already in** — no need to `/join` again. Accounts that didn't trade last week dropped off; `/join` to bring one back.\n\n" +
        `Until the open you can \`/join\` up to ${MAX_ACCOUNTS_PER_PERSON} accounts, \`/link\` to swap one, or \`/leave\` with a link to drop one. Once the week is live, an account that has traded is set until Friday's close.\n\n` +
        board,
      color: 0x5865f2
    };
  }
  // The week is already live: the notice is late (the pre-open fires were missed, or this
  // is a fresh deploy mid-week). Worded to read right even if nobody was on last week's board.
  return {
    title: "🧹 New week — the board has rolled over",
    description:
      "Last week's entries carried over, except accounts that didn't trade — `/join` to come back (a join now still scores the whole week).\n\n" +
      "The week is live: new accounts wait for Sunday, but an account with no trades yet this week can still be swapped (`/link`) or dropped (`/leave` with its link).\n\n" +
      board,
    color: 0x5865f2
  };
}

// Prune up to SWEEP_KEYS keys: accounts liveAccounts() no longer shows, entries left with none,
// and tombstones from a finished week. Returns how many accounts went, whether anything changed
// and whether keys remain for a later fire. list() is asked for only as many keys as there is
// budget for, and its cursor/list_complete say whether more remain. Keys list() still reports
// but that are already gone (KV lists are eventually consistent) read as null and are skipped.
async function pruneRollover(env, sched) {
  const active = await readActive(env, sched);
  let pruned = 0;
  let changed = false;
  let room = SWEEP_KEYS;
  let complete = true;
  for (const prefix of ["user:", "left:"]) {
    let cursor;
    do {
      if (room <= 0) { complete = false; break; } // budget spent; the rest waits for the next fire
      const page = await env.ROSTER.list({ prefix, cursor, limit: room });
      room -= page.keys.length;
      await Promise.all(page.keys.map(async (k) => {
        let value = null;
        try {
          value = await env.ROSTER.get(k.name, "json");
        } catch {
          /* unparsable — nothing this bot wrote; treat as dead */
        }
        if (prefix === "left:") {
          if (value && !staleTomb(value, sched)) return;
          await env.ROSTER.delete(k.name);
          return;
        }
        if (!value) return;
        const keep = liveAccounts(value, sched, active);
        if (keep.length === value.accounts.length) return;
        pruned += value.accounts.length - keep.length;
        changed = true;
        if (keep.length) await env.ROSTER.put(k.name, JSON.stringify({ ...value, accounts: keep }));
        else await env.ROSTER.delete(k.name);
      }));
      cursor = page.list_complete ? undefined : page.cursor;
      if (cursor && room <= 0) complete = false;
    } while (cursor && room > 0);
  }
  return { pruned, changed, complete };
}

async function rollOverWeek(env, sched) {
  // Between Friday's close and Sunday's rollover the finished week is still the board, by
  // design (frozen, matching the announced champion). Nothing to do until it rolls over.
  if (sched.phase === "done") return;
  const week = String(sched.weekStart).slice(0, 10);
  // Prune until it completes. The marker is written only then, and holds the accounts pruned
  // by the last fire — a debugging breadcrumb, nothing branches on it.
  if ((await env.ROSTER.get(clearedKey(sched))) == null) {
    const r = await pruneRollover(env, sched);
    console.log(`rollover: pruned ${r.pruned} idle account(s) for week ${week}${r.complete ? "" : " (more next fire)"}`);
    // The /roster cache still lists what was pruned (reads filter it out anyway); dropping it
    // makes the next read rebuild from the pruned keys.
    if (r.changed) await env.ROSTER.delete(ROSTER_ALL);
    if (!r.complete) return;
    await env.ROSTER.put(clearedKey(sched), String(r.pruned));
  }
  // Then the notice, once. In the pre-open window it's the weekly "entries carried over";
  // any later and the pre-open fires were missed (or this is a fresh deploy mid-week), so it
  // says the week is live. Tracked separately from the prune so a Discord hiccup retries the
  // post (1 read + 1 fetch a fire) without re-running the prune's LISTs every ten minutes.
  if (await env.ROSTER.get(noticedKey(sched))) return;
  const late = sched.phase !== "pre";
  const { ok, configured, why } = await postToChannel(env, { embeds: [newWeekEmbed(env, sched, { late })] });
  if (!ok && configured !== false) {
    console.error(`rollover: new-week notice failed, will retry: ${why}`);
    return;
  }
  await env.ROSTER.put(noticedKey(sched), "1");
  console.log(`rollover: ${ok ? "posted" : "skipped (announcements off)"} ${late ? "late " : ""}new-week notice for week ${week}`);
}

export default {
  async scheduled(event, env, ctx) {
    // Phase-exclusive: the champion post and the week's activity record run after Friday's
    // close ("done"), the rollover prune and notice any time after Sunday's rollover ("pre"
    // or live). All self-gate on KV markers, so every cron fire runs them; the steady-state
    // cost of a fire is 2 reads.
    // One schedule per fire: it's the costly call here (Intl) and the 10 ms free-plan CPU
    // budget applies to cron fires too. Failures are logged rather than swallowed — enable
    // observability in wrangler.toml to see them in the dashboard.
    const sched = weekSchedule(new Date());
    ctx.waitUntil(announceChampion(env, sched).catch((e) => console.error("announce failed:", e)));
    ctx.waitUntil(recordWeekActivity(env, sched).catch((e) => console.error("activity record failed:", e)));
    ctx.waitUntil(rollOverWeek(env, sched).catch((e) => console.error("rollover failed:", e)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight for the site's roster fetch.
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Public roster read for the leaderboard site. Served from the edge cache when warm, so
    // a hundred open tabs cost one KV read a minute rather than one per poll. The roster
    // only changes when someone runs /join, /link, /leave — a minute of staleness is fine,
    // and the bot's own reply already confirms the change to the person who made it.
    if (request.method === "GET" && url.pathname === "/roster") {
      const cache = caches.default;
      const hit = await cache.match(request);
      if (hit) return hit;
      const roster = await readRoster(env, weekSchedule(new Date()));
      const res = new Response(JSON.stringify(roster), {
        headers: { ...JSON_HEADERS, ...CORS, "cache-control": "public, max-age=60, s-maxage=60" }
      });
      ctx.waitUntil(cache.put(request, res.clone()));
      return res;
    }

    if (request.method === "GET" && url.pathname === "/health/discord") return discordHealth(request, env, ctx);

    const feed = url.pathname.match(FEED_PATH);
    if (feed && request.method === "GET") return serveFeed(request, env, ctx, feed[1]);
    if (feed && request.method === "POST") return ingestFeed(request, env, ctx, feed[1]);

    // Anything else that isn't a Discord interaction POST is just a health check.
    if (request.method !== "POST") return new Response("ok", { headers: { "content-type": "text/plain" } });

    const rawBody = await request.text();
    if (!(await verifySignature(request, rawBody, env.DISCORD_PUBLIC_KEY))) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(rawBody);
    if (interaction.type === REQUEST.PING) {
      return new Response(JSON.stringify({ type: RESPONSE.PONG }), { headers: JSON_HEADERS });
    }
    if (interaction.type === REQUEST.COMMAND) {
      const handler = COMMANDS[interaction.data?.name];
      if (handler) return handler(interaction, env);
      return reply("Unknown command.");
    }
    return new Response(JSON.stringify({ type: RESPONSE.PONG }), { headers: JSON_HEADERS });
  }
};
