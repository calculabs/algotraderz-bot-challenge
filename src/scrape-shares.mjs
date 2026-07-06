import fs from "fs";
import path from "path";
import { fetchAccountStats, parseAccountId } from "./topstep-api.mjs";
import { weekSchedule } from "./calendar.mjs";
import { computeMetrics, buildRow, rankByScope, challengeInfo, toCsv } from "./leaderboard.mjs";

const configPath = process.argv[2] || "participants.json";
if (!fs.existsSync(configPath)) {
  console.error(`Missing ${configPath}. Copy participants.example.json to participants.json and add your competitors.`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
const challenge = Array.isArray(raw) ? {} : raw.challenge ?? {};
const participants = Array.isArray(raw) ? raw : raw.participants ?? [];

const now = new Date();
// Competition week can be pinned in config; otherwise use the live futures week.
const schedule =
  challenge.weekStart && challenge.weekEnd
    ? { ...weekSchedule(now), weekStart: challenge.weekStart, weekEnd: challenge.weekEnd }
    : weekSchedule(now);
const range = { start: schedule.weekStart, end: schedule.weekEnd };

fs.mkdirSync("data", { recursive: true });
const rawDir = path.join("data", "raw");
fs.mkdirSync(rawDir, { recursive: true });

const rows = [];
const diagnostics = [];

for (const p of participants) {
  const name = p.name ?? p.discord ?? "Unknown";
  const accountId = parseAccountId(p.accountId ?? p.share ?? p.url);
  if (accountId == null) {
    console.warn(`Skipping ${name}: no valid share link / account id`);
    continue;
  }

  console.log(`Fetching ${name} (account ${accountId})...`);
  let metrics = {};
  let source = "live";
  let shared = null;
  let error = null;
  try {
    const stats = await fetchAccountStats(accountId, range);
    shared = stats.shared;
    metrics = computeMetrics(stats, schedule.days, { currentDay: schedule.currentDay });
    const safe = String(name).replace(/[^a-z0-9_-]+/gi, "_");
    fs.writeFileSync(path.join(rawDir, `${safe}.json`), JSON.stringify(stats, null, 2));
  } catch (e) {
    error = e.message;
    source = "error";
  }

  rows.push(buildRow(p, accountId, metrics, { source, shared, error }));
  diagnostics.push({ name, accountId, source, shared, error, account_size: metrics.account_size ?? null, overall: metrics.overall ?? null, days_traded: metrics.days_traded ?? 0 });
}

const leaderboard = {
  generated_at: now.toISOString(),
  week: { start: schedule.weekStart, end: schedule.weekEnd },
  schedule: { currentDay: schedule.currentDay, totalDays: schedule.totalDays, phase: schedule.phase, days: schedule.days },
  challenge: challengeInfo(challenge),
  rows
};

fs.writeFileSync("data/leaderboard.json", JSON.stringify(leaderboard, null, 2));
fs.writeFileSync("data/leaderboard.csv", toCsv(rankByScope(rows, "overall", schedule.currentDay)));
fs.writeFileSync("data/diagnostics.json", JSON.stringify(diagnostics, null, 2));

console.log(`\nWeek ${schedule.weekStart.slice(0, 10)} · Day ${schedule.currentDay}/${schedule.totalDays} (${schedule.phase})`);
console.log("Overall standings (week P&L · today):");
for (const row of rankByScope(rows, "overall", schedule.currentDay)) {
  const pct = row.return_pct == null ? "n/a" : `${row.return_pct > 0 ? "+" : ""}${row.return_pct}%`;
  const size = row.account_size ? "$" + row.account_size.toLocaleString() : "?";
  console.log(`  #${String(row.rank).padEnd(3)} ${String(row.name).padEnd(18)} ${pct.padStart(9)}  wk ${row.week_pnl} · today ${row.today_pnl}  (${size})`);
}
console.log("\nWrote data/leaderboard.json, data/leaderboard.csv, data/diagnostics.json");
