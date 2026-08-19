/**
 * One-shot per-thread secrets for `/seam upload secret`.
 *
 * Values live as 0600 files under `<dataDir>/secrets/<threadId>/<name>`.
 * The agent is told the PATH only (harness). After the next live turn in that
 * thread finishes, the files are deleted. A TTL sweep is the backstop if no
 * turn happens.
 *
 * Detecting "the agent read the file" is unreliable (no atime, no ACP hook),
 * so turn-end is the consume event — not a memory register (those die on
 * restart and duplicate the file store).
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

export const SECRET_TTL_MS = 60 * 60 * 1000; // 1h
const META = ".meta.json";

export function secretsRoot(dataDir: string): string {
  return path.join(dataDir, "secrets");
}

export function threadSecretsDir(dataDir: string, threadId: string): string {
  return path.join(secretsRoot(dataDir), threadId);
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function assertSecretName(name: string): string {
  const n = (name ?? "").trim();
  if (!NAME_RE.test(n)) {
    throw new Error(
      "Secret name must be 1–64 characters of A–Z a–z 0–9 . _ -"
    );
  }
  return n;
}

export interface ThreadSecretMeta {
  name: string;
  createdUtc: string;
  bytes: number;
}

export async function writeThreadSecret(
  dataDir: string,
  threadId: string,
  name: string,
  value: string | Buffer
): Promise<{ absPath: string; name: string }> {
  const safe = assertSecretName(name);
  const dir = threadSecretsDir(dataDir, threadId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const absPath = path.join(dir, safe);
  const buf = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  await fsp.writeFile(absPath, buf, { mode: 0o600 });
  const meta: ThreadSecretMeta = {
    name: safe,
    createdUtc: new Date().toISOString(),
    bytes: buf.byteLength,
  };
  await fsp.writeFile(path.join(dir, `${safe}${META}`), JSON.stringify(meta), {
    mode: 0o600,
  });
  return { absPath, name: safe };
}

export async function listThreadSecrets(
  dataDir: string,
  threadId: string
): Promise<Array<{ name: string; absPath: string; createdUtc: string }>> {
  const dir = threadSecretsDir(dataDir, threadId);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; absPath: string; createdUtc: string }> = [];
  for (const n of names) {
    if (n.endsWith(META)) continue;
    const metaPath = path.join(dir, `${n}${META}`);
    let createdUtc = "";
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, "utf8")) as ThreadSecretMeta;
      createdUtc = meta.createdUtc ?? "";
    } catch {
      /* missing meta — still list */
    }
    out.push({ name: n, absPath: path.join(dir, n), createdUtc });
  }
  return out;
}

export function secretHarnessRules(
  secrets: Array<{ name: string; absPath: string }>
): string[] {
  if (secrets.length === 0) return [];
  return secrets.map(
    (s) =>
      `A one-shot secret named \`${s.name}\` is at \`${s.absPath}\`. Read the file if you need the value. Never echo, quote, or restate the contents. It will be deleted when this turn ends.`
  );
}

/** Delete every secret for this thread (end-of-turn consume). */
export async function consumeThreadSecrets(
  dataDir: string,
  threadId: string
): Promise<void> {
  const dir = threadSecretsDir(dataDir, threadId);
  await fsp.rm(dir, { recursive: true, force: true });
}

/** Drop secret files older than TTL. Safe to call from the sentinel poller. */
export async function sweepExpiredSecrets(
  dataDir: string,
  maxAgeMs = SECRET_TTL_MS
): Promise<void> {
  const root = secretsRoot(dataDir);
  let threads: string[];
  try {
    threads = await fsp.readdir(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    threads.map(async (tid) => {
      const dir = path.join(root, tid);
      let files: string[];
      try {
        files = await fsp.readdir(dir);
      } catch {
        return;
      }
      for (const f of files) {
        if (f.endsWith(META)) continue;
        const abs = path.join(dir, f);
        try {
          const st = await fsp.stat(abs);
          if (st.mtimeMs < cutoff) {
            await fsp.rm(abs, { force: true });
            await fsp.rm(abs + META, { force: true });
          }
        } catch {
          /* ignore */
        }
      }
      try {
        const left = await fsp.readdir(dir);
        if (left.length === 0) await fsp.rmdir(dir);
      } catch {
        /* ignore */
      }
    })
  );
}
