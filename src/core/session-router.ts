import { AgentRuntime } from "../agents/agent-runtime.js";
import type { AgentProfile } from "../agents/agent-profile.js";
import type { Logger } from "../lib/logger.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRecord } from "./types.js";
import { defaultSessionConfig } from "./types.js";
import { makeSessionId } from "./session-store.js";

/**
 * Holds one AgentRuntime per chat session id, with:
 *  - a per-session creation lock so two concurrent messages don't both spawn
 *    new agents
 *  - a 30-second cooldown after a failed start so we don't hammer a broken
 *    agent
 *
 * This is a port of the runtime-management bits of SessionRuntimeManager.cs.
 */
export class SessionRouter {
  private readonly logger: Logger;
  private readonly store: SessionStore;
  private readonly profileById: Map<string, AgentProfile>;
  private readonly defaultAgentId: string;
  private readonly defaultModel: string;

  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly creationLocks = new Map<string, Promise<AgentRuntime>>();
  private readonly lastStartFailure = new Map<string, number>();
  private readonly startFailureCooldownMs = 30_000;

  constructor(opts: {
    logger: Logger;
    store: SessionStore;
    profiles: AgentProfile[];
    defaultAgentId: string;
    defaultModel: string;
  }) {
    this.logger = opts.logger.child({ comp: "session-router" });
    this.store = opts.store;
    this.profileById = new Map(opts.profiles.map((p) => [p.id, p]));
    this.defaultAgentId = opts.defaultAgentId;
    this.defaultModel = opts.defaultModel;
  }

  /** Look up or create the SessionRecord for a given chat channel. */
  ensureSessionRecord(opts: {
    platform: string;
    channelRef: string;
    parentRef?: string;
    cwd: string;
  }): SessionRecord {
    const id = makeSessionId(opts.platform, opts.channelRef);
    const existing = this.store.get(id);
    if (existing) return existing;

    const cfg = defaultSessionConfig(this.defaultModel);
    const now = new Date().toISOString();
    // We don't yet know the ACP session id — it will be filled in by the
    // first runtime start. Store an empty marker for now.
    const record: SessionRecord = {
      id,
      platform: opts.platform,
      channelRef: opts.channelRef,
      parentRef: opts.parentRef ?? null,
      agentId: this.defaultAgentId,
      acpSessionId: "",
      repoPath: opts.cwd,
      configJson: JSON.stringify(cfg),
      createdUtc: now,
      updatedUtc: now,
    };
    this.store.upsert(record);
    return record;
  }

  /**
   * Get (or start) the runtime for a session. Honors the per-session creation
   * lock and the post-failure cooldown.
   */
  async getOrStartRuntime(record: SessionRecord): Promise<AgentRuntime> {
    const cached = this.runtimes.get(record.id);
    if (cached) return cached;

    const inflight = this.creationLocks.get(record.id);
    if (inflight) return inflight;

    const lastFail = this.lastStartFailure.get(record.id);
    if (lastFail && Date.now() - lastFail < this.startFailureCooldownMs) {
      const wait = Math.ceil(
        (this.startFailureCooldownMs - (Date.now() - lastFail)) / 1000
      );
      throw new Error(
        `Agent recently failed to start; waiting ${wait}s before retry.`
      );
    }

    const promise = this.startRuntime(record).then(
      (rt) => {
        this.runtimes.set(record.id, rt);
        this.creationLocks.delete(record.id);
        this.lastStartFailure.delete(record.id);
        return rt;
      },
      (err) => {
        this.creationLocks.delete(record.id);
        this.lastStartFailure.set(record.id, Date.now());
        throw err;
      }
    );
    this.creationLocks.set(record.id, promise);
    return promise;
  }

  /** Drop a runtime from the cache (e.g. on session/not-found). */
  async invalidate(sessionId: string): Promise<void> {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    this.runtimes.delete(sessionId);
    try {
      await rt.dispose();
    } catch (err) {
      this.logger.warn({ err, sessionId }, "dispose during invalidate failed");
    }
  }

  /** Dispose all runtimes (graceful shutdown). */
  async disposeAll(): Promise<void> {
    const all = Array.from(this.runtimes.values());
    this.runtimes.clear();
    await Promise.all(
      all.map((rt) =>
        rt.dispose().catch((err) => {
          this.logger.warn({ err }, "dispose failed during shutdown");
        })
      )
    );
  }

  hasRuntime(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  private async startRuntime(record: SessionRecord): Promise<AgentRuntime> {
    const profile = this.profileById.get(record.agentId);
    if (!profile) {
      throw new Error(
        `Unknown agent profile "${record.agentId}" for session ${record.id}`
      );
    }
    const cfg = this.store.readConfig(record);
    const runtime = new AgentRuntime({
      profile,
      logger: this.logger.child({ session: record.id }),
      permissionPolicy: async (req) => {
        const allow = cfg.autoApprovePermissions === true;
        if (allow) {
          const opt =
            req.options.find((o) => o.kind?.startsWith("allow_")) ??
            req.options[0];
          if (opt) {
            return {
              outcome: { outcome: "selected", optionId: opt.optionId },
            };
          }
        }
        return { outcome: { outcome: "cancelled" } };
      },
    });

    await runtime.start();

    const cwd = record.repoPath ?? process.cwd();

    if (record.acpSessionId) {
      try {
        await runtime.loadSession({ sessionId: record.acpSessionId, cwd });
        this.logger.debug(
          { sessionId: record.id, acpSessionId: record.acpSessionId },
          "resumed acp session"
        );
        return runtime;
      } catch (err) {
        this.logger.warn(
          { err, sessionId: record.id },
          "session/load failed, creating new session"
        );
      }
    }

    const info = await runtime.newSession({
      cwd,
      model: cfg.model ?? this.defaultModel,
    });
    // Persist the new ACP session id so we can resume on restart.
    this.store.upsert({
      ...record,
      acpSessionId: info.sessionId,
      updatedUtc: new Date().toISOString(),
    });
    return runtime;
  }
}
