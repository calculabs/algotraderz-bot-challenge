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
const rosterKey = (id) => `user:${id}`;

async function readRoster(env) {
  const list = await env.ROSTER.list({ prefix: "user:" });
  const entries = await Promise.all(list.keys.map((k) => env.ROSTER.get(k.name, "json")));
  return entries.filter(Boolean);
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

// The weekend break — phase "done" (after Friday's close) or "pre" (before the first
// week ever opens) — is when the board is open to changes. During the live week
// (Sun open → Fri close) it's closed. Uses the site's canonical CME calendar so the
// two can't drift.
export function registrationOpen(now = new Date()) {
  const phase = weekSchedule(now).phase;
  return phase === "done" || phase === "pre";
}

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
  const existing = await env.ROSTER.get(rosterKey(u.id), "json");
  const isSwap = existing ? existing.accountId !== accountId : false;
  const isNewJoin = !existing;
  const gated = isSwap || (isNewJoin && truthy(env.LOCK_JOIN));
  if (gated && !registrationOpen()) {
    return reply(isSwap
      ? "🔒 You can't swap accounts mid-week. Account changes reopen after **Friday's close**, before **Sunday's open**."
      : "🔒 Joining is closed while the week is live. Come back after **Friday's close** to enter.");
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
    joinedAt: existing?.joinedAt ?? now,
    updatedAt: now
  };
  await env.ROSTER.put(rosterKey(u.id), JSON.stringify(entry));
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
    return entry
      ? reply(`🔎 You're tracked on account **${entry.accountId}**\n${entry.url}\nChange it with \`/link\`, or \`/leave\` to drop out.`)
      : reply("You're not on the board yet. Add yourself with `/join <your TopstepX share link>`.");
  },

  async leave(interaction, env) {
    const u = userOf(interaction);
    const existed = await env.ROSTER.get(rosterKey(u.id));
    await env.ROSTER.delete(rosterKey(u.id));
    return reply(existed ? "👋 Removed you from the board. Come back anytime with `/join`." : "You weren't on the board.");
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
      `\n\n[Full board](${siteBase(env)})\nNew week opens Sunday — \`/join\` to enter.`,
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(announceChampion(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight for the site's roster fetch.
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Public roster read for the leaderboard site.
    if (request.method === "GET" && url.pathname === "/roster") {
      const roster = await readRoster(env);
      return new Response(JSON.stringify(roster), { headers: { ...JSON_HEADERS, ...CORS, "cache-control": "no-store" } });
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
