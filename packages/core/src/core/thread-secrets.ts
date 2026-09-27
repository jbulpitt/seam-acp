/**
 * Temporary per-thread secrets for `/seamadmin upload secret`.
 *
 * Values live as 0600 files under `<dataDir>/secrets/<threadId>/<name>`
 * until the TTL sweep removes them.
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
  absPath?: string;
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

export async function recordThreadSecretPath(
  dataDir: string,
  threadId: string,
  name: string,
  absPath: string,
  bytes: number
): Promise<{ absPath: string; name: string }> {
  const safe = assertSecretName(name);
  const dir = threadSecretsDir(dataDir, threadId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const meta: ThreadSecretMeta = {
    name: safe,
    createdUtc: new Date().toISOString(),
    bytes,
    absPath,
  };
  const metaPath = path.join(dir, `${safe}${META}`);
  await fsp.writeFile(metaPath, JSON.stringify(meta), { mode: 0o600 });
  await fsp.chmod(metaPath, 0o600);
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
  const listed = new Set<string>();
  for (const metaFile of names.filter((n) => n.endsWith(META))) {
    const fallbackName = metaFile.slice(0, -META.length);
    let createdUtc = "";
    let name = fallbackName;
    let absPath = path.join(dir, fallbackName);
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(dir, metaFile), "utf8")) as ThreadSecretMeta;
      createdUtc = meta.createdUtc ?? "";
      name = meta.name ?? fallbackName;
      absPath = meta.absPath ?? absPath;
    } catch {
      // Keep the local-path fallback.
    }
    listed.add(fallbackName);
    out.push({ name, absPath, createdUtc });
  }
  for (const name of names.filter((n) => !n.endsWith(META) && !listed.has(n))) {
    out.push({ name, absPath: path.join(dir, name), createdUtc: "" });
  }
  return out;
}

export function secretHarnessRules(
  secrets: Array<{ name: string; absPath: string }>
): string[] {
  if (secrets.length === 0) return [];
  return secrets.map(
    (s) =>
      `A temporary secret named \`${s.name}\` is at \`${s.absPath}\`. Read the file if you need the value. Never echo, quote, or restate the contents. It will be deleted about an hour after upload.`
  );
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
      const secretNames = new Set(
        files.map((file) => file.endsWith(META) ? file.slice(0, -META.length) : file)
      );
      for (const name of secretNames) {
        const abs = path.join(dir, name);
        const metaPath = abs + META;
        try {
          const st = await fsp.stat(abs).catch(() => fsp.stat(metaPath));
          if (st.mtimeMs < cutoff) {
            await fsp.rm(abs, { force: true });
            await fsp.rm(metaPath, { force: true });
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
