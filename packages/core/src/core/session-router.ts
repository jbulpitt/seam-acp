import { AgentRuntime } from "../agents/agent-runtime.js";
import type { AgentProfile } from "@seam/adapters";
import type { Logger } from "../lib/logger.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRecord, PermissionPolicyMode } from "./types.js";
import { defaultSessionConfig, resolvePermissionMode } from "./types.js";
import { makeSessionId } from "./session-store.js";
import { resolveChannelPreset } from "../config.js";
import type { ChannelPreset, ThreadPreset } from "../config.js";
import type { SeamTokenRegistry } from "./mcp/token-registry.js";
import { buildSeamMcpServerEntry } from "./mcp/seam-mcp-server.js";
import type {
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

/**
 * Wiring for the per-session seam-MCP surface. The router mints a token per
 * runtime start (mapping it to the session id) and injects an http mcpServers
 * entry carrying that token; it revokes the token when the runtime is
 * invalidated. `getPort` is a late-bound getter because the shared server binds
 * its ephemeral port after the router is constructed.
 */
export interface SeamMcpWiring {
  registry: SeamTokenRegistry;
  getPort: () => number | undefined;
  /** Full MCP URL for a remote (bridge) spawn; never 127.0.0.1 when that is local-only. */
  getPublicUrl?: () => string | undefined;
  /** True when this session's agent process runs on a paired bridge (#84). */
  isRemoteSession?: (sessionId: string) => boolean;
}

export type AskUserFn = (
  record: SessionRecord,
  req: RequestPermissionRequest
) => Promise<RequestPermissionResponse>;

/**
 * Which configuration layer supplied an effective value. Mirrors the precedence
 * the runtime actually applies in `startRuntime`: a channel/thread preset (the
 * presets-file source of truth) wins over the DB-backed session config, which
 * wins over the bot-wide default. This provenance is the genuinely useful part
 * of `config_describe` (#58 P1): it answers "why is my cwd/model wrong?" — and
 * it is the same machinery every future mutation response needs for the
 * silent-no-op traps (report the EFFECTIVE value + which layer won, not the
 * value that was requested).
 */
export type ConfigLayer =
  | "thread preset"
  | "channel preset"
  | "session config"
  | "default";

export interface ResolvedSetting<T> {
  value: T;
  source: ConfigLayer;
}

/** Effective, provenance-tagged configuration for one session/thread. */
export interface ConfigDescription {
  sessionId: string;
  channelRef: string;
  parentRef: string | null;
  agent: ResolvedSetting<string>;
  model: ResolvedSetting<string>;
  /** `value` is null when no effort applies (agent has none / nothing set). */
  effort: ResolvedSetting<string | null>;
  cwd: ResolvedSetting<string>;
  permission: ResolvedSetting<PermissionPolicyMode>;
  /** Whether the calling channel is locked (read-only over MCP; D2). */
  locked: boolean;
  /**
   * Whether this thread is detached (#80): allowlisted chat, no bot replies,
   * no session bind. `true` is always sourced from the thread preset; `false`
   * is the default (attached). Not a channel-level flag.
   */
  detached: ResolvedSetting<boolean>;
  /**
   * Set when a preset requested an effort level the resolved agent cannot honor
   * (Trap 2). The preset value is silently dropped at runtime; surfacing it here
   * keeps `config_describe` from reporting a personality the agent won't deliver.
   */
  effortIgnoredNote?: string;
}

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
  private readonly defaultPermissionMode: PermissionPolicyMode;
  private readonly mcpServers: McpServer[];
  private readonly seamMcp?: SeamMcpWiring;
  private readonly channelPresets: Map<string, ChannelPreset>;
  private readonly threadPresets: Map<string, ThreadPreset>;
  private askUser?: AskUserFn;

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
    defaultPermissionMode?: PermissionPolicyMode;
    mcpServers?: McpServer[];
    seamMcp?: SeamMcpWiring;
    channelPresets?: Map<string, ChannelPreset>;
    threadPresets?: Map<string, ThreadPreset>;
  }) {
    this.logger = opts.logger.child({ comp: "session-router" });
    this.store = opts.store;
    this.profileById = new Map(opts.profiles.map((p) => [p.id, p]));
    this.defaultAgentId = opts.defaultAgentId;
    this.defaultModel = opts.defaultModel;
    this.defaultPermissionMode = opts.defaultPermissionMode ?? "ask";
    this.mcpServers = opts.mcpServers ?? [];
    this.seamMcp = opts.seamMcp;
    this.channelPresets = opts.channelPresets ?? new Map();
    this.threadPresets = opts.threadPresets ?? new Map();
  }

  /**
   * Provide the callback that prompts a real user for an approval decision.
   * Used only when a session's permission policy is "ask". If unset, "ask"
   * behaves like "deny".
   */
  setAskUser(fn: AskUserFn): void {
    this.askUser = fn;
  }

  /** List the registered agent profiles. */
  listProfiles(): AgentProfile[] {
    return [...this.profileById.values()];
  }

  /** Look up a registered profile by id, or undefined if not found. */
  getProfile(id: string): AgentProfile | undefined {
    return this.profileById.get(id);
  }

  /**
   * Compute the EFFECTIVE agent/model/effort/cwd/permission for a session and,
   * for each, which layer won (channel preset vs thread preset vs session config
   * vs bot default). Read-only. This deliberately re-derives the exact same
   * precedence `startRuntime` applies, so the description can never drift from
   * what actually runs — it is the single source of truth for #58 P1's
   * `config_describe` and for the silent-no-op traps a mutation surface needs.
   */
  describeConfig(record: SessionRecord): ConfigDescription {
    const chan = record.parentRef
      ? this.channelPresets.get(record.parentRef)
      : undefined;
    const thread = this.threadPresets.get(record.channelRef);
    const cfg = this.store.readConfig(record);

    // agent — preset.agent ?? record.agentId (startRuntime).
    const agent: ResolvedSetting<string> = thread?.agent
      ? { value: thread.agent.value, source: "thread preset" }
      : chan?.agent
        ? { value: chan.agent.value, source: "channel preset" }
        : { value: record.agentId, source: "session config" };

    // model — preset.model ?? cfg.model ?? defaultModel.
    const model: ResolvedSetting<string> = thread?.model
      ? { value: thread.model.value, source: "thread preset" }
      : chan?.model
        ? { value: chan.model.value, source: "channel preset" }
        : cfg.model
          ? { value: cfg.model, source: "session config" }
          : { value: this.defaultModel, source: "default" };

    // effort — a preset effort only wins if the RESOLVED agent supports that
    // exact level; otherwise it is dropped and cfg.reasoningEffort applies
    // (Trap 2). Mirrors startRuntime's `presetEffortUsable` gate exactly.
    const profile = this.profileById.get(agent.value);
    const presetEffort = thread?.effort ?? chan?.effort;
    const presetEffortSource: ConfigLayer | undefined = thread?.effort
      ? "thread preset"
      : chan?.effort
        ? "channel preset"
        : undefined;
    const presetEffortUsable = !!(
      presetEffort?.value &&
      profile?.effort &&
      profile.effort.mechanism !== "none" &&
      profile.effort.levels.includes(presetEffort.value)
    );
    let effort: ResolvedSetting<string | null>;
    let effortIgnoredNote: string | undefined;
    if (presetEffortUsable && presetEffort && presetEffortSource) {
      effort = { value: presetEffort.value, source: presetEffortSource };
    } else {
      effort = cfg.reasoningEffort
        ? { value: cfg.reasoningEffort, source: "session config" }
        : { value: null, source: "default" };
      if (presetEffort?.value && !presetEffortUsable) {
        effortIgnoredNote =
          `${presetEffortSource} sets effort "${presetEffort.value}", but agent ` +
          `"${agent.value}" does not support that level — it is ignored; ` +
          `effective effort is ${effort.value ? `"${effort.value}"` : "none"}.`;
      }
    }

    // cwd — preset.cwd ?? record.repoPath ?? process.cwd().
    const cwd: ResolvedSetting<string> = thread?.cwd
      ? { value: thread.cwd.value, source: "thread preset" }
      : chan?.cwd
        ? { value: chan.cwd.value, source: "channel preset" }
        : record.repoPath
          ? { value: record.repoPath, source: "session config" }
          : { value: process.cwd(), source: "default" };

    // permission — resolvePermissionMode layering (session policy, then legacy
    // auto-approve, then bot default). Presets do not carry permission.
    const permission: ResolvedSetting<PermissionPolicyMode> = cfg.permissionPolicy
      ? { value: cfg.permissionPolicy, source: "session config" }
      : cfg.autoApprovePermissions === true
        ? { value: "always", source: "session config" }
        : { value: this.defaultPermissionMode, source: "default" };

    const detached: ResolvedSetting<boolean> = thread?.detached
      ? { value: true, source: "thread preset" }
      : { value: false, source: "default" };

    return {
      sessionId: record.id,
      channelRef: record.channelRef,
      parentRef: record.parentRef,
      agent,
      model,
      effort,
      cwd,
      permission,
      locked: chan?.locked ?? false,
      detached,
      ...(effortIgnoredNote ? { effortIgnoredNote } : {}),
    };
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

    // Stamp the channel/thread preset into the record at creation so the
    // persisted agent/model/cwd match what will actually run. Without this the
    // record gets the global defaults (e.g. copilot / DEFAULT_MODEL / REPOS_ROOT)
    // while startRuntime silently overrides them from the locked preset — a
    // split brain where the agent runs correctly but the record and status card
    // (and every `getProfile(record.agentId)` capability/usage lookup) show the
    // wrong agent. The runtime still re-resolves the preset each start, so the
    // file remains the source of truth; this just keeps the record honest.
    const preset = resolveChannelPreset(
      { channelPresets: this.channelPresets, threadPresets: this.threadPresets },
      opts.parentRef ?? undefined,
      opts.channelRef
    );
    const cfg = defaultSessionConfig(
      preset.model?.value ?? this.defaultModel,
      this.defaultPermissionMode
    );
    const now = new Date().toISOString();
    // We don't yet know the ACP session id — it will be filled in by the
    // first runtime start. Store an empty marker for now.
    const record: SessionRecord = {
      id,
      platform: opts.platform,
      channelRef: opts.channelRef,
      parentRef: opts.parentRef ?? null,
      agentId: preset.agent?.value ?? this.defaultAgentId,
      acpSessionId: "",
      repoPath: preset.cwd?.value ?? opts.cwd,
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

  /** Drop a runtime from the cache (e.g. on session/not-found).
   *  #76: MUST NOT clear turn-resume markers. User cancel and host shutdown
   *  both land here via dispose(); wiping markers would make resume a
   *  silent no-op on every graceful reboot. Command layer clears them. */
  async invalidate(sessionId: string, opts?: { clearAcpSession?: boolean }): Promise<void> {
    // Revoke this session's seam-MCP token — the runtime is going away, so any
    // outstanding token must stop resolving. A later start re-mints a fresh one.
    this.seamMcp?.registry.revokeSession(sessionId);
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      this.runtimes.delete(sessionId);
      try {
        await rt.dispose();
      } catch (err) {
        this.logger.warn({ err, sessionId }, "dispose during invalidate failed");
      }
    }
    if (opts?.clearAcpSession) {
      const record = this.store.get(sessionId);
      if (record?.acpSessionId) {
        // For agy, the stored acp_session_id is the durable key into the
        // agy-sessions.json cascade mapping. Per fix 17670d1, each `agy -p`
        // spawns a fresh language server, so the cascade survives a cancel /
        // session-gone and the agent resumes its full context next turn.
        // Clearing it here would orphan that preserved mapping: the next turn
        // sees an empty acp, calls newSession → a brand-new cascade, and the
        // reply is dropped / the thread goes amnesiac (the 2026-06-23 empty-
        // response bug). So preserve it for agy; only clear for agents whose
        // ACP session genuinely dies on session-gone (claude / copilot).
        if (record.agentId?.startsWith("agy")) {
          this.logger.info(
            { sessionId },
            "preserving agy acp/cascade id across invalidate (durable across agy -p spawns)"
          );
        } else {
          this.store.upsert({ ...record, acpSessionId: "", updatedUtc: new Date().toISOString() });
          this.logger.info({ sessionId }, "cleared stored acp session id");
        }
      }
    }
  }

  /** Cleanly abort the active turn for a session without terminating the agent process. */
  /** Abort the active turn for a session. Graceful by default (ACP cancel only,
   *  which a healthy turn honors). With `force`, escalate: if the turn is still
   *  running shortly after the cancel (a hung turn ignoring it), invalidate the
   *  runtime — which disposes it and force-kills the agent process group.
   *  Returns "idle" | "cancelled" | "killed". */
  async abortTurn(
    sessionId: string,
    opts?: { force?: boolean; graceMs?: number }
  ): Promise<"idle" | "cancelled" | "killed"> {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return "idle";
    const wasBusy = rt.busy;
    await rt.cancel().catch(() => {});
    this.logger.info({ sessionId }, "sent cancel signal to agent runtime");
    if (!wasBusy) return "idle";
    if (!opts?.force) return "cancelled";

    // Escalation: give the graceful cancel a moment to actually end the turn.
    const graceMs = opts.graceMs ?? 3000;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!rt.busy) return "cancelled";
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!rt.busy) return "cancelled";
    // Still hung — force-kill by disposing the runtime (keeps the session id so
    // the next message can resume cleanly).
    this.logger.warn({ sessionId }, "turn did not cancel; force-killing runtime");
    await this.invalidate(sessionId, { clearAcpSession: false });
    return "killed";
  }

  /** Force-kill EVERY live runtime (and its agent process group). Returns how
   *  many were killed. Session ids are preserved so threads resume cleanly on
   *  their next message. Used by `/seam cancel scope:all`. */
  async killAll(opts?: { exceptId?: string }): Promise<number> {
    const ids = Array.from(this.runtimes.keys()).filter((id) => id !== opts?.exceptId);
    for (const id of ids) {
      await this.invalidate(id, { clearAcpSession: false }).catch((err) =>
        this.logger.warn({ err, id }, "killAll: invalidate failed")
      );
    }
    return ids.length;
  }

  /** Dispose all runtimes (graceful shutdown / SIGTERM).
   *  #76: MUST NOT clear turn-resume markers — shutdown is the event
   *  resume exists for. */
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

  /** The live runtime for this session, if one is already started. */
  getRuntime(sessionId: string): AgentRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  /** Whether a live turn is CURRENTLY running for this session (#73) — a DERIVED
   *  read over the runtime's internal `busy` flag, not new tracked state. False
   *  when no runtime is alive (nothing can be mid-turn without one), so a
   *  never-started or disposed thread truthfully reads idle. Companion to
   *  `hasRuntime`, which answers the weaker "runtime alive" question; this is the
   *  load-bearing signal `threads()` uses to steer send (pull-only) vs
   *  steer/handoff (interrupting). */
  isBusy(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.busy ?? false;
  }

  private async startRuntime(record: SessionRecord): Promise<AgentRuntime> {
    // Channel/thread presets are the source of truth for locked-down
    // channels: re-resolved on every runtime start (not just session
    // creation) so a stored record can never drift from the config file —
    // whatever's in CHANNEL_PRESETS_FILE wins, regardless of what's in the
    // DB. See resolveChannelPreset in config.ts.
    const preset = resolveChannelPreset(
      { channelPresets: this.channelPresets, threadPresets: this.threadPresets },
      record.parentRef ?? undefined,
      record.channelRef
    );

    const agentId = preset.agent?.value ?? record.agentId;
    const profile = this.profileById.get(agentId);
    if (!profile) {
      throw new Error(
        `Unknown agent profile "${agentId}" for session ${record.id}`
      );
    }
    const cfg = this.store.readConfig(record);
    const model = preset.model?.value ?? cfg.model ?? this.defaultModel;
    // Only honor a preset effort if this agent actually supports that level —
    // e.g. a channel preset might set "medium" but the locked agent has no
    // effort concept at all, in which case we silently fall back instead of
    // erroring.
    const presetEffortUsable =
      preset.effort?.value &&
      profile.effort &&
      profile.effort.mechanism !== "none" &&
      profile.effort.levels.includes(preset.effort.value);
    const effort = presetEffortUsable ? preset.effort!.value : cfg.reasoningEffort;
    const cwd = preset.cwd?.value ?? record.repoPath ?? process.cwd();

    // Per-session seam-MCP injection: mint a token for this session, map it to
    // the record id, and append an http mcpServers entry carrying it as the
    // X-Seam-Session header. The shared server reads that header per tool call
    // to resolve the caller back to this thread (#24). Token is revoked in
    // `invalidate`. A re-mint here (runtime restart) rotates the token, so any
    // stale one stops resolving immediately.
    let mcpServers = this.mcpServers;
    if (this.seamMcp) {
      const port = this.seamMcp.getPort();
      if (port !== undefined) {
        const token = this.seamMcp.registry.mint(record.id);
        const remote = this.seamMcp.isRemoteSession?.(record.id) === true;
        const publicUrl = remote ? this.seamMcp.getPublicUrl?.() : undefined;
        mcpServers = [
          ...this.mcpServers,
          buildSeamMcpServerEntry(port, token, publicUrl ? { url: publicUrl } : undefined),
        ];
      } else {
        this.logger.warn(
          { session: record.id },
          "seam-mcp enabled but server port not yet available; skipping injection"
        );
      }
    }

    const runtime = new AgentRuntime({
      profile,
      logger: this.logger.child({ session: record.id }),
      mcpServers,
      onDead: () => {
        // Involuntary death — #76: leave turn markers intact. This is an
        // interruption, not a cancellation. Recovery reattaches on the next
        // boot (or the next recoverInterruptedTurns pass).
        this.logger.info({ sessionId: record.id }, "agent process died; evicting runtime for auto-resume");
        this.seamMcp?.registry.revokeSession(record.id);
        this.runtimes.delete(record.id);
      },
      permissionPolicy: async (req) => {
        // Always re-read: the captured `cfg` would be stale if the user later
        // changes the policy via `/seam approve` while the runtime is alive.
        const fresh = this.store.readConfig(record);
        const mode = resolvePermissionMode(fresh, this.defaultPermissionMode);
        if (mode === "always") {
          const opt =
            req.options.find((o) => o.kind?.startsWith("allow_")) ??
            req.options[0];
          if (opt) {
            return {
              outcome: { outcome: "selected", optionId: opt.optionId },
            };
          }
          return { outcome: { outcome: "cancelled" } };
        }
        if (mode === "ask" && this.askUser) {
          try {
            return await this.askUser(record, req);
          } catch (err) {
            this.logger.warn({ err, sessionId: record.id }, "askUser failed; denying");
            return { outcome: { outcome: "cancelled" } };
          }
        }
        // mode === "deny" (or "ask" with no askUser wired)
        return { outcome: { outcome: "cancelled" } };
      },
    });

    // For non-Anthropic backends (Ollama Cloud, Z.ai), setModel() is rejected
    // by claude-agent-acp. Pass the model at spawn time via env vars instead.
    runtime.modelOverride = model;
    // For agents that accept reasoning effort via CLI flags (e.g. Grok
    // --reasoning-effort), pass it at spawn time.
    runtime.effortOverride = effort;
    await runtime.start();

    if (record.acpSessionId) {
      // Resume with a couple short retries. Right after a redeploy the agent
      // subprocess can still be spinning up when the first message lands, so
      // the first loadSession can fail transiently — and falling straight
      // through to newSession would overwrite the (good) acpSessionId and
      // detach the thread from its conversation. A brief escalating backoff
      // lets the agent finish starting before we give up.
      const RESUME_ATTEMPTS = 3;
      const RESUME_RETRY_MS = 400;
      for (let attempt = 1; attempt <= RESUME_ATTEMPTS; attempt++) {
        try {
          await runtime.loadSession({
            sessionId: record.acpSessionId,
            cwd,
            model,
            ...(effort ? { effort } : {}),
          });
          this.logger.debug(
            { sessionId: record.id, acpSessionId: record.acpSessionId, attempt },
            "resumed acp session"
          );
          return runtime;
        } catch (err) {
          const lastAttempt = attempt === RESUME_ATTEMPTS;
          this.logger.warn(
            { err, sessionId: record.id, attempt, lastAttempt },
            lastAttempt
              ? "session/load failed after retries, creating new session"
              : "session/load failed; retrying after short delay"
          );
          if (!lastAttempt) {
            await new Promise((r) => setTimeout(r, RESUME_RETRY_MS * attempt));
          }
        }
      }
    }

    const info = await runtime.newSession({
      cwd,
      model,
      ...(effort ? { effort } : {}),
    });
    // Persist the new ACP session id so we can resume on restart. Also sync the
    // caller's in-memory record: getOrStartRuntime receives the same record the
    // orchestrator reuses for the rest of the turn, and if it kept the empty
    // placeholder, a later config write (persistConfig spreads `...record`)
    // would upsert "" back over this id — silently unbinding the thread so the
    // NEXT restart resumes nothing and the user has to re-attach.
    record.acpSessionId = info.sessionId;
    this.store.upsert({
      ...record,
      updatedUtc: new Date().toISOString(),
    });
    return runtime;
  }
}
