// Cloudflare Worker — Discord slash-command bot for the Algo Traderz weekly bot
// challenge. Discord is the identity, so there's no login, no anonymous auth, and
// no per-browser token to lose: each competitor is keyed by their Discord user id.
//
// This one Worker serves two things:
//   POST /         Discord interactions endpoint (the slash commands)
//   GET  /roster   public JSON the leaderboard site reads (CORS: *)
//
// The roster lives in a KV namespace (binding ROSTER), one key per competitor:
//   user:<discordId> -> { discordId, name, url, accountId, updatedAt }
//
// The Worker needs no bot token (it only verifies request signatures with the app's
// public key and replies inline). The token is used solely by register.js, run once
// from your laptop to publish the command list.

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

// Shared by /join and /link — validate the link, store the entry, confirm.
async function upsertLink(interaction, env, { updating }) {
  const u = userOf(interaction);
  const accountId = parseAccountId(optionValue(interaction, "link"));
  if (accountId == null) {
    return reply("❌ That doesn't look like a TopstepX share link. Copy it from your stats page — e.g. `https://topstepx.com/share/stats?share=24801853`.");
  }
  const entry = { discordId: u.id, name: displayName(u), url: shareUrl(accountId), accountId, updatedAt: new Date().toISOString() };
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

  standings(interaction, env) {
    const site = env.SITE_URL || "https://calculabs.github.io/algotraderz-bot-challenge/";
    return reply(`🏆 Live standings: ${site}`);
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
  }
};

export default {
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
