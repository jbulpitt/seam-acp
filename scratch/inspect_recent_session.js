const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const db = new DatabaseSync("data/seam.db");
const rows = db.prepare("SELECT * FROM session_records ORDER BY updatedUtc DESC LIMIT 1").all();

const record = rows[0];
console.log("Latest record repoPath:", record.repoPath);

const dotenv = require("dotenv");
dotenv.config();

const REPOS_ROOT = process.env.REPOS_ROOT || "/home/ubuntu/Projects";
const REPO_EMOJIS_STR = process.env.REPO_EMOJIS || "";

const map = new Map();
for (const entry of REPO_EMOJIS_STR.split(",").map((s) => s.trim()).filter(Boolean)) {
  const idx = entry.indexOf(":");
  if (idx <= 0) continue;
  const repo = entry.slice(0, idx).trim();
  const emoji = entry.slice(idx + 1).trim();
  map.set(repo, emoji);
}

const root = path.resolve(REPOS_ROOT);
const abs = path.resolve(record.repoPath);

let displayName = abs;
if (abs === root) {
  displayName = "/";
} else if (abs.startsWith(root + path.sep)) {
  displayName = abs.slice(root.length + 1);
}

let finalName = displayName;
if (displayName !== "/" && displayName !== "(unset)" && displayName !== abs) {
  const rootFolder = displayName.split(path.sep)[0] || "";
  const emoji = map.get(rootFolder) || map.get(displayName);
  if (emoji) {
    finalName = `${emoji} ${displayName}`;
  }
}

console.log("Calculated displayName:", finalName);
