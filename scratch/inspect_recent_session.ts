import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as dotenv from "dotenv";

const db = new DatabaseSync("data/seam.db");
const rows = db.prepare("SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1").all() as any[];

const record = rows[0];
console.log("Latest record ID:", record.id);
console.log("Latest record repoPath:", record.repoPath);

dotenv.config();
import { loadConfig } from "./src/config";
const config = loadConfig();

const map = config.REPO_EMOJIS;

const root = path.resolve(config.REPOS_ROOT);
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
