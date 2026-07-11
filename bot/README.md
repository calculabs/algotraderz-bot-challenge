# Algo Traderz roster bot

A Discord slash-command bot that owns the weekly challenge roster — **who's competing and their TopstepX share link** — keyed by Discord user id. It runs as a single **Cloudflare Worker** (free tier, no server, no card) and stores the roster in **Cloudflare KV**.

Discord is the identity, so there's no login, no anonymous auth, and nothing to lose when a trader clears cookies or switches devices — the exact fragility this replaces.

```
Discord  →  Cloudflare Worker (this)  →  KV roster
                                            │
                    GitHub Pages site reads GET /roster and renders
```

Traders manage themselves in the server:

| Command | What it does |
| --- | --- |
| `/join <share link>` | Join, or update your link |
| `/link <share link>` | Swap your account (weekend only) |
| `/mylink` | Show what's on file for you |
| `/leave` | Drop out |
| `/standings` | Link to the live board |
| `/remove <user>` | **Organizer only** — prune someone |

All replies are **ephemeral** (only the person running the command sees them), so the channel stays clean.

**Swaps lock during the live week.** Once the trading week is live (Sun open → Fri close), you can't switch to a different account — `/link` (or a re-`/join` with a new account) replies with a 🔒 notice until the weekend break. Changes reopen after Friday's CME close. **Brand-new late joins stay open** by default (friendly to stragglers); set `LOCK_JOIN = "true"` in `wrangler.toml` to close those during the week too. `/leave`, `/mylink`, and `/standings` work anytime.

---

## One-time setup

Prereqs: a [Cloudflare account](https://dash.cloudflare.com/sign-up) and a Discord account. From this `bot/` directory:

```bash
npm install
```

### 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**, name it (e.g. *Algo Traderz Bot*).
2. **General Information** → copy the **Application ID** and the **Public Key**.
3. **Bot** (left sidebar) → **Reset Token** → copy the **Bot Token** (you'll only use it in steps 3 & 5; it never goes into the Worker).

### 2. Create the KV namespace and fill `wrangler.toml`

```bash
npx wrangler login
npx wrangler kv namespace create ROSTER
```

Copy the printed `id` into `wrangler.toml`, then fill in the vars:

- `kv_namespaces[0].id` → the KV namespace id
- `DISCORD_PUBLIC_KEY` → your app's Public Key (step 1)
- `ADMIN_IDS` → your Discord user id (turn on Discord **Developer Mode** → right-click yourself → **Copy User ID**). Comma-separate for multiple organizers.
- `SITE_URL` → already set to the GitHub Pages board.

### 3. Deploy the Worker

```bash
npm run deploy
```

Copy the deployed URL it prints, e.g. `https://algotraderz-bot.<your-subdomain>.workers.dev`.

### 4. Point Discord at the Worker

Back in the Developer Portal → **General Information** → **Interactions Endpoint URL** → paste the Worker URL (the **root**, not `/roster`) → **Save**. Discord sends a signed PING; the Worker answers it, and the save succeeds. (If it fails, re-check `DISCORD_PUBLIC_KEY`.)

### 5. Register the slash commands

```bash
DISCORD_APP_ID=<app id> \
DISCORD_BOT_TOKEN=<bot token> \
DISCORD_GUILD_ID=<server id> \
npm run register
```

`DISCORD_GUILD_ID` (right-click the server → **Copy Server ID**) registers the commands to that one server so they appear **instantly**. Omit it to register globally (can take ~1h).

### 6. Add the bot to the server  ← the only thing you need from the server owner

Open this URL (fill in your Application ID) and authorize into the challenge server. **This requires "Manage Server" on the target server**, so either you have it, or the server owner (Scalpface) clicks it once:

```
https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&scope=bot%20applications.commands&permissions=0
```

The bot needs **no** channel permissions (`permissions=0`) — it only answers slash commands privately.

### 7. Wire the site to the roster

In [`../src/roster.mjs`](../src/roster.mjs) set:

```js
export const ROSTER_ENDPOINT = "https://algotraderz-bot.<your-subdomain>.workers.dev/roster";
```

Commit + push. GitHub Pages redeploys, and both the live board and the 30-minute scrape now merge in everyone who ran `/join`. Done.

### 8. (Optional) Weekly champion announcement

Have the bot post the winner into a channel after Friday's close:

1. Right-click the target channel → **Copy Channel ID** → set `ANNOUNCE_CHANNEL_ID` in `wrangler.toml`.
2. Give the bot **Send Messages** in that channel (it doesn't have it by default).
3. Store the bot token as a secret (used only for this POST):
   ```bash
   npx wrangler secret put DISCORD_BOT_TOKEN
   ```
4. `npm run deploy`.

A cron runs hourly Fri–Sun and self-gates, so it posts the champion **exactly once** after Friday's CME close (idempotent via a per-week KV marker), pulling standings from the published `data/leaderboard.json`. Leave `ANNOUNCE_CHANNEL_ID` blank to keep it off.

---

## The single ask of Scalpface (server owner)

> **Add the bot to the Discord server.** I'll send you a one-click authorize link (step 6) — it needs "Manage Server," which you have. That's it. Optionally, tell me your **Discord user ID** if you want organizer rights to `/remove` people, and the **Server ID** for instant command setup.

Nothing else: no Google/Firebase access, no hosting, no billing. The bot, its storage, and the site all live in accounts you control.

---

## Notes

- **Interaction replies need no bot token** — they verify Discord's Ed25519 request signature with the public key and reply inline. The token (a secret) is only used to *register* commands and to *post* the weekly announcement.
- **Cost:** $0. Cloudflare's free tier covers this comfortably; no Blaze/credit card like Cloud Functions would need.
- **`/roster`** returns `[{ discordId, name, url, accountId, updatedAt }]` with `Access-Control-Allow-Origin: *`. The site reads `name` + `url`.
- **Local dev:** `npm run dev` runs the Worker locally (`wrangler dev`); use a tunnel (e.g. `cloudflared`) if you want to point Discord at it during development.
