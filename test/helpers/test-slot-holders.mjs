import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as realSetTimeout, setInterval as realSetInterval } from "node:timers";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "slot-holder-source.mjs");
const delay = ms => new Promise(resolve => realSetTimeout(resolve, ms));
const now = performance.now.bind(performance);

function identity(pid) {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
      return fields[0] === "Z" || fields[0] === "X" ? undefined : fields[19];
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  try { process.kill(pid, 0); return String(pid); }
  catch (error) { if (error.code === "ESRCH") return undefined; throw error; }
}

export async function createTestHolderScope() {
  const base = path.resolve(here, "../../cache/test-slot-holders");
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, "run-"));
  const ownerFile = path.join(directory, "owner.json");
  await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid }));
  const holderPath = path.join(directory, "slot-holder-source.mjs");
  await fs.writeFile(holderPath, `import ${JSON.stringify(pathToFileURL(source).href)};\n`);
  return {
    holderPath,
    async close() {
      await fs.rm(ownerFile, { force: true });
      const deadline = now() + 4_000;
      while (true) {
        const live = [];
        for (const name of await fs.readdir(directory)) {
          if (!/^\d+\.json$/.test(name)) continue;
          const holder = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
          if (identity(holder.pid) === holder.started) live.push(holder);
        }
        if (!live.length) break;
        if (now() >= deadline) throw new Error(`test holders did not exit: ${live.map(h => h.socketPath).join(", ")}`);
        await delay(25);
      }
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

// Only the source fixture uses this lifetime; real holders retain work.
export function ownTestHolder() {
  const killGroup = () => process.kill(-process.pid, "SIGKILL");
  process.once("SIGTERM", () => realSetTimeout(killGroup, 250));
  const launcher = process.env.SEAM_SLOT_HOLDER_PATH;
  if (!launcher || path.resolve(launcher) === source) return;
  const directory = path.dirname(launcher);
  const ownerFile = path.join(directory, "owner.json");
  let owner;
  try { owner = JSON.parse(readFileSync(ownerFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") { killGroup(); return; } throw error; }
  const started = identity(owner.pid);
  writeFileSync(path.join(directory, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, started: identity(process.pid), socketPath: process.argv[2],
  }));
  realSetInterval(() => {
    if (!started || identity(owner.pid) !== started) { killGroup(); return; }
    try { readFileSync(ownerFile); }
    catch (error) { if (error.code === "ENOENT") killGroup(); else throw error; }
  }, 100).unref();
}
