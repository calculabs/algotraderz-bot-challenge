// One-time: publish the bot's slash commands to Discord. Run from your laptop:
//
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node src/register.js
//
// With DISCORD_GUILD_ID set, the commands register for that one server and appear
// instantly (best for setup + iteration). Without it, they register globally and can
// take up to ~1h to propagate. Re-run any time you change the command list below.

const APP = process.env.DISCORD_APP_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;

if (!APP || !TOKEN) {
  console.error("Set DISCORD_APP_ID and DISCORD_BOT_TOKEN (and optionally DISCORD_GUILD_ID).");
  process.exit(1);
}

// Discord option types: 3 = STRING, 6 = USER.
const linkOption = { name: "link", description: "Your public TopstepX share link", type: 3, required: true };

const commands = [
  { name: "join", description: "Join the leaderboard with your TopstepX share link", options: [linkOption] },
  { name: "link", description: "Update your TopstepX share link", options: [linkOption] },
  { name: "mylink", description: "Show which account you're currently tracked on" },
  { name: "leave", description: "Remove yourself from the leaderboard" },
  { name: "leaderboard", description: "Get the link to the live leaderboard" },
  // Organizer commands are visible to everyone: `default_member_permissions: "0"` would
  // hide them from all non-Administrators, and the organizers are listed in ADMIN_IDS,
  // not necessarily server admins. Access is enforced in the Worker (which is the real
  // boundary anyway); anyone else who tries gets a private ⛔ refusal.
  {
    name: "remove",
    description: "(Organizer) Remove someone from the leaderboard",
    options: [{ name: "user", description: "The competitor to remove", type: 6, required: true }]
  },
  {
    name: "announce",
    description: "(Organizer) Post the current champion to the announcements channel"
  },
  {
    name: "reset",
    description: "(Organizer) Clear the board now — the same wipe Sunday's cron does"
  }
];

const endpoint = GUILD
  ? `https://discord.com/api/v10/applications/${APP}/guilds/${GUILD}/commands`
  : `https://discord.com/api/v10/applications/${APP}/commands`;

const res = await fetch(endpoint, {
  method: "PUT", // PUT replaces the whole set — removed commands disappear cleanly
  headers: { authorization: `Bot ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(commands)
});

const body = await res.text();
if (res.ok) {
  console.log(`✓ Registered ${commands.length} commands ${GUILD ? `to guild ${GUILD} (instant)` : "globally (may take ~1h)"}.`);
} else {
  console.error(`✗ Failed (${res.status}): ${body}`);
  process.exit(1);
}
