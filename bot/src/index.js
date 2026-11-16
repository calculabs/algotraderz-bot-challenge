// Cloudflare Worker — Discord slash-command bot for the Algo Traderz weekly bot
// challenge. Discord is the identity, so there's no login, no anonymous auth, and
// no per-browser token to lose: each competitor is keyed by their Discord user id.
//
// This one Worker serves three things:
//   POST /           Discord interactions endpoint (the slash commands)
//   GET  /roster     public JSON the leaderboard site reads (CORS: *)
//   GET|POST /feed/<id>  stats feeds for accounts TopstepX can't share (see "performance feeds")
//
// The roster lives in a KV namespace (binding ROSTER), one key per competitor:
//   user:<discordId> -> { discordId, name, url, accountId, joinedAt, updatedAt }
//
// The roster is per-week. The line between weeks is the Sunday 1pm PT rollover (see
// calendar.mjs): from that instant every entry written before it is last week's and is
// treated as gone by every read and command here, and a cron sweeps the dead keys and posts
// the "new week" notice. The sweep is housekeeping — the board is clear at the rollover
// whether or not it has run yet — so a week always starts from an empty board and nobody
// inherits a link they can no longer change.
//
// The Worker needs no bot token (it only verifies request signatures with the app's
// public key and replies inline). The token is used solely by register.js, run once
// from your laptop to publish the command list.

import { weekSchedule } from "../../src/calendar.mjs";
import { MAX_ACCOUNTS_PER_PERSON } from "../../src/roster.mjs";
import { podiumOf } from "../../src/leaderboard.mjs";

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
// Entries are good for one week, and the boundary is the Sunday 1pm PT rollover — the same
// instant the board flips to the new week. Anything written before it belongs to a finished
// week and is GONE from that moment: /roster hides it, /join and /link overwrite it as if it
// weren't there, /leave and /mylink don't see it. The cron then deletes the keys and posts the
// notice, but nothing waits on it.
//
// This is deliberate. The reset used to be the cron's job alone: one wipe, in a two-hour
// window, gating everything. On 2026-08-16 that wipe didn't land — the roster carried into
// the live week, the swap lock froze it there, and a trader who'd reset their account over
// the weekend was stuck on a dead entry with no command that could free them (/leave tombstoned
// it, so leaving didn't help either). Correctness can't hang on one cron fire landing cleanly
// inside a window: the clock decides what's stale, and the sweep can run late, run twice, or
// fail and retry without the board ever being wrong.
const stamp = (iso) => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0; // missing/garbage timestamps sort as ancient
};
const rolloverMs = (sched) => stamp(sched.rollover);
// A competitor entry from a finished week. Keyed on updatedAt, not joinedAt: joinedAt is
// preserved across re-submits (it says when someone FIRST entered), so only updatedAt says
// whether this entry was written for the current week.
const staleEntry = (e, sched) => stamp(e?.updatedAt ?? e?.joinedAt) < rolloverMs(sched);
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
  // The cache can still hold last week's entries — the sweep hasn't reached them, or a
  // rebuild raced it. Filtered here, so the board is clear at the rollover no matter what KV
  // holds, and a stuck cron can never carry a roster into the next week again.
  return all
    .filter((e) => !staleEntry(e, sched))
    .flatMap((e) => e.accounts.map((a) => ({
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
//   "pre"    Sun 1pm → 3pm PT         OPEN. The board just rolled over to an empty week —
//                                     join, and swap accounts as often as you like.
//   live     Sun 3pm → Fri close      Joins open (unless LOCK_JOIN), swaps locked.
//
// The frozen weekend is what makes the rollover honest. An entry written after Friday's
// close would be last week's the moment Sunday rolls over — gone before it could ever score
// — so accepting one would be a lie: the bot would say "you're on the board" and the board
// would disagree by Sunday afternoon. Freezing also pins the finished week: the champion
// announced on Friday still matches the standings on Sunday, because no join, swap or leave
// can move them in between.
//
// Every command reads the phase once from weekSchedule(); the same schedule also carries the
// rollover instant that decides which entries are stale (see "the week boundary").

// What every refusal during the freeze tells you to do. The rollover is ~2h before the open.
const COMES_BACK_SUNDAY =
  "The board **clears every Sunday**, about 2h before the open, and joining opens the moment it does — `/join` then with the account you want scored for the week.";

// ---- entries: up to MAX_ACCOUNTS_PER_PERSON accounts per person ----
//
//   user:<id> -> { discordId, name, accounts: [{ accountId, url, slot, joinedAt }], updatedAt }
//   left:<id> -> { discordId, accounts, updatedAt, leftAt }   (the /leave tombstone)
//
// Each account is its own row on the board, named by its slot: "alice", "alice #2". Slots are
// assigned once, so a name never moves to a different account.
//
// What can change when, all to stop picking accounts after their P&L is known (TopstepX scores
// every account from the Sunday open, whenever it was entered):
//
//   pre (Sun rollover -> open)   join, add accounts, swap, drop single accounts — anything.
//   live (open -> Fri close)     a person's FIRST account can still join late (unless
//                                LOCK_JOIN). Adding another, swapping, or dropping one of
//                                several is locked: you can only drop out entirely, and a
//                                rejoin brings back every account you left with.
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
const FROZEN = `🧊 The week is finished and the board is frozen until it clears. ${COMES_BACK_SUNDAY}`;
const SET_FOR_THE_WEEK =
  "Once the week is live your accounts are set until Friday's close: adding, swapping and dropping single accounts reopen at Sunday's clear, ~2h before the open.";

// This week's state for one person: their entry, and a tombstone that can gate a rejoin. Only
// a tombstone written after this week opened counts — leaving before the open (or in a week you
// sat out) pins nobody, the same staleEntry() test as for entries.
async function personState(env, u, sched) {
  const found = await env.ROSTER.get(rosterKey(u.id), "json");
  const entry = found && !staleEntry(found, sched) ? found : null;
  const left = entry ? null : await env.ROSTER.get(leftKey(u.id), "json");
  const tomb = left && stamp(left.leftAt) >= stamp(sched.weekStart) && !staleEntry(left, sched) ? left : null;
  return { entry, left, tomb };
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

// /link swaps your one account for another. With several, say which goes: /leave <link> + /join.
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
  if (sched.phase !== "pre") return reply(`🔒 You can't swap accounts mid-week. ${SET_FOR_THE_WEEK}`);
  if (accounts.length > 1) {
    return reply(`You have ${accounts.length} accounts on the board — drop the old one with \`/leave\` and its link, then \`/join\` the new one.\n${accountLines(displayName(u), accounts)}`);
  }
  await saveAccounts(env, u, state, [{ accountId, url: shareUrl(accountId), slot: 1, joinedAt: new Date().toISOString() }]);
  return reply(`🔁 Updated — you're now tracked on account **${accountId}**.${await sharingNote(accountId)}`);
}

const COMMANDS = {
  join: joinAccount,
  link: swapAccount,

  async mylink(interaction, env) {
    const u = userOf(interaction);
    const sched = weekSchedule(new Date());
    const found = await env.ROSTER.get(rosterKey(u.id), "json");
    const entry = found && !staleEntry(found, sched) ? found : null; // last week's = not on the board
    // During the freeze, "change it with /link" would be a promise the next command breaks.
    const frozen = sched.phase === "done";
    const next = frozen
      ? `This was **last week's** entry — it clears on Sunday. ${COMES_BACK_SUNDAY}`
      : sched.phase === "pre"
        ? `Add accounts with \`/join\` (up to ${MAX_ACCOUNTS_PER_PERSON}), swap with \`/link\`, or \`/leave\` to drop out.`
        : `${SET_FOR_THE_WEEK} \`/leave\` drops you out entirely.`;
    return entry
      ? reply(`🔎 You're on the board with:\n${accountLines(entry.name, entry.accounts)}\n${next}`)
      : reply(frozen
        ? `You're not on the board. ${COMES_BACK_SUNDAY}`
        : "You're not on the board yet. Add yourself with `/join <your TopstepX share link>`.");
  },

  async leave(interaction, env) {
    const u = userOf(interaction);
    const linkOption = optionValue(interaction, "link");
    const existing = await env.ROSTER.get(rosterKey(u.id), "json");
    if (!existing) return reply("You weren't on the board.");
    const sched = weekSchedule(new Date());
    // Last week's entry, still in KV only because the sweep hasn't reached it. It was never an
    // entry into THIS week, so no tombstone: one here would pin them to accounts they never
    // entered this week on (the 2026-08-17 trap).
    if (staleEntry(existing, sched)) {
      await env.ROSTER.delete(rosterKey(u.id));
      await rebuildRoster(env);
      return reply("That was **last week's** entry — entries don't carry over, so you were already off the board. `/join` to enter this week.");
    }
    // Frozen too: the week is already scored, and Sunday's rollover drops you anyway.
    if (sched.phase === "done") {
      return reply(`🧊 The week is finished, so there's nothing left to drop out of — and the board is frozen until it clears on Sunday. **You're out by default**: entries don't carry over, so just don't \`/join\` next week.`);
    }
    if (linkOption != null) {
      const accountId = parseAccountId(linkOption);
      if (accountId == null) return reply(NOT_A_LINK);
      if (!existing.accounts.some((a) => a.accountId === accountId)) return reply(`Account **${accountId}** isn't one of yours on the board.`);
      if (existing.accounts.length > 1) {
        // Dropping one of several after seeing the week's P&L is picking winners.
        if (sched.phase !== "pre") return reply(`🔒 You can't drop a single account mid-week. ${SET_FOR_THE_WEEK} \`/leave\` without a link drops you out entirely.`);
        const rest = existing.accounts.filter((a) => a.accountId !== accountId);
        await saveAccounts(env, u, { left: null }, rest);
        return reply(`👋 Dropped account **${accountId}**. Still on the board:\n${accountLines(existing.name, rest)}`);
      }
    }
    await env.ROSTER.delete(rosterKey(u.id));
    // Remember the accounts they left with (see leftKey) so a rejoin can't swap or drop any.
    // The entry's own updatedAt rides along so staleEntry() can judge the tombstone.
    await env.ROSTER.put(leftKey(u.id), JSON.stringify({
      discordId: u.id, accounts: existing.accounts, updatedAt: existing.updatedAt, leftAt: new Date().toISOString()
    }));
    await rebuildRoster(env);
    const n = existing.accounts.length;
    return reply(sched.phase === "pre"
      ? `👋 Removed you from the board. \`/join\` again any time.`
      : `👋 Removed you from the board. You can rejoin any time this week with \`/join\` — ${n === 1 ? `on the same account (**${existing.accounts[0].accountId}**)` : `it brings back all ${n} accounts you left with`}.`);
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
      `\n\n[Full board](${siteBase(env)})\nThe board is frozen until it clears Sunday, ~2h before the open — \`/join\` then to enter the new week.`,
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

// ---- Sunday rollover: sweep + notice ----
//
// Entries are good for one week. At the Sunday 1pm PT rollover every entry written before it
// is last week's and is already inert (see "the week boundary" above): the cron's job here is
// to delete the dead keys and post the "new week — the board is clear" notice. Neither gates
// anything, so unlike the original reset this doesn't need to land in the two-hour pre-open
// window: it runs on the first fire after the rollover that gets through, whenever that is,
// and until then the board is clear anyway.
//
// The sweep is idempotent and stale-only — it never touches an entry written for the current
// week — so it is safe to run late, to run twice, and to fail halfway and be retried. That is
// the property the original lacked: it CLAIMED the week (wrote its marker) before wiping so a
// second pass couldn't delete fresh joiners, which meant a fire that died between the claim
// and the wipe silently forfeited the week — the roster carried over and every later fire
// saw "already cleared". Here the marker is written only after the sweep completes, and it
// records what was cleared, not a claim.
//
// Budget: the free plan allows 50 subrequests per invocation and KV calls count. Each key
// costs a GET (to read its timestamp) and, if stale, a DELETE, so a fire sweeps at most
// SWEEP_KEYS keys and leaves the rest for the next fire ten minutes later. Worst case for a
// fire is 2·SWEEP_KEYS + 7 (two LISTs, the markers, the Discord post) = 39. Rosters this
// size finish in one fire; a runaway one still converges.
export const clearedKey = (sched) => `cleared:${String(sched.weekStart).slice(0, 10)}`;
export const noticedKey = (sched) => `noticed:${String(sched.weekStart).slice(0, 10)}`;
const SWEEP_KEYS = 16;

export function newWeekEmbed(env, sched, { late = false } = {}) {
  const board = `[Board](${siteBase(env)})`;
  if (!late) {
    return {
      title: "🧹 New week — the board is clear",
      description:
        "Last week's entries are gone and **joining is open now**. Run `/join <your TopstepX share link>` to enter.\n\n" +
        `You can enter up to ${MAX_ACCOUNTS_PER_PERSON} accounts — \`/join\` each one — and \`/link\` a different account freely until the open. After that, accounts lock for the week — so enter the ones you actually want scored.\n\n` +
        board,
      color: 0x5865f2
    };
  }
  // The week is already live: the notice is late (the pre-open fires were missed, or this
  // is a fresh deploy mid-week). Anyone who was on last week's board and assumed they'd
  // carried over needs to know to rejoin — a join now still scores the full week — and
  // swaps are already locked. Worded to read right even if nobody was on last week's board.
  return {
    title: "🧹 New week — the board has rolled over",
    description:
      "Entries don't carry over between weeks. If you were on **last week's** board and want to compete this week, run `/join <your TopstepX share link>` again — a join now still scores the whole week.\n\n" +
      "The week is live, so enter on the account you want scored: swaps are locked until Sunday.\n\n" +
      board,
    color: 0x5865f2
  };
}

// Delete last week's keys, up to SWEEP_KEYS of them. Returns how many competitor entries
// were removed and whether anything is left for a later fire. list() is asked for only as
// many keys as there is budget for, so a page can't overrun it, and its cursor/list_complete
// say whether more remain. Keys that list() still reports but that are already gone (KV
// lists are eventually consistent, and a previous fire may just have deleted them) read as
// null: deleted again harmlessly, not counted.
async function sweepLastWeek(env, sched) {
  let cleared = 0;
  let room = SWEEP_KEYS;
  let complete = true;
  for (const [prefix, stale] of [["user:", staleEntry], ["left:", staleTomb]]) {
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
        if (value && !stale(value, sched)) return; // this week's — keep
        await env.ROSTER.delete(k.name);
        if (value && prefix === "user:") cleared++;
      }));
      cursor = page.list_complete ? undefined : page.cursor;
      if (cursor && room <= 0) complete = false;
    } while (cursor && room > 0);
  }
  return { cleared, complete };
}

async function rollOverWeek(env, sched) {
  // Between Friday's close and Sunday's rollover the finished week is still the board, by
  // design (frozen, matching the announced champion). Nothing to do until it rolls over.
  if (sched.phase === "done") return;
  const week = String(sched.weekStart).slice(0, 10);
  // Sweep until it completes. The marker is written only then, and holds the last fire's
  // count — a debugging breadcrumb (`cleared:2026-08-16 = "3"`), nothing branches on it.
  if ((await env.ROSTER.get(clearedKey(sched))) == null) {
    const r = await sweepLastWeek(env, sched);
    console.log(`rollover: swept ${r.cleared} stale entr${r.cleared === 1 ? "y" : "ies"} for week ${week}${r.complete ? "" : " (more next fire)"}`);
    if (!r.complete) return;
    await env.ROSTER.put(clearedKey(sched), String(r.cleared));
  }
  // Then the notice, once. In the pre-open window it's the weekly "board is clear — /join";
  // any later and the pre-open fires were missed (or this is a fresh deploy mid-week), so it
  // says so and tells last week's field to rejoin. Tracked separately from the sweep so a
  // Discord hiccup retries the post (1 read + 1 fetch a fire) without re-running the
  // sweep's LISTs every ten minutes.
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
    // Phase-exclusive: the champion posts after Friday's close ("done"), the rollover sweep
    // and notice run any time after Sunday's rollover ("pre" or live). Both self-gate on
    // KV markers, so every cron fire runs both; the steady-state cost of a fire is 2 reads.
    // One schedule per fire: it's the costly call here (Intl) and the 10 ms free-plan CPU
    // budget applies to cron fires too. Failures are logged rather than swallowed — enable
    // observability in wrangler.toml to see them in the dashboard.
    const sched = weekSchedule(new Date());
    ctx.waitUntil(announceChampion(env, sched).catch((e) => console.error("announce failed:", e)));
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
