import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const SECRET_META_SUFFIX = ".meta.json";
const SECRET_SWEEP_MS = 60_000;

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SAFE_SEGMENT.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error(`${label} contains unsupported characters`);
  }
  return trimmed;
}

function attachmentCwd(requested: string, fallback: string): string {
  return existsSync(requested) ? requested : fallback;
}

export async function writeHostAttachment(opts: {
  requestedCwd: string;
  fallbackCwd: string;
  filename: string;
  base64: string;
}): Promise<{ path: string }> {
  const cwd = attachmentCwd(opts.requestedCwd, opts.fallbackCwd);
  const safe = path.basename(opts.filename).replace(/[\/\\]/g, "_");
  const dir = path.join(cwd, ".seam-attachments");
  await fsp.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, safe);
  await fsp.writeFile(absPath, Buffer.from(opts.base64, "base64"));
  return { path: absPath };
}

export function hostSecretsRoot(home = os.homedir()): string {
  return path.join(home, ".seam", "thread-secrets");
}

export async function writeHostSecret(opts: {
  threadId: string;
  name: string;
  base64: string;
  expiresAt: number;
  root?: string;
}): Promise<{ path: string }> {
  const threadId = safeSegment(opts.threadId, "thread id");
  const name = safeSegment(opts.name, "secret name");
  if (!Number.isFinite(opts.expiresAt)) throw new Error("secret expiry is required");
  const dir = path.join(opts.root ?? hostSecretsRoot(), threadId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
  const absPath = path.join(dir, name);
  const metaPath = absPath + SECRET_META_SUFFIX;
  try {
    await fsp.writeFile(absPath, Buffer.from(opts.base64, "base64"), { mode: 0o600 });
    await fsp.chmod(absPath, 0o600);
    await fsp.writeFile(metaPath, JSON.stringify({ expiresAt: opts.expiresAt }), { mode: 0o600 });
    await fsp.chmod(metaPath, 0o600);
  } catch (error) {
    await Promise.allSettled([fsp.rm(absPath, { force: true }), fsp.rm(metaPath, { force: true })]);
    throw error;
  }
  return { path: absPath };
}

export async function sweepExpiredHostSecrets(
  root = hostSecretsRoot(),
  now = Date.now()
): Promise<void> {
  let threadIds: string[];
  try {
    threadIds = await fsp.readdir(root);
  } catch {
    return;
  }
  await Promise.all(threadIds.map(async (threadId) => {
    const dir = path.join(root, threadId);
    let files: string[];
    try {
      files = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const file of files.filter((entry) => entry.endsWith(SECRET_META_SUFFIX))) {
      const metaPath = path.join(dir, file);
      try {
        const meta = JSON.parse(await fsp.readFile(metaPath, "utf8")) as { expiresAt?: unknown };
        if (typeof meta.expiresAt !== "number" || meta.expiresAt > now) continue;
        const secretPath = metaPath.slice(0, -SECRET_META_SUFFIX.length);
        await Promise.allSettled([
          fsp.rm(secretPath, { force: true }),
          fsp.rm(metaPath, { force: true }),
        ]);
      } catch {
        // An unreadable record is left in place rather than guessing its expiry.
      }
    }
    try {
      if ((await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir);
    } catch {
      // Another write or sweep won the race.
    }
  }));
}

export function startHostSecretSweeper(root = hostSecretsRoot()): () => void {
  void sweepExpiredHostSecrets(root);
  const timer = setInterval(() => void sweepExpiredHostSecrets(root), SECRET_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
