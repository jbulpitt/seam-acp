import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = {};
try {
  for (const line of readFileSync(path.join(__dirname, '../.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
} catch {}
const token = env.DISCORD_BOT_TOKEN;

const threadIds = [
  '1505714856857305270', '1506124617289568317', '1506660395514069233',
  '1506809467147259936', '1506867550158458920', '1503776778936778832',
];
const labels = new Set();

for (const tid of threadIds) {
  let before;
  for (let page = 0; page < 5; page++) {
    const url = `https://discord.com/api/v10/channels/${tid}/messages?limit=100${before ? '&before=' + before : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bot ${token}` } });
    const msgs = await res.json();
    if (!Array.isArray(msgs) || msgs.length === 0) break;
    for (const m of msgs) {
      if (!m.content) continue;
      for (const line of m.content.split('\n')) {
        const match = line.match(/^\s+[•·]\s+(.+)/);
        if (match) labels.add(match[1].trim());
      }
    }
    before = msgs[msgs.length - 1].id;
    await new Promise(r => setTimeout(r, 300));
  }
}

console.log(`Activity labels (${labels.size}):`);
for (const l of [...labels].sort()) console.log(`  ${l}`);
