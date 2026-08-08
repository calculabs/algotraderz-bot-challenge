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
| `/link <share link>` | Swap your account (Sunday, after the clear) |
| `/mylink` | Show what's on file for you |
| `/leave` | Drop out |
| `/leaderboard` | Link to the live board |
| `/remove <user>` | **Organizer only** — prune someone |
| `/reset` | **Organizer only** — clear the board now |

All replies are **ephemeral** (only the person running the command sees them), so the channel stays clean.

## The week, in three states

| When | State | What works |
| --- | --- | --- |
| Fri close → **Sun ~1pm PT** | 🧊 **Frozen** | Nothing changes. `/join`, `/link` and `/leave` all refuse. |
| Sun ~1pm → **3pm PT** (the clear) | 🧹 **Open** | Board wipes, joining reopens, swap accounts freely. |
| Sun 3pm → Fri close | 🏁 **Live** | Joining open (unless `LOCK_JOIN`), swaps 🔒 locked. |

**The board clears every Sunday.** Entries are good for one week. A cron wipes the roster in the pre-open window — the same two hours the board already rolls over in — and posts a "new week — the board is clear" notice, so everyone enters the week with `/join` and the link they actually want scored.

That's what makes the swap lock safe. Without it, last week's entry carries into the new week and then freezes: someone who moved accounts over the weekend, or whose share link went private, would be stuck on a dead entry until Friday's close with no command able to fix it.

**The weekend is frozen, not open.** Between Friday's close and Sunday's clear there is no week to enter — anything written then is deleted by the wipe before it can score, so taking the entry would be a lie. Freezing also pins the finished week: the champion announced on Friday still matches the standings on Sunday, because no join, swap or leave can move them in between. Nobody loses anything by waiting, because **a join during the live week still scores the full week** — TopstepX reports P&L from the Sunday open, not from when you joined.

**Swaps lock during the live week.** Once the trading week is live (Sun open → Fri close), you can't switch to a different account — `/link` (or a re-`/join` with a new account) replies with a 🔒 notice. Account changes reopen at Sunday's clear. **Brand-new late joins stay open** by default (friendly to stragglers); set `LOCK_JOIN = "true"` in `wrangler.toml` to close those during the week too. `/mylink` and `/leaderboard` work anytime.

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

Commit + push. GitHub Pages redeploys, and both the live board and the 15-minute scrape now merge in everyone who ran `/join`. Done.

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

The same channel gets the Sunday "board is clear" notice — the reset runs whether or not a channel is configured, so a blank `ANNOUNCE_CHANNEL_ID` only costs the heads-up, not the wipe.

### 9. The Sunday reset

Nothing to configure — it rides the same cron as the champion post (`*/10 * * * *`). It only acts in the pre-open window (Sun 1pm → 3pm PT) and only once per week, tracked by a `cleared:<weekStart>` KV marker. ~12 attempts cover a 2-hour window, so a cold Worker or a failed Discord post doesn't lose the reset.

Don't try to narrow that cron to Sundays: Cloudflare's day-of-week field is `1-7` or `SUN-SAT`, so `*/10 * * * 0` returns a **400 and the entire schedules update fails** — which deploys new code with no triggers behind it, the worst of both. Off-window fires cost a single phase check, so narrowing buys nothing.

It deliberately **never** fires during a live week — that would erase a real field mid-competition. If every attempt somehow misses, the old roster just carries over and an organizer runs `/reset`, which does the same wipe on demand (and, inside the pre-open window, claims the week's marker and posts the notice so the cron doesn't repeat it).

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
