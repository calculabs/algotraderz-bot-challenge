// Cloudflare Worker — Discord slash-command bot for the Algo Traderz weekly bot
// challenge. Discord is the identity, so there's no login, no anonymous auth, and
// no per-browser token to lose: each competitor is keyed by their Discord user id.
//
// This one Worker serves two things:
//   POST /         Discord interactions endpoint (the slash commands)
//   GET  /roster   public JSON the leaderboard site reads (CORS: *)
//
// The roster lives in a KV namespace (binding ROSTER), one key per competitor:
//   user:<discordId> -> { discordId, name, url, accountId, joinedAt, updatedAt }
//
// The roster is per-week: a cron wipes it every Sunday in the pre-open window, so a week
// always starts from an empty board and nobody inherits a link they can no longer change.
//
// The Worker needs no bot token (it only verifies request signatures with the app's
// public key and replies inline). The token is used solely by register.js, run once
// from your laptop to publish the command list.

import { weekSchedule } from "../../src/calendar.mjs";

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

async function readRoster(env) {
  const cached = await env.ROSTER.get(ROSTER_ALL, "json");
  if (Array.isArray(cached)) return cached;
  return rebuildRoster(env); // cold start / first deploy
}

// Empty the board: every competitor, plus the /leave tombstones that shadow them (they're
// scoped to the week that just ended, so they'd only block a legitimate fresh entry).
// Paginated — list() returns at most 1000 keys a page, and a half-wipe would leave some of
// last week's links standing, which is the exact thing the reset exists to prevent.
// Returns how many competitors were cleared.
async function clearRoster(env) {
  let cleared = 0;
  for (const prefix of ["user:", "left:"]) {
    let cursor;
    do {
      const page = await env.ROSTER.list({ prefix, cursor });
      await Promise.all(page.keys.map((k) => env.ROSTER.delete(k.name)));
      if (prefix === "user:") cleared += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  // Write the empty denormalized key directly instead of rebuildRoster(): KV deletes are
  // eventually consistent, so a LIST right after the wipe can still hand back the keys we
  // just deleted and resurrect the whole roster. Here the answer is known — it's empty.
  await env.ROSTER.put(ROSTER_ALL, JSON.stringify([]));
  return cleared;
}

// ---- Discord request-signature verification (Ed25519 via Web Crypto) ----
const hexToBytes = (hex) => Uint8Array.from(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

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
//   "done"   Fri close → Sun 1pm PT   FROZEN. The week is finished and waiting to be
//                                     cleared; nothing on the board may change.
//   "pre"    Sun 1pm → 3pm PT         OPEN. The reset just wiped the board — join, and
//                                     swap accounts as often as you like.
//   live     Sun 3pm → Fri close      Joins open (unless LOCK_JOIN), swaps locked.
//
// The frozen weekend is what makes the reset honest. An entry written after Friday's close
// is deleted by Sunday's wipe before it can ever score, so accepting one would be a lie —
// the bot would say "you're on the board" and the board would disagree by Sunday evening.
// Freezing also pins the finished week: the champion announced on Friday still matches the
// standings on Sunday, because no join, swap or leave can move them in between.
export function boardFrozen(now = new Date()) {
  return weekSchedule(now).phase === "done";
}

// The clean-slate window, right after the Sunday wipe: the only time an account SWAP is
// allowed, since everyone is entering the new week from empty.
export function registrationOpen(now = new Date()) {
  return weekSchedule(now).phase === "pre";
}

// What every refusal during the freeze tells you to do. The wipe lands ~2h before the open.
const COMES_BACK_SUNDAY =
  "The board **clears every Sunday**, about 2h before the open, and joining opens the moment it does — `/join` then with the account you want scored for the week.";

// Shared by /join and /link. Mid-week we lock the thing that actually games the
// competition — SWAPPING to a different account (via /link, or a re-/join with a new
// account). A brand-new late join stays open (friendly) unless the organizer sets
// LOCK_JOIN. Re-submitting your existing account is always a harmless no-op.
async function upsertLink(interaction, env, { updating }) {
  const u = userOf(interaction);
  const accountId = parseAccountId(optionValue(interaction, "link"));
  if (accountId == null) {
    return reply("❌ That doesn't look like a TopstepX share link. Copy it from your stats page — e.g. `https://topstepx.com/share/stats?share=24801853`.");
  }
  // Checked before anything is read or written: between Friday's close and Sunday's wipe
  // there is no week to enter. Turning people away here is kinder than taking the entry
  // and deleting it on Sunday — nobody loses a week over it, since a join any time during
  // the live week still scores the full week (TopstepX reports P&L from the Sunday open,
  // not from when you joined).
  if (boardFrozen()) {
    return reply(`🧊 The week is finished and the board is frozen until it clears. ${COMES_BACK_SUNDAY}`);
  }
  const existing = await env.ROSTER.get(rosterKey(u.id), "json");
  // /leave leaves a tombstone, so leaving and rejoining can't launder an account swap: a
  // trader having a bad week could otherwise /leave, /join a different (better) account,
  // and land as a "brand-new join" — which LOCK_JOIN lets through by design. The account
  // you entered the week on is the one you're scored on, however you re-enter.
  const stale = existing ? null : await env.ROSTER.get(leftKey(u.id), "json");
  // Only a tombstone from THIS week can gate a rejoin. One from a week you sat out is just
  // history — you're a legitimate new entrant this week and may enter on any account.
  const weekStart = new Date(weekSchedule(new Date()).weekStart).getTime();
  const tomb = stale && new Date(stale.leftAt).getTime() >= weekStart ? stale : null;
  const priorAccount = existing?.accountId ?? tomb?.accountId ?? null;
  const isSwap = priorAccount != null && priorAccount !== accountId;
  const isNewJoin = !existing && !tomb;
  const gated = isSwap || (isNewJoin && truthy(env.LOCK_JOIN));
  // The freeze already returned above, so by here the week is either live (swaps locked)
  // or in the post-wipe pre-open window (everything allowed).
  if (gated && !registrationOpen()) {
    if (isSwap && tomb) {
      return reply(`🔒 Leaving doesn't reset your account. You entered this week on account **${priorAccount}** — you can rejoin on that one, but not on a different account mid-week. ${COMES_BACK_SUNDAY}`);
    }
    return reply(isSwap
      ? `🔒 You can't swap accounts mid-week. ${COMES_BACK_SUNDAY}`
      : `🔒 Joining is closed while the week is live. ${COMES_BACK_SUNDAY}`);
  }
  // joinedAt is when this person FIRST entered, and it survives link swaps — the board uses
  // it to decide which week they belong to, so an /link update must not move it forward
  // (that would silently eject them from the week they're already competing in).
  const now = new Date().toISOString();
  const entry = {
    discordId: u.id,
    name: displayName(u),
    url: shareUrl(accountId),
    accountId,
    // Fall back to updatedAt for entries written before joinedAt existed: stamping `now`
    // would date a long-standing competitor to today and drop them out of the week they
    // already competed in. No KV backfill needed — this converges them on first write.
    // A rejoin restores the original join date from the tombstone — otherwise /leave +
    // /join would re-date them to today and change which week they belong to.
    joinedAt: existing?.joinedAt ?? existing?.updatedAt ?? tomb?.joinedAt ?? now,
    updatedAt: now
  };
  await env.ROSTER.put(rosterKey(u.id), JSON.stringify(entry));
  if (stale) await env.ROSTER.delete(leftKey(u.id)); // they're back; clear it either way
  await rebuildRoster(env);
  const shared = await isShared(accountId);
  if (!shared) {
    return reply(`✅ ${updating ? "Updated" : "Added"} to account **${accountId}** — but I couldn't confirm public sharing is on. If you don't show up on the board within a minute, open your TopstepX stats page, turn on **Share**, and run \`/link\` again.`);
  }
  return updating
    ? reply(`🔁 Updated — you're now tracked on account **${accountId}**.`)
    : reply(`✅ You're on the board as **${entry.name}** (account **${accountId}**). Update anytime with \`/link\`, or \`/leave\` to drop out.`);
}

const COMMANDS = {
  join: (interaction, env) => upsertLink(interaction, env, { updating: false }),
  link: (interaction, env) => upsertLink(interaction, env, { updating: true }),

  async mylink(interaction, env) {
    const u = userOf(interaction);
    const entry = await env.ROSTER.get(rosterKey(u.id), "json");
    // During the freeze, "change it with /link" would be a promise the next command breaks.
    const next = boardFrozen()
      ? `This was **last week's** entry — it clears on Sunday. ${COMES_BACK_SUNDAY}`
      : "Change it with `/link`, or `/leave` to drop out.";
    return entry
      ? reply(`🔎 You're tracked on account **${entry.accountId}**\n${entry.url}\n${next}`)
      : reply(boardFrozen()
        ? `You're not on the board. ${COMES_BACK_SUNDAY}`
        : "You're not on the board yet. Add yourself with `/join <your TopstepX share link>`.");
  },

  async leave(interaction, env) {
    const u = userOf(interaction);
    const existing = await env.ROSTER.get(rosterKey(u.id), "json");
    if (!existing) return reply("You weren't on the board.");
    // Frozen too, and for once the refusal costs nothing: the week is already scored, and
    // Sunday's wipe drops you anyway. Deleting now would only rewrite a finished week's
    // standings — after the champion has been announced off them.
    if (boardFrozen()) {
      return reply(`🧊 The week is finished, so there's nothing left to drop out of — and the board is frozen until it clears on Sunday. **You're out by default**: entries don't carry over, so just don't \`/join\` next week.`);
    }
    await env.ROSTER.delete(rosterKey(u.id));
    // Remember the account they entered on (see leftKey) so rejoining can't swap it.
    await env.ROSTER.put(leftKey(u.id), JSON.stringify({
      discordId: u.id, accountId: existing.accountId, joinedAt: existing.joinedAt ?? existing.updatedAt, leftAt: new Date().toISOString()
    }));
    await rebuildRoster(env);
    return reply(`👋 Removed you from the board. You can rejoin anytime with \`/join\` — during a live week it has to be the same account (**${existing.accountId}**).`);
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
    const podium = pickPodium((await fetchStandings(env))?.rows);
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
  },

  // Organizer-only: clear the board now. Same path the Sunday cron uses — a manual button
  // for the week the cron missed, and a way to test the reset end to end.
  async reset(interaction, env) {
    const u = userOf(interaction);
    if (!adminIds(env).includes(u.id)) return reply("⛔ Only the organizer can clear the board.");
    const sched = weekSchedule(new Date());
    const cleared = await clearRoster(env);
    const n = `**${cleared}** ${cleared === 1 ? "entry" : "entries"}`;
    // In the pre-open window this IS the week's reset: claim the marker so the cron doesn't
    // clear a second time and wipe whoever joins in between, and post the public notice.
    // Any other time it's a repair, not a new week — clearing silently is the right blast
    // radius, and Friday's champion announcement still needs its own marker left alone.
    if (sched.phase !== "pre") {
      return reply(`🧹 Cleared ${n} from the board. This isn't the pre-open window, so no "new week" notice went out and Sunday's automatic reset is still armed.` +
        (sched.phase === "done" ? " Note the board stays **frozen** until Sunday's clear, so nobody can `/join` back on in the meantime." : ""));
    }
    await env.ROSTER.put(clearedKey(sched), "1");
    const { ok, why } = await postToChannel(env, { embeds: [newWeekEmbed(env)] });
    return reply(`🧹 Cleared ${n} — the board is open for \`/join\`. ` +
      (ok ? "Posted the new-week notice to the announcements channel." : `⚠️ Couldn't post the notice: ${why}.`));
  }
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
// this week (a just-joined 0-trade account is not a champion).
export function pickPodium(rows) {
  return (rows || [])
    .filter((r) => !r.drawdown?.breached && Number(r.overall?.trades) > 0 && Number.isFinite(Number(r.overall?.return_pct)))
    .sort((a, b) => b.overall.return_pct - a.overall.return_pct)
    .slice(0, 3);
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
  const webhook = (env.ANNOUNCE_WEBHOOK_URL || "").trim();
  if (!webhook && !env.DISCORD_BOT_TOKEN) return { ok: false, why: "neither `ANNOUNCE_WEBHOOK_URL` nor `DISCORD_BOT_TOKEN` is set on the Worker" };
  if (!webhook && !env.ANNOUNCE_CHANNEL_ID) return { ok: false, why: "`ANNOUNCE_CHANNEL_ID` is blank in `wrangler.toml`" };
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
async function announceChampion(env) {
  const sched = weekSchedule(new Date());
  if (sched.phase !== "done") return; // week still running (or pre-season)
  const marker = announcedKey(sched);
  if (await env.ROSTER.get(marker)) return; // already crowned this week
  const podium = pickPodium((await fetchStandings(env))?.rows);
  if (!podium.length) { await env.ROSTER.put(marker, "1"); return; } // nobody to crown; don't retry
  const { ok } = await postToChannel(env, { embeds: [championEmbed(podium, env)] });
  if (ok) await env.ROSTER.put(marker, "1"); // only mark done on a real post, so a fixable failure retries next hour
}

// ---- Sunday reset ----
//
// Entries are good for one week. Every Sunday, in the two-hour pre-open window the board
// already rolls over in (1pm PT -> the 3pm CME open), the roster is wiped so the new week
// starts empty. Without it, last week's link carries into the new week and the mid-week
// swap lock then freezes it there: a trader who changed accounts over the weekend, or
// whose share went private, is stuck on a dead entry until Friday's close with no command
// that can fix it. Clearing costs a `/join` — it never costs someone a week.
//
// The window is deliberately the only time this fires. A wipe during a live week would
// erase a real field mid-competition, so if every cron fire in the window is missed the
// board simply carries over and the organizer runs `/reset`.
export const clearedKey = (sched) => `cleared:${String(sched.weekStart).slice(0, 10)}`;

export function newWeekEmbed(env) {
  return {
    title: "🧹 New week — the board is clear",
    description:
      "Last week's entries are gone and **joining is open now**. Run `/join <your TopstepX share link>` to enter.\n\n" +
      "Until the open you can `/link` a different account freely. After that, swaps lock for the week — so enter on the account you actually want scored.\n\n" +
      `[Board](${siteBase(env)})`,
    color: 0x5865f2
  };
}

async function resetForNewWeek(env) {
  const sched = weekSchedule(new Date());
  if (sched.phase !== "pre") return;
  const marker = clearedKey(sched);
  if (await env.ROSTER.get(marker)) return; // already cleared this week
  // Claim the week BEFORE wiping, not after: joining reopens the instant the board empties,
  // so a second pass — an overlapping cron fire, a retry after a slow post — would delete
  // whoever entered in between. If the wipe itself fails, drop the claim so the next fire
  // retries rather than leaving the week marked done with last week's roster still on it.
  await env.ROSTER.put(marker, "1");
  try {
    await clearRoster(env);
  } catch (e) {
    await env.ROSTER.delete(marker);
    throw e;
  }
  await postToChannel(env, { embeds: [newWeekEmbed(env)] });
}

export default {
  async scheduled(event, env, ctx) {
    // Phase-exclusive: the champion posts after Friday's close ("done"), the reset fires in
    // Sunday's pre-open window ("pre"). Both self-gate, so every cron fire can run both.
    ctx.waitUntil(announceChampion(env));
    ctx.waitUntil(resetForNewWeek(env));
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
      const roster = await readRoster(env);
      const res = new Response(JSON.stringify(roster), {
        headers: { ...JSON_HEADERS, ...CORS, "cache-control": "public, max-age=60, s-maxage=60" }
      });
      ctx.waitUntil(cache.put(request, res.clone()));
      return res;
    }

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
