import { AgentRuntime } from "../agents/agent-runtime.js";
import type { AgentProfile } from "@seam/adapters";
import type { Logger } from "../lib/logger.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRecord, PermissionPolicyMode, StatusCardStyle } from "./types.js";
import { defaultSessionConfig, resolvePermissionMode } from "./types.js";
import { makeSessionId } from "./session-store.js";
import { resolveChannelPreset, resolveThreadLocation } from "../config.js";
import type { ChannelPreset, ThreadPreset } from "../config.js";
import { buildProjectMcpServers } from "../mcp.js";
import { retiredAgentMessage } from "./retired-agents.js";

import type { SeamTokenRegistry } from "./mcp/token-registry.js";
import type {
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  planSeamMcpInjection,
  spawnRemoteSlot,
  type MuxHandle,
} from "./remote-spawn.js";

/**
 * Wiring for the per-session seam-MCP surface. The token identifies the
 * Discord session, not the ACP subprocess — start reuses it (reuseToken) so
 * Grok HTTP MCP reconnects after redeploy still resolve. `getPort` is
 * late-bound because the shared server binds after the router is constructed.
 * Prefer `getLoopbackUrl` (health `/mcp` proxy) over the ephemeral bind port.
 */
export interface SeamMcpWiring {
  registry: SeamTokenRegistry;
  getPort: () => number | undefined;
  /** Stable loopback MCP URL (health `/mcp` proxy). Prefer over the ephemeral bind port. */
  getLoopbackUrl?: () => string | undefined;
  /** Full MCP URL for a remote (bridge) spawn; never 127.0.0.1 when that is local-only. */
  getPublicUrl?: () => string | undefined;
  /** True when this session's agent process runs on a paired bridge (#84). */
  isRemoteSession?: (sessionId: string) => boolean;
  /**
   * Hub helper: mint X-Seam-Session + reachable (non-loopback) MCP URL.
   * Preferred over getPublicUrl when the session is remote.
   */
  mcpServersForRemoteSpawn?: (sessionId: string) => McpServer | undefined;
  /** Mux of the connected bridge this session is bound to, if any. */
  muxForSession?: (sessionId: string) => MuxHandle | undefined;
  /**
   * Bind `sessionId` to a remote bridge id. Called on runtime start when the
   * thread preset's `location` is not `local`. Local stays unbound.
   */
  bindSessionLocation?: (sessionId: string, location: string) => void;
}

/** Inputs `startRuntime` uses to construct and spawn an AgentRuntime. */
export interface RuntimeSpawnPlan {
  agentId: string;
  profile: AgentProfile;
  model: string;
  effort?: string;
  /** Claude Fast mode (#37). Only ever true when the profile declares Fast —
   *  the live session's advertised options are still the final authority. */
  fastMode: boolean;
  cwd: string;
  mcpServers: McpServer[];
  remote: boolean;
  spawnChild: (
    model?: string,
    effort?: string
  ) => ReturnType<AgentProfile["spawn"]> | Promise<ReturnType<AgentProfile["spawn"]>>;
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
  /** Free-form naming role; null means slot 3 and enumeration are absent. */
  role: ResolvedSetting<string | null>;
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
   * Outbound TTS for this thread. Default off. Thread-preset only.
   */
  tts: ResolvedSetting<boolean>;
  /** Per-thread Gemini TTS voice. `null` = env default (usually Kore). */
  ttsVoice: ResolvedSetting<string | null>;
  ttsPace: ResolvedSetting<"slow" | "natural" | "fast" | "faster">;
  ttsStyle: ResolvedSetting<"neutral" | "warm" | "clear">;
  /**
   * Host binding (D10 / #86). `local` is the default when the thread preset
   * omits `location`. Always a ResolvedSetting so config_describe can show it.
   */
  location: ResolvedSetting<string>;
  /**
   * Preamble riders (#90). Channel and thread riders STACK (channel first,
   * then thread) — they are not a single-winner overlay. `describeConfig`
   * therefore reports both raw strings rather than a ResolvedSetting.
   * The visual editor writes the **thread** rider only.
   */
  rider?: { channel?: string; thread?: string };
  /**
   * Set when a preset requested an effort level the resolved agent cannot honor
   * (Trap 2). The preset value is silently dropped at runtime; surfacing it here
   * keeps `config_describe` from reporting a personality the agent won't deliver.
   */
  effortIgnoredNote?: string;
  /**
   * Status-card layout (#96 / channel inherit). Session overlay wins, then
   * thread preset, then channel preset, then `"full"`. Read at render time so
   * a channel change applies to existing threads with no per-thread re-apply.
   */
  statusCardStyle: ResolvedSetting<StatusCardStyle>;
  /**
   * Random GIF thumbnail on the simple status card. Same precedence as
   * statusCardStyle. Default `false`.
   */
  simpleCardGif: ResolvedSetting<boolean>;
  /** OR-composed session/thread/channel opt-out from automatic thread naming. */
  disableThreadPrefix: ResolvedSetting<boolean>;
  /**
   * Claude Fast mode (#37): a per-thread **session-start** dimension, distinct
   * from model and effort. Thread-preset only (a channel-wide pin would bill
   * every sibling thread), default `false`. Requesting it does not guarantee it
   * — the live session must advertise ACP config id `fast`.
   */
  fastMode: ResolvedSetting<boolean>;
}

/** Layout the status card should render. Always `"full"` or `"simple"`. */
export function statusCardStyleForRender(d: ConfigDescription): StatusCardStyle {
  return d.statusCardStyle?.value === "simple" ? "simple" : "full";
}

/** Whether the simple card should show a random GIF thumbnail. */
export function simpleCardGifForRender(d: ConfigDescription): boolean {
  return d.simpleCardGif?.value === true;
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
  private readonly bindSessionLocationFn?: (sessionId: string, location: string) => void;
  private readonly channelPresets: Map<string, ChannelPreset>;
  private readonly threadPresets: Map<string, ThreadPreset>;
  private askUser?: AskUserFn;

  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly creationLocks = new Map<string, Promise<AgentRuntime>>();
  private readonly lastStartFailure = new Map<string, number>();
  private readonly startFailureCooldownMs = 30_000;
  /** A retiring runtime stays here until its process tree is fully gone. New
   * turns wait on this barrier before respawning the same durable session. */
  private readonly retirements = new Map<string, Promise<void>>();
  private readonly runtimeIdleTtlMs: number;
  private readonly runtimeIdleSweepMs: number;
  private idleReaperTimer?: ReturnType<typeof setInterval>;
  private idleSweepInFlight = false;

  constructor(opts: {
    logger: Logger;
    store: SessionStore;
    profiles: AgentProfile[];
    defaultAgentId: string;
    defaultModel: string;
    defaultPermissionMode?: PermissionPolicyMode;
    mcpServers?: McpServer[];
    seamMcp?: SeamMcpWiring;
    bindSessionLocation?: (sessionId: string, location: string) => void;
    channelPresets?: Map<string, ChannelPreset>;
    threadPresets?: Map<string, ThreadPreset>;
    /** 0 disables warm-runtime retirement. Production supplies the configured
     * TTL; tests and embedders remain opt-in. */
    runtimeIdleTtlMs?: number;
    runtimeIdleSweepMs?: number;
  }) {
    this.logger = opts.logger.child({ comp: "session-router" });
    this.store = opts.store;
    this.profileById = new Map(opts.profiles.map((p) => [p.id, p]));
    this.defaultAgentId = opts.defaultAgentId;
    this.defaultModel = opts.defaultModel;
    this.defaultPermissionMode = opts.defaultPermissionMode ?? "ask";
    this.mcpServers = opts.mcpServers ?? [];
    this.seamMcp = opts.seamMcp;
    this.bindSessionLocationFn = opts.bindSessionLocation ?? opts.seamMcp?.bindSessionLocation;
    this.channelPresets = opts.channelPresets ?? new Map();
    this.threadPresets = opts.threadPresets ?? new Map();
    this.runtimeIdleTtlMs = Math.max(0, opts.runtimeIdleTtlMs ?? 0);
    this.runtimeIdleSweepMs = Math.max(
      1_000,
      opts.runtimeIdleSweepMs ?? Math.min(300_000, Math.max(30_000, Math.floor(this.runtimeIdleTtlMs / 4)))
    );
  }

  /** Start the unref'd warm-runtime reaper. Durable session rows and ACP ids
   * are never touched; only idle process trees are retired. */
  startIdleReaper(): void {
    if (this.runtimeIdleTtlMs <= 0 || this.idleReaperTimer) return;
    this.idleReaperTimer = setInterval(
      () => void this.sweepIdleRuntimes(),
      this.runtimeIdleSweepMs
    );
    this.idleReaperTimer.unref?.();
    this.logger.info(
      { ttlMs: this.runtimeIdleTtlMs, sweepMs: this.runtimeIdleSweepMs },
      "idle runtime reaper started"
    );
  }

  stopIdleReaper(): void {
    if (this.idleReaperTimer) clearInterval(this.idleReaperTimer);
    this.idleReaperTimer = undefined;
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

    const sessionRole = normalizeRole(cfg.role);
    const threadRole = normalizeRole(thread?.role?.value);
    const channelRole = normalizeRole(chan?.role?.value);
    const role: ResolvedSetting<string | null> = sessionRole
      ? { value: sessionRole, source: "session config" }
      : threadRole
        ? { value: threadRole, source: "thread preset" }
        : channelRole
          ? { value: channelRole, source: "channel preset" }
          : { value: null, source: "default" };

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
    const presetEffortAuto = presetEffort?.value === "auto";
    const presetEffortUsable = !!(
      presetEffort?.value &&
      !presetEffortAuto &&
      profile?.effort &&
      profile.effort.mechanism !== "none" &&
      profile.effort.levels.includes(presetEffort.value)
    );
    let effort: ResolvedSetting<string | null>;
    let effortIgnoredNote: string | undefined;
    if (presetEffortAuto && presetEffortSource) {
      // `auto` is an explicit per-thread neutralizer used by cross-thread
      // control. It shadows a channel effort pin while leaving the backend at
      // its own default.
      effort = { value: null, source: presetEffortSource };
    } else if (presetEffortUsable && presetEffort && presetEffortSource) {
      effort = { value: presetEffort.value, source: presetEffortSource };
    } else {
      effort = cfg.reasoningEffort
        ? { value: cfg.reasoningEffort, source: "session config" }
        : { value: null, source: "default" };
      if (presetEffort?.value && !presetEffortAuto && !presetEffortUsable) {
        effortIgnoredNote =
          `${presetEffortSource} sets effort "${presetEffort.value}", but agent ` +
          `"${agent.value}" does not support that level — it is ignored; ` +
          `effective effort is ${effort.value ? `"${effort.value}"` : "none"}.`;
      }
    }

    // cwd — session overlay > thread preset > channel preset > process.cwd()
    // (same precedence as statusCardStyle / #101).
    const cwd: ResolvedSetting<string> = record.repoPath
      ? { value: record.repoPath, source: "session config" }
      : thread?.cwd
        ? { value: thread.cwd.value, source: "thread preset" }
        : chan?.cwd
          ? { value: chan.cwd.value, source: "channel preset" }
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

    const tts: ResolvedSetting<boolean> = thread?.tts
      ? { value: true, source: "thread preset" }
      : { value: false, source: "default" };

    // #37: thread-preset only, like `detached`/`tts`. Off is the default and the
    // only state an agent without Fast can be in.
    const fastMode: ResolvedSetting<boolean> = thread?.fastMode
      ? { value: true, source: "thread preset" }
      : { value: false, source: "default" };

    const ttsVoice: ResolvedSetting<string | null> = thread?.ttsVoice
      ? { value: thread.ttsVoice, source: "thread preset" }
      : { value: null, source: "default" };

    const ttsPace: ResolvedSetting<"slow" | "natural" | "fast" | "faster"> =
      thread?.ttsPace === "slow" || thread?.ttsPace === "fast" || thread?.ttsPace === "faster"
        ? { value: thread.ttsPace, source: "thread preset" }
        : { value: "natural", source: "default" };

    const ttsStyle: ResolvedSetting<"neutral" | "warm" | "clear"> =
      thread?.ttsStyle === "warm" || thread?.ttsStyle === "clear"
        ? { value: thread.ttsStyle, source: "thread preset" }
        : { value: "neutral", source: "default" };

    const locationValue = resolveThreadLocation(
      { threadPresets: this.threadPresets },
      record.channelRef
    );
    const location: ResolvedSetting<string> = thread?.location
      ? { value: locationValue, source: "thread preset" }
      : { value: locationValue, source: "default" };

    const rider: { channel?: string; thread?: string } = {
      ...(chan?.rider?.value ? { channel: chan.rider.value } : {}),
      ...(thread?.rider?.value ? { thread: thread.rider.value } : {}),
    };

    const statusCardStyle: ResolvedSetting<StatusCardStyle> =
      cfg.statusCardStyle === "simple" || cfg.statusCardStyle === "full"
        ? { value: cfg.statusCardStyle, source: "session config" }
        : thread?.statusCardStyle?.value === "simple" || thread?.statusCardStyle?.value === "full"
          ? { value: thread.statusCardStyle.value, source: "thread preset" }
          : chan?.statusCardStyle?.value === "simple" || chan?.statusCardStyle?.value === "full"
            ? { value: chan.statusCardStyle.value, source: "channel preset" }
            : { value: "full", source: "default" };

    const simpleCardGif: ResolvedSetting<boolean> =
      typeof cfg.simpleCardGif === "boolean"
        ? { value: cfg.simpleCardGif, source: "session config" }
        : typeof thread?.simpleCardGif?.value === "boolean"
          ? { value: thread.simpleCardGif.value, source: "thread preset" }
          : typeof chan?.simpleCardGif?.value === "boolean"
            ? { value: chan.simpleCardGif.value, source: "channel preset" }
            : { value: false, source: "default" };

    const disableThreadPrefix: ResolvedSetting<boolean> = cfg.disableThreadPrefix === true
      ? { value: true, source: "session config" }
      : thread?.disableThreadPrefix?.value === true
        ? { value: true, source: "thread preset" }
        : chan?.disableThreadPrefix?.value === true
          ? { value: true, source: "channel preset" }
          : { value: false, source: "default" };

    return {
      sessionId: record.id,
      channelRef: record.channelRef,
      parentRef: record.parentRef,
      agent,
      model,
      role,
      effort,
      cwd,
      permission,
      locked: chan?.locked ?? false,
      detached,
      tts,
      ttsVoice,
      ttsPace,
      ttsStyle,
      location,
      rider,
      statusCardStyle,
      simpleCardGif,
      disableThreadPrefix,
      fastMode,
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
    const retiring = this.retirements.get(record.id);
    if (retiring) {
      await retiring;
      return this.getOrStartRuntime(record);
    }

    const cached = this.runtimes.get(record.id);
    if (cached) {
      cached.markActivity();
      return cached;
    }

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
  async invalidate(
    sessionId: string,
    opts?: { clearAcpSession?: boolean; clearStartFailure?: boolean }
  ): Promise<void> {
    // Keep the seam-MCP token. It identifies the Discord session; Grok (and
    // others) reconnect HTTP MCP with the header from session/new. A later
    // start reuses it (reuseToken). Revoke only when the session row is gone.
    const retiring = this.retirements.get(sessionId);
    if (retiring) await retiring;

    const rt = this.runtimes.get(sessionId);
    if (rt) {
      await this.retireRuntime(sessionId, rt, "invalidate");
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
    if (opts?.clearStartFailure) {
      this.lastStartFailure.delete(sessionId);
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
    this.stopIdleReaper();
    const pending = [...this.retirements.values()];
    for (const [sessionId, rt] of [...this.runtimes]) {
      pending.push(this.retireRuntime(sessionId, rt, "shutdown"));
    }
    await Promise.all(pending);
  }

  /** Retire up to eight expired warm runtimes in one pass. Busy prompts are
   * never touched. Exposed for deterministic tests and diagnostics. */
  async sweepIdleRuntimes(nowMs = Date.now()): Promise<number> {
    if (this.runtimeIdleTtlMs <= 0 || this.idleSweepInFlight) return 0;
    this.idleSweepInFlight = true;
    try {
      const candidates: Array<[string, AgentRuntime]> = [];
      for (const [sessionId, rt] of this.runtimes) {
        if (candidates.length >= 8) break;
        if (rt.busy) continue;
        if (nowMs - rt.lastActivityAtMs < this.runtimeIdleTtlMs) continue;
        candidates.push([sessionId, rt]);
      }
      if (candidates.length === 0) return 0;

      await Promise.all(
        candidates.map(async ([sessionId, rt]) => {
          // Recheck immediately before the synchronous cache removal. No await
          // occurs between this guard and retireRuntime's ownership claim.
          if (this.runtimes.get(sessionId) !== rt || rt.busy) return;
          if (nowMs - rt.lastActivityAtMs < this.runtimeIdleTtlMs) return;
          await this.retireRuntime(sessionId, rt, "idle_ttl");
        })
      );
      const reaped = candidates.filter(([sessionId]) => !this.runtimes.has(sessionId)).length;
      if (reaped > 0) {
        this.logger.info(
          { reaped, ttlMs: this.runtimeIdleTtlMs, remaining: this.runtimes.size },
          "idle runtimes reaped"
        );
      }
      return reaped;
    } finally {
      this.idleSweepInFlight = false;
    }
  }

  hasRuntime(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  /** Live ACP runtimes currently held in memory. */
  liveRuntimeCount(): number {
    return this.runtimes.size;
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

  /**
   * seam-MCP servers for a throwaway isolated run, reusing the session's
   * existing token so a concurrent live turn is not rotated off MCP.
   */
  reuseMcpServers(sessionId: string): McpServer[] {
    return planSeamMcpInjection({
      sessionId,
      globalMcpServers: this.mcpServers,
      seamMcp: this.seamMcp,
      reuseToken: true,
    }).mcpServers;
  }

  /** Fresh MCP token keyed by `sessionId` (ingest jobs use the dispatch id). */
  mintMcpServersForSession(sessionId: string): McpServer[] {
    return planSeamMcpInjection({
      sessionId,
      globalMcpServers: this.mcpServers,
      seamMcp: this.seamMcp,
      reuseToken: false,
    }).mcpServers;
  }

  revokeMcpSession(sessionId: string): void {
    this.seamMcp?.registry.revokeSession(sessionId);
  }

  /**
   * Resolve spawn inputs for a runtime start without actually starting the
   * agent. Tests (and later PR4) use this to inspect MCP injection + the
   * remote spawn path. `startRuntime` is the only production caller.
   */
  planRuntimeSpawn(record: SessionRecord): RuntimeSpawnPlan {
    this.bindRecordLocation(record);
    const preset = resolveChannelPreset(
      { channelPresets: this.channelPresets, threadPresets: this.threadPresets },
      record.parentRef ?? undefined,
      record.channelRef
    );

    const agentId = preset.agent?.value ?? record.agentId;
    const profile = this.profileById.get(agentId);
    if (!profile) {
      // #12: a retired agent gets a message that names the retirement and the
      // fix. We deliberately do NOT substitute the default agent — that would
      // silently run this thread's prompts on a model nobody chose.
      throw new Error(
        retiredAgentMessage(agentId) ?? `Unknown agent profile "${agentId}" for session ${record.id}`
      );
    }
    const cfg = this.store.readConfig(record);
    const model = preset.model?.value ?? cfg.model ?? this.defaultModel;
    // Only honor a preset effort if this agent actually supports that level —
    // e.g. a channel preset might set "medium" but the locked agent has no
    // effort concept at all, in which case we silently fall back instead of
    // erroring.
    const presetEffortAuto = preset.effort?.value === "auto";
    const presetEffortUsable =
      preset.effort?.value &&
      !presetEffortAuto &&
      profile.effort &&
      profile.effort.mechanism !== "none" &&
      profile.effort.levels.includes(preset.effort.value);
    const effort = presetEffortAuto
      ? undefined
      : presetEffortUsable
        ? preset.effort!.value
        : cfg.reasoningEffort;
    const described = this.describeConfig(record);
    const cwd = described.cwd.value;
    // #37: never request Fast from an agent that has no such concept — that
    // would be an un-actionable refusal on every single turn. Whether the live
    // session honors it is decided against its advertised config options.
    const fastMode = described.fastMode.value === true && profile.fastMode !== undefined;

    if (this.seamMcp && this.seamMcp.getPort() === undefined) {
      this.logger.warn(
        { session: record.id },
        "seam-mcp enabled but server port not yet available; skipping injection"
      );
    }

    const { mcpServers: injectedMcpServers, remote } = planSeamMcpInjection({
      sessionId: record.id,
      globalMcpServers: this.mcpServers,
      seamMcp: this.seamMcp,
      // Reuse the Discord-session token. Rotating on every runtime start
      // (redeploy, agent crash, invalidate) makes Grok's HTTP MCP reconnect
      // send a header the new process no longer knows.
      reuseToken: true,
    });
    // Bridge the session cwd's project .mcp.json into the per-session list so
    // non-claude agents (codex/grok/agy/copilot) see the same project MCP
    // servers claude-agent-acp auto-reads from cwd. Scoped to cwd, so a server
    // in one repo's .mcp.json never leaks to another.
    const mcpServers = [
      ...injectedMcpServers,
      ...buildProjectMcpServers(
        cwd,
        this.logger,
        new Set(injectedMcpServers.map((s) => s.name))
      ),
    ];

    let spawnChild: RuntimeSpawnPlan["spawnChild"] = (modelOverride, effortOverride) =>
      profile.spawn(modelOverride, effortOverride, mcpServers);

    if (remote) {
      const mux = this.seamMcp?.muxForSession?.(record.id);
      if (!mux) {
        throw new Error(
          `Session ${record.id} is bound to a remote bridge that is not connected`
        );
      }
      spawnChild = (modelOverride, effortOverride) =>
        spawnRemoteSlot(mux, {
          mcpServers,
          agentId,
          model: modelOverride,
          effort: effortOverride,
          cwd,
        });
    }

    return { agentId, profile, model, effort, fastMode, cwd, mcpServers, remote, spawnChild };
  }

  /**
   * On session start: if the thread is bound to a remote host, call
   * `markSessionBridge` so `planRuntimeSpawn` takes the remote path.
   * Local stays unbound (loopback MCP as today).
   */
  bindRecordLocation(record: SessionRecord, locationOverride?: string): string {
    const location =
      locationOverride ??
      resolveThreadLocation({ threadPresets: this.threadPresets }, record.channelRef);
    this.bindSessionLocationFn?.(record.id, location);
    return location;
  }

  private async startRuntime(record: SessionRecord): Promise<AgentRuntime> {
    // Channel/thread presets are the source of truth for locked-down
    // channels: re-resolved on every runtime start (not just session
    // creation) so a stored record can never drift from the config file —
    // whatever's in CHANNEL_PRESETS_FILE wins, regardless of what's in the
    // DB. See resolveChannelPreset in config.ts.
    const plan = this.planRuntimeSpawn(record);
    const { profile, model, effort, fastMode, cwd, mcpServers } = plan;

    const runtime = new AgentRuntime({
      profile,
      logger: this.logger.child({ session: record.id }),
      mcpServers,
      spawnFn: plan.spawnChild,
      onDead: () => {
        // Involuntary death — #76: leave turn markers intact. This is an
        // interruption, not a cancellation. Recovery reattaches on the next
        // boot (or the next recoverInterruptedTurns pass).
        // Do NOT revoke the seam-MCP token: it names the Discord session, not
        // the ACP subprocess. Grok's HTTP MCP client reconnects with the old
        // header; rotating here is `-32001 unauthorized`.
        this.logger.info({ sessionId: record.id }, "agent process died; evicting runtime for auto-resume");
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
    try {
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
              // #37: the persisted REQUEST, for reporting only. loadSession
              // never applies Fast — re-enabling it on a session that already
              // has history is the repricing case the design forbids.
              ...(fastMode ? { fastMode: true } : {}),
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
        // #37: Fast is a session-start dimension, so it is passed HERE only.
        // The resume branch above deliberately omits it — re-enabling Fast on a
        // loaded session is the repricing case the design forbids.
        ...(fastMode ? { fastMode: true } : {}),
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
    } catch (err) {
      // A failed replacement must not leak an untracked child: getOrStartRuntime
      // caches only successful starts, so invalidate() cannot see this runtime.
      await runtime.dispose().catch((disposeErr) =>
        this.logger.warn(
          { err: disposeErr, sessionId: record.id },
          "failed to dispose runtime after session start failure"
        )
      );
      throw err;
    }
  }

  private retireRuntime(
    sessionId: string,
    rt: AgentRuntime,
    reason: "idle_ttl" | "invalidate" | "shutdown"
  ): Promise<void> {
    const existing = this.retirements.get(sessionId);
    if (existing) return existing;
    if (this.runtimes.get(sessionId) !== rt) return Promise.resolve();

    // Claim retirement synchronously before dispose yields. getOrStartRuntime
    // sees the barrier and cannot overlap a new process with the old one.
    this.runtimes.delete(sessionId);
    let retirement!: Promise<void>;
    retirement = rt
      .dispose()
      .catch((err) => {
        this.logger.warn({ err, sessionId, reason }, "runtime retirement failed");
      })
      .finally(() => {
        if (this.retirements.get(sessionId) === retirement) {
          this.retirements.delete(sessionId);
        }
      });
    this.retirements.set(sessionId, retirement);
    return retirement;
  }
}

export function normalizeRole(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const role = value.trim();
  return !role || role.toLowerCase() === "auto" ? null : role;
}
