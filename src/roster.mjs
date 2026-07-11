// Self-serve roster, owned by the Discord bot (a Cloudflare Worker) and read here.
// The bot keys each competitor by Discord id and exposes the roster as public JSON
// at <worker>/roster. The site merges those entries over the committed
// participants.json seed. No Firebase, no anonymous auth, no per-browser identity —
// managing your link happens in Discord (/join, /link, /leave).

// Paste your deployed Worker's roster URL here once it's live, e.g.
//   "https://algotraderz-bot.<your-subdomain>.workers.dev/roster"
// Leave empty to run off participants.json alone (e.g. before the bot is deployed).
export const ROSTER_ENDPOINT = "https://algotraderz-bot.calculabs.workers.dev/roster";

// Discord server invite — surfaced in the Manage panel so people know where to go.
export const DISCORD_INVITE = "https://discord.gg/rS75G8mbg";

// Fetch the bot-owned roster ([{ name, url }]). Returns [] on any error so the board
// degrades gracefully to participants.json.
export async function fetchBotRoster(endpoint = ROSTER_ENDPOINT) {
  if (!endpoint) return [];
  try {
    const res = await fetch(endpoint, { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : [])
      .map((e) => ({ name: e.name, url: e.url }))
      .filter((e) => e.name && e.url);
  } catch {
    return [];
  }
}

// Merge the committed seed roster with self-serve (bot) entries. Deduped by name
// (case-insensitive); a bot entry replaces a same-named seed entry, which is exactly
// how a player swapping their own link updates in place. Seed order is preserved;
// brand-new players are appended.
export function mergeRoster(base = [], extra = []) {
  const byName = new Map();
  for (const p of [...base, ...extra]) {
    const name = String(p.name ?? p.discord ?? "").trim();
    if (!name) continue;
    byName.set(name.toLowerCase(), { ...p, name });
  }
  return [...byName.values()];
}
