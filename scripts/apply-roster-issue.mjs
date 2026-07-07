// Applies a "roster" issue-form submission to participants.json.
// Runs in the roster-sync GitHub Action; the issue body is untrusted input, so
// we only ever derive a display name + a numeric TopstepX account id from it.
import fs from "fs";
import { parseAccountId } from "../src/topstep-api.mjs";

const rosterFile = process.env.ROSTER_FILE || "participants.json";
const body = process.env.ISSUE_BODY || "";

// GitHub issue forms render as "### <label>\n\n<value>" sections.
function parseFields(text) {
  const map = {};
  for (const part of text.split(/^###\s+/m)) {
    const nl = part.indexOf("\n");
    if (nl === -1) continue;
    const label = part.slice(0, nl).trim().toLowerCase();
    let value = part.slice(nl + 1).trim();
    if (/^_no response_$/i.test(value)) value = "";
    if (label) map[label] = value;
  }
  return map;
}

function findValue(fields, re) {
  const key = Object.keys(fields).find((k) => re.test(k));
  return key ? fields[key] : "";
}

function setOutput(obj) {
  const line = Object.entries(obj)
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, " ")}`)
    .join("\n");
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line + "\n");
  console.log(line);
}

const fields = parseFields(body);
const name = findValue(fields, /discord|name|user/).replace(/[\r\n`]+/g, " ").trim().slice(0, 40);
const shareRaw = findValue(fields, /share|link|account/).trim();
const accountId = parseAccountId(shareRaw);

if (!name) {
  setOutput({ ok: false, message: "No name was provided." });
  process.exit(0);
}
if (accountId == null) {
  setOutput({ ok: false, message: `Couldn't find a TopstepX account id in "${shareRaw.slice(0, 80)}". Paste your share link, e.g. https://topstepx.com/share/stats?share=24801853` });
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(rosterFile, "utf8"));
config.participants = Array.isArray(config.participants) ? config.participants : [];
const url = `https://topstepx.com/share/stats?share=${accountId}`;

const idx = config.participants.findIndex(
  (p) => String(p.name || "").toLowerCase() === name.toLowerCase() || parseAccountId(p.url ?? p.accountId ?? p.share) === accountId
);

let message;
if (idx >= 0) {
  config.participants[idx] = { ...config.participants[idx], name, url };
  message = `Updated **${name}** → account ${accountId}.`;
} else {
  config.participants.push({ name, url });
  message = `Added **${name}** (account ${accountId}).`;
}

fs.writeFileSync(rosterFile, JSON.stringify(config, null, 2) + "\n");
setOutput({ ok: true, message });
