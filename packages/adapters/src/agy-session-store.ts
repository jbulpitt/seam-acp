import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const AGY_SESSION_STORE_VERSION = 1 as const;
export const AGY_SESSION_BACKEND = "agy-native-language-server-v1" as const;

export interface AgyPersistedSession {
  backend: typeof AGY_SESSION_BACKEND;
  cascadeId?: string;
  maxStepIndex: number;
  cwd?: string;
  modelId?: string;
  updatedAt?: string;
}

interface AgySessionDocument {
  schemaVersion: typeof AGY_SESSION_STORE_VERSION;
  backend: typeof AGY_SESSION_BACKEND;
  sessions: Record<string, AgyPersistedSession>;
}

export class AgySessionStoreError extends Error {
  constructor(
    readonly code: "busy" | "corrupt" | "invalid" | "write_failed",
    message: string,
  ) {
    super(`AGY session persistence failed (${code}): ${message}`);
    this.name = "AgySessionStoreError";
  }
}

const writeTails = new Map<string, Promise<void>>();

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function parseRecord(value: unknown, legacy: boolean): AgyPersistedSession {
  if (legacy && nonEmpty(value)) {
    return { backend: AGY_SESSION_BACKEND, cascadeId: value, maxStepIndex: -1 };
  }
  if (!isObject(value) || !hasOnly(value, [
    "backend", "cascadeId", "maxStepIndex", "cwd", "modelId", "updatedAt",
  ])) {
    throw new Error("unrecognized session record");
  }
  if ((!legacy || value.backend !== undefined) && value.backend !== AGY_SESSION_BACKEND) {
    throw new Error("session record belongs to another backend");
  }
  if (!Number.isInteger(value.maxStepIndex) || Number(value.maxStepIndex) < -1) {
    throw new Error("invalid progress marker");
  }
  for (const key of ["cascadeId", "cwd", "modelId"] as const) {
    if (value[key] !== undefined && !nonEmpty(value[key])) {
      throw new Error(`invalid ${key}`);
    }
  }
  if (value.updatedAt !== undefined && (
    !nonEmpty(value.updatedAt) || Number.isNaN(Date.parse(value.updatedAt))
  )) {
    throw new Error("invalid updatedAt");
  }
  return {
    backend: AGY_SESSION_BACKEND,
    ...(value.cascadeId !== undefined ? { cascadeId: value.cascadeId as string } : {}),
    maxStepIndex: Number(value.maxStepIndex),
    ...(value.cwd !== undefined ? { cwd: value.cwd as string } : {}),
    ...(value.modelId !== undefined ? { modelId: value.modelId as string } : {}),
    ...(value.updatedAt !== undefined ? { updatedAt: value.updatedAt as string } : {}),
  };
}

function parseDocument(value: unknown): AgySessionDocument {
  if (!isObject(value)) throw new Error("store root is not an object");
  const versioned = Object.prototype.hasOwnProperty.call(value, "schemaVersion");
  let entries: Record<string, unknown>;
  if (versioned) {
    if (!hasOnly(value, ["schemaVersion", "backend", "sessions"])) {
      throw new Error("store root contains unknown fields");
    }
    if (value.schemaVersion !== AGY_SESSION_STORE_VERSION) {
      throw new Error("unsupported store schema");
    }
    if (value.backend !== AGY_SESSION_BACKEND) {
      throw new Error("store belongs to another backend");
    }
    if (!isObject(value.sessions)) throw new Error("sessions is not an object");
    entries = value.sessions;
  } else {
    entries = value;
  }
  const sessions: Record<string, AgyPersistedSession> = {};
  for (const [sessionId, record] of Object.entries(entries)) {
    if (!nonEmpty(sessionId)) throw new Error("empty session id");
    sessions[sessionId] = parseRecord(record, !versioned);
  }
  return {
    schemaVersion: AGY_SESSION_STORE_VERSION,
    backend: AGY_SESSION_BACKEND,
    sessions,
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Versioned, failure-atomic native AGY session mapping.
 *
 * A module queue serializes writers in this process. A lock directory extends
 * that ownership across same-host processes; a live owner is never bypassed.
 * Only the mutation that cannot acquire ownership is refused, so already
 * loaded sessions and other adapters remain available.
 */
export class AgySessionStore {
  private readonly lockDir: string;
  private readonly recoveryDir: string;

  constructor(
    readonly file: string,
    private readonly legacyFile?: string,
    private readonly lockTimeoutMs = 2_000,
  ) {
    this.lockDir = `${file}.lock`;
    this.recoveryDir = `${file}.lock-recovery`;
  }

  async get(sessionId: string): Promise<AgyPersistedSession | undefined> {
    const record = (await this.readDocument()).sessions[sessionId];
    return record ? { ...record } : undefined;
  }

  async list(): Promise<Readonly<Record<string, AgyPersistedSession>>> {
    return Object.fromEntries(
      Object.entries((await this.readDocument()).sessions)
        .map(([id, record]) => [id, { ...record }]),
    );
  }

  async put(
    sessionId: string,
    state: Omit<AgyPersistedSession, "backend" | "updatedAt">,
  ): Promise<void> {
    if (!nonEmpty(sessionId) || !nonEmpty(state.cwd) || !nonEmpty(state.modelId)) {
      throw new AgySessionStoreError("invalid", "session id, cwd, and model id are required");
    }
    if (!Number.isInteger(state.maxStepIndex) || state.maxStepIndex < -1) {
      throw new AgySessionStoreError("invalid", "progress marker must be an integer >= -1");
    }
    await this.mutate((document) => {
      document.sessions[sessionId] = {
        backend: AGY_SESSION_BACKEND,
        ...(state.cascadeId ? { cascadeId: state.cascadeId } : {}),
        maxStepIndex: state.maxStepIndex,
        cwd: state.cwd,
        modelId: state.modelId,
        updatedAt: new Date().toISOString(),
      };
      return true;
    });
  }

  async delete(
    sessionId: string,
    validate?: (record: Readonly<AgyPersistedSession>) => void,
  ): Promise<AgyPersistedSession | undefined> {
    let deleted: AgyPersistedSession | undefined;
    await this.mutate((document) => {
      const record = document.sessions[sessionId];
      if (!record) return false;
      validate?.(record);
      deleted = { ...record };
      delete document.sessions[sessionId];
      return true;
    });
    return deleted;
  }

  private async mutate(mutator: (document: AgySessionDocument) => boolean): Promise<void> {
    const previous = writeTails.get(this.file) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const release = await this.acquireLock();
      try {
        const document = await this.readDocument();
        if (mutator(document)) await this.writeDocument(document);
      } finally {
        await release();
      }
    });
    writeTails.set(this.file, current);
    try {
      await current;
    } catch (error) {
      if (error instanceof AgySessionStoreError) throw error;
      throw new AgySessionStoreError("write_failed", "atomic mapping commit did not complete");
    } finally {
      if (writeTails.get(this.file) === current) writeTails.delete(this.file);
    }
  }

  private async readDocument(): Promise<AgySessionDocument> {
    let source = this.file;
    let raw: string;
    try {
      raw = await fs.readFile(source, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!this.legacyFile) return parseDocument({});
      source = this.legacyFile;
      try {
        raw = await fs.readFile(source, "utf8");
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") {
          return parseDocument({});
        }
        throw legacyError;
      }
    }
    try {
      return parseDocument(JSON.parse(raw));
    } catch {
      const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
      const quarantine = `${source}.corrupt-${digest}`;
      await fs.copyFile(source, quarantine, fsConstants.COPYFILE_EXCL).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      // Refuse only sessions depending on this unreadable map. Its original
      // bytes remain untouched, and other adapters/bindings keep working.
      throw new AgySessionStoreError(
        "corrupt",
        `unreadable mapping preserved as ${path.basename(quarantine)}`,
      );
    }
  }

  private async writeDocument(document: AgySessionDocument): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(
      dir,
      `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temp, this.file);
      const directory = await fs.open(dir, "r");
      try {
        await directory.sync();
      } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EBADF"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )) throw error;
      } finally {
        await directory.close();
      }
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomUUID();
    while (Date.now() <= deadline) {
      if (await fs.access(this.recoveryDir).then(() => true).catch(() => false)) {
        await delay(10);
        continue;
      }
      try {
        await fs.mkdir(this.lockDir, { mode: 0o700 });
        if (await fs.access(this.recoveryDir).then(() => true).catch(() => false)) {
          await fs.rm(this.lockDir, { recursive: true, force: true });
          await delay(10);
          continue;
        }
        try {
          await fs.writeFile(
            path.join(this.lockDir, "owner.json"),
            `${JSON.stringify({ pid: process.pid, token })}\n`,
            { encoding: "utf8", flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          // A lock without an owner can never be released safely. Remove only
          // the directory this process just created; existing sessions and
          // every other adapter remain available.
          await fs.rm(this.lockDir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        return async () => {
          try {
            const owner = JSON.parse(
              await fs.readFile(path.join(this.lockDir, "owner.json"), "utf8"),
            ) as { token?: string };
            if (owner.token === token) {
              await fs.rm(this.lockDir, { recursive: true, force: true });
            }
          } catch { /* already recovered or removed */ }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.recoverDeadOwner();
      }
      await delay(10);
    }
    throw new AgySessionStoreError("busy", "another live process owns the mapping");
  }

  private async recoverDeadOwner(): Promise<void> {
    let owner: { pid?: number; token?: string };
    try {
      owner = JSON.parse(
        await fs.readFile(path.join(this.lockDir, "owner.json"), "utf8"),
      ) as { pid?: number; token?: string };
    } catch {
      return;
    }
    if (!Number.isInteger(owner.pid) || processAlive(owner.pid!)) return;
    try {
      await fs.mkdir(this.recoveryDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    try {
      const current = JSON.parse(
        await fs.readFile(path.join(this.lockDir, "owner.json"), "utf8"),
      ) as { pid?: number; token?: string };
      if (current.token === owner.token && Number.isInteger(current.pid) && !processAlive(current.pid!)) {
        await fs.rm(this.lockDir, { recursive: true, force: true });
      }
    } catch { /* another owner already released */ }
    finally {
      await fs.rm(this.recoveryDir, { recursive: true, force: true });
    }
  }
}
