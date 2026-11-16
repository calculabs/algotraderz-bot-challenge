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
| `/join <share link>` | Join, or add another account (up to 3, before the open) |
| `/link <share link> [replace]` | Swap an account; `replace` names which one if you have several |
| `/mylink` | Show the accounts on file for you |
| `/leave [link]` | Drop out, or drop just the account you link |
| `/leaderboard` | Link to the live board |
| `/remove <user>` | **Organizer only** — prune someone |

All replies are **ephemeral** (only the person running the command sees them), so the channel stays clean.

## The week, in three states

| When | State | What works |
| --- | --- | --- |
| Fri close → **Sun ~1pm PT** | 🧊 **Frozen** | Nothing changes. `/join`, `/link` and `/leave` all refuse. |
| Sun ~1pm → **3pm PT** (the rollover) | 🧹 **Open** | Entries carried over, idle accounts dropped. Join, add, swap and drop accounts freely. |
| Sun 3pm → Fri close | 🏁 **Live** | First joins open (unless `LOCK_JOIN`). Traded accounts 🔒 set; untraded ones can be swapped or dropped. |

**Entries carry over.** An entry stays on the board week to week. At the Sunday 1pm PT rollover every account that didn't trade in the week just finished drops off, and the bot treats it as gone from that instant: `/roster` stops serving it and the commands don't see it. Which accounts traded is recorded after Friday's close from the first clean post-close `data/leaderboard.json` (`active:<weekStart>` in KV); a scrape with any unread account is skipped, and if none lands all weekend nothing is pruned. A cron then prunes the keys and posts a "new week — entries carried over" notice. The prune is housekeeping, not the gate.

**Picking accounts after the fact is what's locked.** TopstepX scores every account from the Sunday open, whenever it was entered. So once the week is live, a person can't add another account, and an account that has traded this week can't be swapped or dropped. An account with **no trades yet** this week can be swapped (`/link`) or dropped (`/leave` with its link) — it has no result to protect, the same exposure as a late first join — which is what keeps a trader who reset their account over the weekend from being stuck (the 2026-08-16 problem). The bot checks TopstepX directly; if it can't read the account it refuses the change. Dropping out entirely is always allowed, and a rejoin during the same week brings back every account you left with. **Brand-new late joins stay open** by default; set `LOCK_JOIN = "true"` in `wrangler.toml` to close those during the week too.

**The weekend is frozen.** Freezing pins the finished week: the champion announced on Friday still matches the standings on Sunday, because no join, swap or leave can move them in between.

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

A cron fires every 10 minutes and self-gates, so it posts the champion **exactly once** after Friday's CME close (idempotent via a per-week KV marker), pulling standings from the published `data/leaderboard.json`. Leave `ANNOUNCE_CHANNEL_ID` blank to keep it off.

The same channel gets the Sunday "entries carried over" notice — the rollover happens whether or not a channel is configured, so a blank `ANNOUNCE_CHANNEL_ID` only costs the heads-up. `curl https://<worker>/health/discord` checks the stored bot token and channel access without posting.

### 9. The Sunday rollover

Nothing to configure — it rides the same cron as the champion post (`*/10 * * * *`). What drops idle accounts is the **clock plus the recorded activity**, not the cron: from the Sunday 1pm PT rollover on, every read and command hides an account that isn't in the finished week's `active:` record and wasn't entered since the rollover. The cron's job is the cleanup — prune those accounts and last week's `/leave` tombstones, then post the notice — on the first fire after the rollover that gets through, tracked by `cleared:<weekStart>` (holds how many accounts it pruned) and `noticed:<weekStart>` (the post). The prune is idempotent, so it can run late, run twice, or fail halfway and be retried. At steady state a fire costs two KV reads.

The board used to clear every Sunday, and before that a single wipe had to land inside the two-hour pre-open window. On 2026-08-16 it didn't: the roster carried into the live week, the swap lock froze it there, and a trader who'd reset their account over the weekend was stuck on a dead entry. Carry-over avoids that two ways: nothing waits on a cron fire, and an account with no trades yet can always be swapped or dropped.

Don't try to narrow that cron to Sundays: Cloudflare's day-of-week field is `1-7` or `SUN-SAT`, so `*/10 * * * 0` returns a **400 and the entire schedules update fails** — which deploys new code with no triggers behind it, the worst of both.

**Deploying mid-week** is safe: entries and accounts are unchanged, and pruning only ever applies at a rollover from a recorded week.

**There is no manual `/reset`.** Nothing needs one: idle accounts drop off at the rollover and the prune retries on its own. Use `/remove` to prune individuals — it also clears their `/leave` tombstone.

**Logs.** `[observability] enabled = true` in `wrangler.toml` turns on Workers Logs; every cron fire logs what it did (phase, entries swept, notice/champion posted or why not). Read them in the dashboard under the Worker → Logs when a Sunday looks wrong.

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
