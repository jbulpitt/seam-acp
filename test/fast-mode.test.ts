/**
 * Claude Fast mode (#37) — the seven contracts the issue requires.
 *
 *  1. default/off does not request Fast (and issues no set_config_option)
 *  2. a supported Claude session applies `fast=on` and records the applied state
 *  3. unsupported model/session and environment-disabled paths reject clearly
 *     WITHOUT a false confirmation
 *  4. changing Fast resets the Claude ACP session; unchanged Fast reports
 *     `(no change)` and does not reset
 *  5. other agents reject, and carry no Fast state
 *  6. config editor, MCP schema/result, audit data, status card, and
 *     persistence round-trip the setting
 *  7. support is never inferred from a model slug — only from live configOptions
 *
 * Everything here is offline. The live protocol facts these fixtures encode
 * (config id `fast`, select over `on`/`off`) were established by the zero-token
 * probe in `scripts/claude-fast-mode-probe.mjs`; see runbook §12.
 */
import { describe, it, expect, vi } from "vitest";
import type { AgentProfile } from "@seam/adapters";
import { CLAUDE_FAST_MODE, makeClaudeProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import {
  FAST_MODE_CONFIG_ID,
  FAST_MODE_COST_WARNING,
  FAST_MODE_DISABLE_ENV,
  FAST_MODE_OFF,
  FAST_MODE_ON,
  FAST_MODE_RESET_NOTICE,
  checkFastModeEligibility,
  describeFastModeOutcome,
  fastModeNeedsFreshSession,
  settleFastMode,
  fastModeLabel,
  isFastModeDisabledByEnv,
} from "../packages/core/src/core/fast-mode.js";
import {
  ConfigMutationService,
  detectSessionReset,
} from "../packages/core/src/core/config-mutation.js";
import { PresetsFileSchema } from "../packages/core/src/config.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { pino } from "pino";
import {
  ThreadSessionControlService,
  type SessionControlRuntime,
  type ThreadSessionControlDeps,
} from "../packages/core/src/core/thread-session-control.js";
import type { ConfigDescription } from "../packages/core/src/core/session-router.js";
import type { SessionConfigState, SessionRecord } from "../packages/core/src/core/types.js";
import {
  applyPickerValue,
  dirtyThreadPresetChanges,
  renderHub,
  willEnableFastMode,
  willResetSession,
  willVerifyFastMode,
  type DraftAgentCapabilities,
  type InheritedConfig,
  type ThreadConfigDraft,
  type ThreadConfigSnapshot,
} from "../packages/core/src/platforms/discord/config-editor.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const silent = pino({ level: "silent" }) as unknown as Logger;

// --------------------------------------------------------------------------
// 1 + 2 + 3 + 7: AgentRuntime — the ACP apply path
// --------------------------------------------------------------------------

/** A `fast` select exactly as claude-agent-acp advertises it (probe-verified). */
function fastOption(currentValue: string) {
  return {
    id: FAST_MODE_CONFIG_ID,
    name: "Fast mode",
    type: "select",
    currentValue,
    options: [
      { value: FAST_MODE_ON, name: "On" },
      { value: FAST_MODE_OFF, name: "Off" },
    ],
  };
}

/** The option set a model WITHOUT Fast advertises (probe-verified for Sonnet). */
const NO_FAST_OPTIONS = [
  { id: "mode", name: "Mode", type: "select", currentValue: "default", options: [] },
  { id: "model", name: "Model", type: "select", currentValue: "sonnet", options: [] },
  { id: "effort", name: "Effort", type: "select", currentValue: "high", options: [] },
];

function makeLogger() {
  const warns: Array<{ obj: unknown; msg: string }> = [];
  const logger = {
    child() {
      return this;
    },
    warn(obj: unknown, msg?: string) {
      warns.push({ obj, msg: msg ?? String(obj) });
    },
    error() {},
    info() {},
    debug() {},
  };
  return { logger: logger as unknown as Logger, warns };
}

class FastConn {
  setCalls: Array<{ configId: string; value: unknown }> = [];
  newOptions: unknown = null;
  loadOptions: unknown = null;
  /** What the session reports AFTER a set — the "accepted then snapped back" case. */
  echoAfterSet?: unknown;
  /** Simulate a wrapper that accepts the call but echoes no configOptions. */
  echoNothing = false;
  rejectSet = false;

  async newSession() {
    return { sessionId: "fresh", configOptions: this.newOptions, modes: null };
  }
  async loadSession(params: { sessionId: string }) {
    return { sessionId: params.sessionId, configOptions: this.loadOptions, modes: null };
  }
  async prompt() {
    return { stopReason: "end_turn" };
  }
  async cancel() {}
  async setSessionMode() {}
  async setSessionConfigOption(params: { configId: string; value: unknown }) {
    this.setCalls.push({ configId: params.configId, value: params.value });
    if (this.rejectSet) throw new Error("Invalid value for config option fast");
    if (this.echoNothing) return {};
    return { configOptions: this.echoAfterSet ?? this.newOptions };
  }
}

function runtimeFor(profile: Partial<AgentProfile>) {
  const { logger, warns } = makeLogger();
  const rt = new AgentRuntime({
    profile: { id: "claude", defaultModel: "claude-opus-5", ...profile } as AgentProfile,
    logger,
  });
  const conn = new FastConn();
  (rt as unknown as { connection: unknown }).connection = conn;
  (rt as unknown as { promptCapabilities: unknown }).promptCapabilities = {};
  return { rt, conn, warns };
}

const CLAUDE_PROFILE: Partial<AgentProfile> = { fastMode: CLAUDE_FAST_MODE };

describe("#37 contract 1 — default/off never requests Fast", () => {
  it("issues NO set_config_option when Fast is not requested on a Fast-capable session", async () => {
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = [fastOption(FAST_MODE_OFF)];
    await rt.newSession({ cwd: "/repo" });
    expect(conn.setCalls.filter((c) => c.configId === FAST_MODE_CONFIG_ID)).toEqual([]);
    expect(rt.getFastModeOutcome()).toEqual({ requested: false, applied: false });
  });

  it("issues NO set_config_option when the session does not advertise Fast at all", async () => {
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = NO_FAST_OPTIONS;
    await rt.newSession({ cwd: "/repo" });
    expect(conn.setCalls).toEqual([]);
    expect(rt.getFastModeOutcome()).toEqual({ requested: false, applied: false });
  });

  it("writes `off` explicitly ONLY when the session came up `on`", async () => {
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = [fastOption(FAST_MODE_ON)];
    conn.echoAfterSet = [fastOption(FAST_MODE_OFF)];
    await rt.newSession({ cwd: "/repo" });
    expect(conn.setCalls).toEqual([{ configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_OFF }]);
    expect(rt.getFastModeOutcome()).toEqual({ requested: false, applied: false });
  });

  it("an agent with no Fast descriptor never touches the option and records nothing", async () => {
    const { rt, conn } = runtimeFor({});
    conn.newOptions = [fastOption(FAST_MODE_OFF)];
    await rt.newSession({ cwd: "/repo" });
    expect(conn.setCalls).toEqual([]);
    expect(rt.getFastModeOutcome()).toBeUndefined();
  });
});

describe("#37 contract 2 — a supported session applies fast=on and records it", () => {
  it("sets configId `fast` to `on` and reports applied", async () => {
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = [fastOption(FAST_MODE_OFF)];
    conn.echoAfterSet = [fastOption(FAST_MODE_ON)];
    await rt.newSession({ cwd: "/repo", fastMode: true });
    expect(conn.setCalls).toEqual([{ configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_ON }]);
    expect(rt.getFastModeOutcome()).toEqual({ requested: true, applied: true });
  });

  it("skips the RPC when the fresh session already reports `on`", async () => {
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = [fastOption(FAST_MODE_ON)];
    await rt.newSession({ cwd: "/repo", fastMode: true });
    expect(conn.setCalls).toEqual([]);
    expect(rt.getFastModeOutcome()).toEqual({ requested: true, applied: true });
  });

  it("does NOT claim applied when the session snaps back off after accepting", async () => {
    // Upstream carries a `fast_mode_disabled_reason`, so a resolved RPC is not
    // proof. The outcome must come from the echoed configOptions.
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = [fastOption(FAST_MODE_OFF)];
    conn.echoAfterSet = [fastOption(FAST_MODE_OFF)];
    await rt.newSession({ cwd: "/repo", fastMode: true });
    const outcome = rt.getFastModeOutcome();
    expect(outcome?.requested).toBe(true);
    expect(outcome?.applied).toBe(false);
    expect(outcome?.error).toMatch(/declined to stay in Fast/i);
  });
});

describe("#37 — an unverifiable apply is never a confirmation", () => {
  it("a set response with no configOptions is UNDETERMINED, not applied", async () => {
    // The wrapper accepted the call but reported nothing back. Recording
    // `applied: true` here would be a confirmation we cannot support — and the
    // one that costs real money.
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = [fastOption(FAST_MODE_OFF)];
    conn.echoNothing = true;
    await rt.newSession({ cwd: "/repo", fastMode: true });
    const outcome = rt.getFastModeOutcome();
    expect(outcome?.applied).toBe(null);
    expect(outcome?.error).toMatch(/did not report its resulting "fast" state/);
    // Every downstream gate treats it as not-in-Fast.
    expect(outcome?.applied !== true).toBe(true);
    expect(
      settleFastMode({ outcome, agentId: "claude", model: "claude-opus-5" }).ok
    ).toBe(false);
    expect(describeFastModeOutcome(outcome)).toBe("on requested · not applied");
  });

  it("an unverifiable DISABLE is not treated as an error", async () => {
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = [fastOption(FAST_MODE_ON)];
    conn.echoNothing = true;
    await rt.newSession({ cwd: "/repo" });
    expect(rt.getFastModeOutcome()).toEqual({ requested: false, applied: null });
  });
});

describe("#37 — a live model switch re-derives the recorded Fast state", () => {
  it("clears a stale `applied: true` when the new model drops the option", async () => {
    // Claude model switches are live-config on the SAME session, so without
    // this the status card keeps rendering "⚡ fast on" for a model that has
    // no Fast — an active false confirmation.
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = [fastOption(FAST_MODE_OFF)];
    conn.echoAfterSet = [fastOption(FAST_MODE_ON)];
    await rt.newSession({ cwd: "/repo", fastMode: true });
    expect(rt.getFastModeOutcome()).toEqual({ requested: true, applied: true });

    // Switching to a model whose option set has no `fast`.
    conn.echoAfterSet = NO_FAST_OPTIONS;
    await rt.setModel("claude-sonnet-5");
    const outcome = rt.getFastModeOutcome();
    expect(outcome?.applied).toBe(false);
    expect(outcome?.error).toMatch(/no longer offered by this session/);
    expect(describeFastModeOutcome(outcome)).toBe("on requested · off applied");
  });

  it("keeps Fast on when the new model still advertises it", async () => {
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = [fastOption(FAST_MODE_OFF)];
    conn.echoAfterSet = [fastOption(FAST_MODE_ON)];
    await rt.newSession({ cwd: "/repo", fastMode: true });
    conn.echoAfterSet = [fastOption(FAST_MODE_ON)];
    await rt.setModel("claude-opus-4-8");
    expect(rt.getFastModeOutcome()).toEqual({ requested: true, applied: true });
  });

  it("leaves agents with no Fast concept untouched", async () => {
    const { rt, conn } = runtimeFor({ id: "codex" });
    conn.newOptions = NO_FAST_OPTIONS;
    await rt.newSession({ cwd: "/repo" });
    await rt.setModel("gpt-new");
    expect(rt.getFastModeOutcome()).toBeUndefined();
  });
});

describe("#37 shared fresh-session rule", () => {
  it("requires a fresh session for a model/agent/host change while Fast is on", () => {
    const on = { nextFastMode: true, fastModeChanged: false };
    expect(fastModeNeedsFreshSession({ ...on, modelChanged: true })).toBe(true);
    expect(fastModeNeedsFreshSession({ ...on, agentChanged: true })).toBe(true);
    expect(fastModeNeedsFreshSession({ ...on, locationChanged: true })).toBe(true);
    expect(fastModeNeedsFreshSession(on)).toBe(false);
  });

  it("always requires one when the Fast setting itself moves", () => {
    expect(
      fastModeNeedsFreshSession({ nextFastMode: false, fastModeChanged: true })
    ).toBe(true);
  });

  it("never requires one for a model change while Fast is off", () => {
    expect(
      fastModeNeedsFreshSession({
        nextFastMode: false,
        fastModeChanged: false,
        modelChanged: true,
      })
    ).toBe(false);
  });
});

describe("#37 contract 3 — unsupported / disabled reject without false confirmation", () => {
  it("a session that does not advertise `fast` records applied:false with an actionable error", async () => {
    const { rt, conn, warns } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = NO_FAST_OPTIONS;
    await rt.newSession({ cwd: "/repo", fastMode: true });
    const outcome = rt.getFastModeOutcome();
    expect(outcome?.applied).toBe(false);
    expect(outcome?.error).toMatch(/does not advertise config id "fast"/);
    // Names a model that DOES work, so the refusal is actionable.
    expect(outcome?.error).toMatch(/claude-opus-5/);
    expect(conn.setCalls).toEqual([]);
    expect(warns.some((w) => /fast mode requested but not advertised/i.test(w.msg))).toBe(true);
  });

  it("a rejected set_config_option is reported, not swallowed", async () => {
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.newOptions = [fastOption(FAST_MODE_OFF)];
    conn.rejectSet = true;
    await rt.newSession({ cwd: "/repo", fastMode: true });
    expect(rt.getFastModeOutcome()).toMatchObject({ requested: true, applied: false });
    expect(rt.getFastModeOutcome()?.error).toMatch(/could not be enabled/i);
  });

  it("the env kill switch reports itself, not a bogus 'pick another model'", async () => {
    const prev = process.env[FAST_MODE_DISABLE_ENV];
    process.env[FAST_MODE_DISABLE_ENV] = "1";
    try {
      // The wire looks identical to an ineligible model (the option is simply
      // absent), so the runtime must disambiguate from the environment.
      const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
      conn.newOptions = NO_FAST_OPTIONS;
      await rt.newSession({ cwd: "/repo", fastMode: true });
      const outcome = rt.getFastModeOutcome();
      expect(outcome?.applied).toBe(false);
      expect(outcome?.error).toContain(FAST_MODE_DISABLE_ENV);
      expect(outcome?.error).not.toMatch(/Pin a model/);
    } finally {
      if (prev === undefined) delete process.env[FAST_MODE_DISABLE_ENV];
      else process.env[FAST_MODE_DISABLE_ENV] = prev;
    }
  });

  it("an agent without Fast refuses an explicit request instead of ignoring it", async () => {
    const { rt, conn } = runtimeFor({ id: "codex" });
    conn.newOptions = NO_FAST_OPTIONS;
    await rt.newSession({ cwd: "/repo", fastMode: true });
    expect(conn.setCalls).toEqual([]);
    expect(rt.getFastModeOutcome()?.error).toMatch(/Claude-only serving mode/);
  });
});

describe("#37 — resume never re-enables Fast, but reports divergence", () => {
  it("loadSession issues no set_config_option even when Fast is requested", async () => {
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.loadOptions = [fastOption(FAST_MODE_ON)];
    await rt.loadSession({ sessionId: "old", cwd: "/repo", fastMode: true });
    expect(conn.setCalls).toEqual([]);
    expect(rt.getFastModeOutcome()).toEqual({ requested: true, applied: true });
  });

  it("a requested-but-inactive resume renders as requested/not-applied, not silence", async () => {
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.loadOptions = [fastOption(FAST_MODE_OFF)];
    await rt.loadSession({ sessionId: "old", cwd: "/repo", fastMode: true });
    expect(conn.setCalls).toEqual([]);
    const outcome = rt.getFastModeOutcome();
    expect(outcome).toMatchObject({ requested: true, applied: false });
    expect(describeFastModeOutcome(outcome)).toBe("on requested · off applied");
  });

  it("a resume with no advertised option is undetermined, not `off`", async () => {
    const { rt, conn } = runtimeFor(CLAUDE_PROFILE);
    conn.loadOptions = NO_FAST_OPTIONS;
    await rt.loadSession({ sessionId: "old", cwd: "/repo", fastMode: true });
    expect(rt.getFastModeOutcome()).toEqual({ requested: true, applied: null });
    expect(describeFastModeOutcome(rt.getFastModeOutcome())).toBe("on requested · not applied");
  });
});

// --------------------------------------------------------------------------
// Policy helpers
// --------------------------------------------------------------------------

describe("#37 environment kill switch", () => {
  it("treats only truthy values as disabling", () => {
    expect(isFastModeDisabledByEnv({})).toBe(false);
    for (const off of ["", "0", "false", "no", "  FALSE "]) {
      expect(isFastModeDisabledByEnv({ [FAST_MODE_DISABLE_ENV]: off }), off).toBe(false);
    }
    for (const on of ["1", "true", "yes", "anything"]) {
      expect(isFastModeDisabledByEnv({ [FAST_MODE_DISABLE_ENV]: on }), on).toBe(true);
    }
  });

  it("refuses an enable with an actionable message and never blocks a disable", () => {
    const env = { [FAST_MODE_DISABLE_ENV]: "1" };
    const on = checkFastModeEligibility({
      requested: true,
      agentId: "claude",
      descriptor: CLAUDE_FAST_MODE,
      env,
    });
    expect(on.ok).toBe(false);
    if (!on.ok) {
      expect(on.error).toContain(FAST_MODE_DISABLE_ENV);
      expect(on.error).toMatch(/Nothing was changed/);
    }
    // Turning it OFF stays allowed — off is the default state.
    expect(
      checkFastModeEligibility({ requested: false, agentId: "claude", descriptor: undefined, env })
        .ok
    ).toBe(true);
  });

  it("refuses an enable for an agent with no Fast concept", () => {
    const res = checkFastModeEligibility({
      requested: true,
      agentId: "codex",
      descriptor: undefined,
      env: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Claude-only/);
  });
});

describe("#37 status reporting helpers", () => {
  it("shows nothing for an ordinary off turn and `on` when applied", () => {
    expect(describeFastModeOutcome(undefined)).toBeUndefined();
    expect(describeFastModeOutcome({ requested: false, applied: false })).toBeUndefined();
    expect(describeFastModeOutcome({ requested: true, applied: true })).toBe("on");
  });

  it("fastModeLabel distinguishes unknown from off", () => {
    expect(fastModeLabel(true)).toBe(FAST_MODE_ON);
    expect(fastModeLabel(false)).toBe(FAST_MODE_OFF);
    expect(fastModeLabel(null)).toBe("unknown");
  });
});

// --------------------------------------------------------------------------
// 5 + 7: profile eligibility is a positive allowlist, never a slug
// --------------------------------------------------------------------------

describe("#37 contract 5/7 — eligibility is opt-in and backend-scoped", () => {
  it("a direct-Anthropic Claude profile declares Fast", () => {
    const p = makeClaudeProfile({ defaultModel: "claude-opus-5", directAnthropic: true });
    expect(p.fastMode).toEqual(CLAUDE_FAST_MODE);
  });

  it("Vertex, Z.ai and any un-opted profile declare NO Fast", () => {
    // Vertex redirects with CLAUDE_CODE_USE_VERTEX and no base URL — upstream
    // reports `not_first_party`, so a negative base-URL check would miss it.
    const vertex = makeClaudeProfile({
      id: "claude-vertex",
      defaultModel: "claude-opus-5",
      extraEnv: { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p" },
    });
    expect(vertex.fastMode).toBeUndefined();

    const zai = makeClaudeProfile({
      id: "zai",
      defaultModel: "glm-5.2",
      extraEnv: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
    });
    expect(zai.fastMode).toBeUndefined();

    // Default is off: a brand-new profile is Fast-less until opted in.
    expect(makeClaudeProfile({ defaultModel: "claude-opus-5" }).fastMode).toBeUndefined();
  });

  it("no model slug appears in the eligibility decision", () => {
    // Same profile, different models — eligibility is identical, because the
    // live session decides. `default` has been observed BOTH ways upstream.
    const p = makeClaudeProfile({ defaultModel: "default", directAnthropic: true });
    const q = makeClaudeProfile({ defaultModel: "claude-sonnet-5", directAnthropic: true });
    expect(p.fastMode).toEqual(q.fastMode);
  });
});

// --------------------------------------------------------------------------
// 4 + 6: reset semantics, mutation, audit, persistence
// --------------------------------------------------------------------------

describe("#37 contract 4 — reset semantics", () => {
  it("a Fast change forces a fresh session with its own reason", () => {
    expect(
      detectSessionReset({
        previousAgentId: "claude",
        nextAgentId: "claude",
        modelChanged: false,
        fastModeChanged: true,
      })
    ).toEqual({ sessionReset: true, resetReason: "fast-mode-switch" });
  });

  it("an unchanged Fast does not reset", () => {
    expect(
      detectSessionReset({
        previousAgentId: "claude",
        nextAgentId: "claude",
        modelChanged: false,
        fastModeChanged: false,
      })
    ).toEqual({ sessionReset: false });
  });

  it("an agent switch still wins the reason", () => {
    expect(
      detectSessionReset({
        previousAgentId: "claude",
        nextAgentId: "codex",
        modelChanged: true,
        fastModeChanged: true,
      })
    ).toEqual({ sessionReset: true, resetReason: "agent-switch" });
  });
});

describe("#37 contract 6 — persistence round-trip", () => {
  it("a thread preset accepts fastMode and a channel preset refuses it", () => {
    const ok = PresetsFileSchema.safeParse({
      threads: { "123456789012345678": { fastMode: true } },
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.threads["123456789012345678"]!.fastMode).toBe(true);

    const bad = PresetsFileSchema.safeParse({
      channels: { "123456789012345678": { fastMode: true } },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(JSON.stringify(bad.error.issues)).toMatch(/thread-only/);
    }
  });

  it("an omitted fastMode round-trips as off", () => {
    const parsed = PresetsFileSchema.parse({
      threads: { "123456789012345678": { detached: true } },
    });
    expect(parsed.threads["123456789012345678"]!.fastMode).toBe(false);
  });
});

describe("#37 contract 6 — canonical mutation writes an auditable field", () => {
  function service(seed: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-fast-"));
    const file = path.join(dir, "channel-presets.json");
    fs.writeFileSync(file, JSON.stringify(seed), "utf8");
    const store = new SessionStore(path.join(dir, "test.db"));
    const svc = new ConfigMutationService({
      store,
      describeConfig: (() => ({})) as never,
      profiles: [],
      defaultModel: "claude-opus-5",
      presetsFile: file,
      tierCEnabled: true,
      reloadPresets: () => ({ ok: true }),
      reschedule: () => {},
      defaultTimezone: "America/Chicago",
      cleanupScheduleAttachments: () => {},
      logger: silent,
    } as never);
    return {
      svc,
      file,
      audits: () => store.listConfigMutations(50),
      cleanup: () => {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("turning Fast on writes the key, warns about cost + reset, and audits before→after", () => {
    const { svc, file, audits, cleanup } = service({ threads: {} });
    try {
      const res = svc.applyThreadOverlay({
        threadId: "123456789012345678",
        changes: { fastMode: true },
        actor: { id: "u1", name: "jesse" },
      });
      expect(res.ok).toBe(true);
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(doc.threads["123456789012345678"].fastMode).toBe(true);

      const audit = audits()[0]!;
      expect(audit.tier).toBe("thread-preset");
      expect(audit.summary).toMatch(/fastMode/);
      expect(JSON.parse(audit.beforeJson ?? "{}").thread?.fastMode).toBeUndefined();
      expect(JSON.parse(audit.afterJson ?? "{}").thread?.fastMode).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("turning Fast off removes the key rather than serializing false", () => {
    const { svc, file, cleanup } = service({
      threads: { "123456789012345678": { fastMode: true } },
    });
    try {
      svc.applyThreadOverlay({
        threadId: "123456789012345678",
        changes: { fastMode: false },
        actor: { id: "u1", name: "jesse" },
      });
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(doc.threads["123456789012345678"]?.fastMode).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("an unchanged Fast is a no-op, not a write", () => {
    const { svc, audits, cleanup } = service({ threads: {} });

    try {
      const res = svc.applyThreadOverlay({
        threadId: "123456789012345678",
        changes: { fastMode: false },
        actor: { id: "u1", name: "jesse" },
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.auditId).toBe("");
      expect(audits()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("the proposal restarts the session and carries both notices", () => {
    const { svc, cleanup } = service({ threads: {} });
    try {
      const built = (
        svc as unknown as {
          buildThreadPresetProposalFor: (
            t: string,
            p: string | undefined,
            c: Record<string, unknown>,
            o: Record<string, unknown>
          ) => { ok: boolean; proposal?: { restartsSession: boolean; warnings: string[] } };
        }
      ).buildThreadPresetProposalFor(
        "123456789012345678",
        undefined,
        { fastMode: true },
        { requireTierC: false }
      );
      expect(built.ok).toBe(true);
      expect(built.proposal!.restartsSession).toBe(true);
      expect(built.proposal!.warnings).toContain(FAST_MODE_COST_WARNING);
      expect(built.proposal!.warnings).toContain(FAST_MODE_RESET_NOTICE);
    } finally {
      cleanup();
    }
  });
});

// --------------------------------------------------------------------------
// 6: config editor card
// --------------------------------------------------------------------------

const WITHOUT: InheritedConfig = {
  location: "local",
  agent: "claude",
  model: "claude-opus-5",
  effort: null,
  cwd: "/repo",
  permission: "ask",
  detached: false,
  fastMode: false,
  statusCardStyle: "full",
  simpleCardGif: false,
  role: null,
  disableThreadPrefix: false,
};

function setting<T>(value: T, source: ConfigDescription["agent"]["source"] = "default") {
  return { value, source };
}

function snapshot(over: Partial<ThreadConfigSnapshot> = {}): ThreadConfigSnapshot {
  return {
    location: setting("local"),
    agent: setting("claude", "session config"),
    model: setting("claude-opus-5", "session config"),
    effort: setting(null),
    cwd: setting("/repo", "session config"),
    permission: setting("ask"),
    detached: setting(false),
    fastMode: setting(false),
    statusCardStyle: setting("full"),
    simpleCardGif: setting(false),
    role: setting(null),
    disableThreadPrefix: setting(false),
    rider: {},
    locked: false,
    channelPins: {},
    withoutThread: { ...WITHOUT },
    ...over,
  };
}

function draft(over: Partial<ThreadConfigDraft> = {}): ThreadConfigDraft {
  const now = Date.now();
  return {
    id: "d1",
    threadId: "t1",
    parentRef: "c1",
    userId: "u1",
    messageId: "m1",
    createdAt: now,
    updatedAt: now,
    snapshot: snapshot(),
    overlay: {},
    warnings: [],
    ...over,
  };
}

const caps = (): DraftAgentCapabilities | undefined => undefined;

describe("#37 contract 6 — /seam config edit card", () => {
  it("renders a Fast field that is off by default and a Fast control", () => {
    const panel = renderHub(draft());
    expect(panel.fields.find((f) => f.name === "Fast")!.value).toMatch(/`off`/);
    const fast = panel.actions!.flat().find((b) => b.label === "Fast")!;
    expect(fast).toBeDefined();
    expect(fast.disabled).not.toBe(true);
  });

  it("disables the control for an agent without Fast", () => {
    const panel = renderHub(draft(), { fastDisabled: true });
    expect(panel.actions!.flat().find((b) => b.label === "Fast")!.disabled).toBe(true);
  });

  it("the picker writes the overlay and the card previews cost + reset", () => {
    const on = applyPickerValue(draft(), "fast", FAST_MODE_ON, caps);
    expect(on.overlay.fastMode).toBe(true);
    expect(dirtyThreadPresetChanges(on)).toEqual({ fastMode: true });
    expect(willEnableFastMode(on)).toBe(true);
    expect(willResetSession(on)).toBe(true);

    const panel = renderHub(on);
    expect(panel.fields.find((f) => f.name === "Fast")!.value).toMatch(/paid credits/);
    expect(panel.footer).toMatch(/Fast mode is applied to a fresh session/);
    expect(panel.footer).toContain(FAST_MODE_COST_WARNING);
  });

  it("turning Fast off also resets, but carries no cost warning", () => {
    const started = draft({ snapshot: snapshot({ fastMode: setting(true, "thread preset") }) });
    const off = applyPickerValue(started, "fast", FAST_MODE_OFF, caps);
    expect(off.overlay.fastMode).toBe(false);
    expect(dirtyThreadPresetChanges(off)).toEqual({ fastMode: false });
    expect(willResetSession(off)).toBe(true);
    expect(willEnableFastMode(off)).toBe(false);
    expect(renderHub(off).footer).not.toContain(FAST_MODE_COST_WARNING);
  });

  it("re-selecting the current value is not a change", () => {
    const same = applyPickerValue(draft(), "fast", FAST_MODE_OFF, caps);
    expect(dirtyThreadPresetChanges(same)).toEqual({});
    expect(willResetSession(same)).toBe(false);
  });

  it("Fast is thread-only: the channel scope refuses to write it", () => {
    const chan = draft({ editScope: "channel" });
    expect(applyPickerValue(chan, "fast", FAST_MODE_ON, caps).overlay.fastMode).toBeUndefined();
    expect(renderHub(chan).fields.find((f) => f.name === "Fast")!.value).toMatch(/per-thread/);
    expect(renderHub(chan).actions!.flat().find((b) => b.label === "Fast")!.disabled).toBe(true);
  });
});

describe("#37 contract 6 — status card", () => {
  const base = {
    state: "Working" as const,
    repoDisplay: "repo",
    model: "claude-opus-5",
    action: "thinking",
    elapsedSeconds: 3,
  };

  it("shows a fast badge only when Fast is relevant", () => {
    expect(discordRenderer.statusPanel({ ...base }).footer).not.toMatch(/fast/);
    expect(discordRenderer.statusPanel({ ...base, fastMode: "on" }).footer).toMatch(/⚡ fast on/);
    expect(
      discordRenderer.statusPanel({ ...base, fastMode: "on requested · off applied" }).footer
    ).toMatch(/⚡ fast on requested · off applied/);
  });
});

// --------------------------------------------------------------------------
// 4 + 3 + 5: configure_thread (cross-thread MCP control)
// --------------------------------------------------------------------------

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "discord:target",
    platform: "discord",
    channelRef: "target",
    parentRef: "channel",
    agentId: "claude",
    acpSessionId: "session-old",
    repoPath: "/repo",
    configJson: JSON.stringify({ model: "claude-opus-5" }),
    createdUtc: "2026-09-01T00:00:00.000Z",
    updatedUtc: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function ctrlHarness(opts: {
  /** Whether the freshly forged session advertises `fast`. */
  freshAdvertisesFast?: boolean;
  /** Thread-preset fastMode before the call. */
  fastMode?: boolean;
  agents?: Array<{ id: string; models: string[]; fast: boolean }>;
} = {}) {
  const agents = opts.agents ?? [
    { id: "claude", models: ["claude-opus-5", "claude-sonnet-5"], fast: true },
    { id: "codex", models: ["gpt-old", "gpt-new"], fast: false },
  ];
  const byId = new Map<string, AgentProfile>(
    agents.map((a) => [
      a.id,
      {
        id: a.id,
        defaultModel: a.models[0]!,
        staticModels: a.models.map((modelId) => ({ modelId, name: modelId })),
        effort: { mechanism: "meta", levels: ["low", "high"] },
        ...(a.fast ? { fastMode: CLAUDE_FAST_MODE } : {}),
      } as AgentProfile,
    ])
  );
  const target = record();
  const caller = record({ id: "discord:caller", channelRef: "caller" });
  const records = new Map([[target.id, target], [caller.id, caller]]);
  const overlays: Array<Record<string, unknown>> = [];
  const invalidated: string[] = [];
  // Thread-preset state the fake describeConfig resolves from.
  let fastPreset = opts.fastMode === true;
  const advertises = opts.freshAdvertisesFast !== false;

  const describeConfig = (value: SessionRecord): ConfigDescription => {
    const current = records.get(value.id) ?? value;
    const cfg = JSON.parse(current.configJson || "{}") as SessionConfigState;
    return {
      sessionId: current.id,
      channelRef: current.channelRef,
      parentRef: current.parentRef,
      agent: { value: current.agentId, source: "session config" },
      model: { value: cfg.model ?? "claude-opus-5", source: "session config" },
      effort: { value: cfg.reasoningEffort ?? null, source: "default" },
      role: { value: null, source: "default" },
      disableThreadPrefix: { value: false, source: "default" },
      fastMode: { value: fastPreset, source: fastPreset ? "thread preset" : "default" },
    } as ConfigDescription;
  };

  const deps: ThreadSessionControlDeps = {
    store: {
      get: (id) => records.get(id),
      readConfig: (v) => JSON.parse(v.configJson || "{}") as SessionConfigState,
      writeConfig: (v) => JSON.stringify(v),
      upsert: (v) => { records.set(v.id, v); },
    },
    router: {
      describeConfig,
      getProfile: (id) => byId.get(id),
      invalidate: async (id) => { invalidated.push(id); },
      getOrStartRuntime: async (value) => {
        const current = records.get(value.id) ?? value;
        const sessionId = current.acpSessionId || "session-fresh";
        if (!current.acpSessionId) {
          records.set(current.id, { ...current, acpSessionId: sessionId });
        }
        const profile = byId.get(current.agentId)!;
        // The runtime mirrors production: it applies Fast on a FRESH session
        // only, and only when the session advertises the option.
        const canFast = profile.fastMode !== undefined && advertises;
        const rt: SessionControlRuntime = {
          getSessionInfo: () => ({
            sessionId,
            availableModels: profile.staticModels?.map((m) => ({ modelId: m.modelId })) ?? [],
          }),
          getConfigSelectValues: (id) =>
            id === FAST_MODE_CONFIG_ID && canFast ? [FAST_MODE_ON, FAST_MODE_OFF] : [],
          getFastModeOutcome: () =>
            fastPreset
              ? canFast
                ? { requested: true, applied: true }
                : { requested: true, applied: false }
              : { requested: false, applied: false },
          setModel: async () => {},
          setConfigOption: async () => {},
        };
        return rt;
      },
    },
    mutation: {
      applyThreadOverlay: ({ changes }) => {
        overlays.push(changes);
        if (changes.fastMode !== undefined) fastPreset = changes.fastMode === true;
        return { ok: true, message: "ok", auditId: "a1" };
      },
      applySessionConfig: () => ({
        ok: true,
        result: { ok: true, message: "ok", auditId: "a2", fields: [], warnings: [] },
      }),
    },
    applyThreadName: vi.fn(async () => ({})),
  };

  return {
    caller,
    target,
    overlays,
    invalidated,
    records,
    fastPresetNow: () => fastPreset,
    service: new ThreadSessionControlService(deps),
  };
}

describe("#37 configure_thread", () => {
  it("enabling Fast on a supported session forges a fresh session and reports it applied", async () => {
    const h = ctrlHarness();
    const res = await h.service.configure(h.caller, h.target, { fastMode: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.applied.fastMode).toBe(true);
    expect(res.changes.fastMode).toEqual({ before: "off", after: "on", changed: true });
    expect(res.sessionReset).toBe(true);
    expect(res.resetReason).toBe("fast-mode-switch");
    expect(h.overlays).toContainEqual({ fastMode: true });
    expect(h.invalidated).toContain(h.target.id);
    expect(res.warnings.join(" ")).toContain(FAST_MODE_COST_WARNING);
  });

  it("an unchanged Fast reports (no change) and does not reset", async () => {
    const h = ctrlHarness({ fastMode: true });
    const res = await h.service.configure(h.caller, h.target, { fastMode: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changes.fastMode).toEqual({ before: "on", after: "on", changed: false });
    expect(res.sessionReset).toBe(false);
    expect(h.invalidated).toEqual([]);
    expect(h.overlays).toEqual([]);
  });

  it("an unsupported live session rolls the flag back instead of confirming", async () => {
    const h = ctrlHarness({ freshAdvertisesFast: false });
    const res = await h.service.configure(h.caller, h.target, { fastMode: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Reported state matches the SESSION, not the request.
    expect(res.applied.fastMode).toBe(false);
    expect(res.changes.fastMode.changed).toBe(false);
    expect(res.warnings.join(" ")).toMatch(/does not advertise config id "fast"/);
    // And the persisted flag was actually reverted.
    expect(h.overlays).toContainEqual({ fastMode: false });
    expect(h.fastPresetNow()).toBe(false);
  });

  it("a model switch that loses Fast support rolls back even though Fast did not change", async () => {
    // QA regression: gating rollback on `fastModeChanged` left Fast persisted
    // `true` after an Opus → Sonnet switch with no user-visible signal. Fast is
    // validated per session AND per model, so the switch must forge a fresh
    // session and re-validate — even though the Fast SETTING did not change.
    const h = ctrlHarness({ fastMode: true, freshAdvertisesFast: false });
    const res = await h.service.configure(h.caller, h.target, {
      model: "claude-sonnet-5", // same agent (still Fast-capable), model is not
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sessionReset).toBe(true);
    expect(res.applied.fastMode).toBe(false);
    expect(res.changes.fastMode).toEqual({ before: "on", after: "off", changed: true });
    expect(res.warnings.join(" ")).toMatch(/does not advertise config id "fast"/);
    // The persisted flag was actually rolled back, not just reported.
    expect(h.overlays).toContainEqual({ fastMode: false });
    expect(h.fastPresetNow()).toBe(false);
  });

  it("a model switch that KEEPS Fast support leaves it on and still re-validates", async () => {
    const h = ctrlHarness({ fastMode: true });
    const res = await h.service.configure(h.caller, h.target, { model: "claude-sonnet-5" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sessionReset).toBe(true);
    expect(res.applied.fastMode).toBe(true);
    expect(res.changes.fastMode.changed).toBe(false);
    expect(h.fastPresetNow()).toBe(true);
  });

  it("a model switch with Fast OFF still uses normal Claude live-config semantics", async () => {
    const h = ctrlHarness();
    const res = await h.service.configure(h.caller, h.target, { model: "claude-sonnet-5" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No Fast in play ⇒ no forced reset; Claude keeps its context.
    expect(res.sessionReset).toBe(false);
  });

  it("refuses an enable for an agent with no Fast, changing nothing", async () => {
    const h = ctrlHarness();
    const res = await h.service.configure(h.caller, h.target, {
      agent: "codex",
      fastMode: true,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Claude-only serving mode/);
    expect(h.overlays).toEqual([]);
    expect(h.invalidated).toEqual([]);
  });

  it("refuses an enable when the environment kill switch is set", async () => {
    const prev = process.env[FAST_MODE_DISABLE_ENV];
    process.env[FAST_MODE_DISABLE_ENV] = "1";
    try {
      const h = ctrlHarness();
      const res = await h.service.configure(h.caller, h.target, { fastMode: true });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain(FAST_MODE_DISABLE_ENV);
      expect(h.overlays).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env[FAST_MODE_DISABLE_ENV];
      else process.env[FAST_MODE_DISABLE_ENV] = prev;
    }
  });

  it("turning Fast OFF is allowed even for an agent that never had it", async () => {
    const h = ctrlHarness({ agents: [{ id: "claude", models: ["claude-opus-5"], fast: false }] });
    const res = await h.service.configure(h.caller, h.target, { fastMode: false });
    // Already off ⇒ an honest no-op, not a refusal.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changes.fastMode.changed).toBe(false);
    expect(res.applied.fastMode).toBe(false);
  });

  it("switching to an agent without Fast turns an inherited Fast off with a warning", async () => {
    const h = ctrlHarness({ fastMode: true });
    const res = await h.service.configure(h.caller, h.target, { agent: "codex" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.applied.fastMode).toBe(false);
    expect(res.changes.fastMode).toEqual({ before: "on", after: "off", changed: true });
    expect(res.warnings.join(" ")).toMatch(/has no Fast mode/);
  });

  it("a fastMode-only call is accepted (not rejected as an empty request)", async () => {
    const h = ctrlHarness();
    const res = await h.service.configure(h.caller, h.target, { fastMode: true });
    expect(res.ok).toBe(true);
  });
});

// --------------------------------------------------------------------------
// The Discord `/seam config edit` SAVE transaction (#37)
//
// The most intricate path in the change: reset the session, start the
// replacement, read the outcome, roll back on refusal, correct the card, and
// surface the refusal. Driven through the real `saveConfigEditorDraft`.
// --------------------------------------------------------------------------

function saveHarness(opts: {
  /** Whether the replacement session advertises `fast`. */
  freshAdvertisesFast?: boolean;
  /** Persisted thread-preset fastMode before the save. */
  fastMode?: boolean;
  model?: string;
  /** Make the replacement runtime fail to start. */
  failFreshStart?: boolean;
} = {}) {
  const advertises = opts.freshAdvertisesFast !== false;
  let fastPreset = opts.fastMode === true;
  let model = opts.model ?? "claude-opus-5";
  const overlays: Array<Record<string, unknown>> = [];
  const invalidated: Array<{ id: string; opts: unknown }> = [];
  const editedPanels: Array<{ id: string; panel: any }> = [];
  const ephemerals: string[] = [];
  const started: string[] = [];

  const rec: SessionRecord = {
    id: "discord:t1",
    platform: "discord",
    channelRef: "t1",
    parentRef: "c1",
    agentId: "claude",
    acpSessionId: "acp-old",
    repoPath: "/repo",
    configJson: "{}",
    createdUtc: "2026-09-01T00:00:00.000Z",
    updatedUtc: "2026-09-01T00:00:00.000Z",
  };

  const orch = {
    store: {
      getByChannel: () => rec,
      get: () => rec,
      readConfig: () => ({}),
    },
    router: {
      invalidate: async (id: string, o: unknown) => {
        invalidated.push({ id, opts: o });
        rec.acpSessionId = "";
      },
      getOrStartRuntime: async () => {
        if (opts.failFreshStart) throw new Error("replacement unavailable");
        started.push("start");
        rec.acpSessionId = "acp-fresh";
        return {
          getFastModeOutcome: () =>
            fastPreset
              ? advertises
                ? { requested: true, applied: true }
                : { requested: true, applied: false }
              : { requested: false, applied: false },
          getConfigSelectValues: (id: string) =>
            id === FAST_MODE_CONFIG_ID && advertises ? [FAST_MODE_ON, FAST_MODE_OFF] : [],
        };
      },
      describeConfig: () => ({
        agent: { value: "claude", source: "session config" },
        model: { value: model, source: "session config" },
      }),
      ensureSessionRecord: () => rec,
    },
    configMutation: {
      applyThreadOverlay: ({ changes }: { changes: Record<string, unknown> }) => {
        overlays.push(changes);
        if (changes.fastMode !== undefined) fastPreset = changes.fastMode === true;
        if (typeof changes.model === "string") model = changes.model;
        return { ok: true, message: "ok", auditId: "a1" };
      },
      applyChannelOverlay: () => ({ ok: true, message: "ok", auditId: "a2" }),
    },
    configEditor: { delete: () => {} },
    threadNamer: { recompactChannel: async () => {} },
    applyThreadName: async () => ({}),
    renameThreadForSetup: async () => {},
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    adapter: {
      editPanel: async (ref: { id: string }, panel: unknown) => {
        editedPanels.push({ id: ref.id, panel });
      },
    },
    editConfigEditorCard: async (_ch: unknown, id: string, panel: unknown) => {
      editedPanels.push({ id, panel });
    },
    saveConfigEditorDraft: (Orchestrator.prototype as any).saveConfigEditorDraft,
  } as any;

  const evt = {
    userId: "u1",
    userName: "jesse",
    channel: { platform: "discord", id: "t1", parentId: "c1" },
    messageId: "m1",
    followUpEphemeral: async (t: string) => { ephemerals.push(t); },
    replyEphemeral: async (t: string) => { ephemerals.push(t); },
    deferUpdate: async () => {},
  } as any;

  return {
    orch,
    evt,
    overlays,
    invalidated,
    editedPanels,
    ephemerals,
    started,
    fastPresetNow: () => fastPreset,
    run: (d: ThreadConfigDraft) => orch.saveConfigEditorDraft.call(orch, d, evt),
  };
}

describe("#37 — /seam config edit Save transaction", () => {
  it("a supported fresh session keeps Fast on, resets the session, and does not refuse", async () => {
    const h = saveHarness();
    await h.run(applyPickerValue(draft(), "fast", FAST_MODE_ON, caps));
    expect(h.overlays).toContainEqual({ fastMode: true });
    expect(h.invalidated[0]).toMatchObject({
      id: "discord:t1",
      opts: { clearAcpSession: true },
    });
    expect(h.started).toHaveLength(1);
    expect(h.ephemerals).toEqual([]);
    expect(h.fastPresetNow()).toBe(true);
    expect(h.editedPanels.at(-1)!.panel.footer).toMatch(/Saved/);
  });

  it("an unsupported fresh session rolls back and the saved card renders off", async () => {
    const h = saveHarness({ freshAdvertisesFast: false });
    await h.run(applyPickerValue(draft(), "fast", FAST_MODE_ON, caps));
    // Persisted true, then reverted — no stale requested state survives.
    expect(h.overlays).toContainEqual({ fastMode: true });
    expect(h.overlays).toContainEqual({ fastMode: false });
    expect(h.fastPresetNow()).toBe(false);
    expect(h.ephemerals.join(" ")).toMatch(/does not advertise config id "fast"/);
    const card = h.editedPanels.at(-1)!.panel;
    expect(card.fields.find((f: any) => f.name === "Fast").value).toMatch(/`off`/);
  });

  it("a replacement session that fails to start refuses instead of silently succeeding", async () => {
    const h = saveHarness({ failFreshStart: true });
    await h.run(applyPickerValue(draft(), "fast", FAST_MODE_ON, caps));
    expect(h.ephemerals.join(" ")).toMatch(/could not be verified/i);
    expect(h.overlays).toContainEqual({ fastMode: false });
    expect(h.fastPresetNow()).toBe(false);
  });

  it("BLOCKER regression: a model-only change with Fast already on re-verifies and rolls back", async () => {
    // Opus 5 (Fast on) → Sonnet 5. The Fast SETTING does not move, so the old
    // gate skipped reset + verification and left `fastMode: true` persisted
    // against a session that never offered it.
    const started = draft({
      snapshot: snapshot({
        fastMode: setting(true, "thread preset"),
        model: setting("claude-opus-5", "session config"),
      }),
    });
    const withModel: ThreadConfigDraft = {
      ...started,
      overlay: { model: "claude-sonnet-5" },
    };
    expect(willResetSession(withModel)).toBe(true);
    expect(willVerifyFastMode(withModel)).toBe(true);

    const h = saveHarness({ fastMode: true, freshAdvertisesFast: false });
    await h.run(withModel);
    expect(h.invalidated).toHaveLength(1);
    expect(h.started).toHaveLength(1);
    expect(h.overlays).toContainEqual({ fastMode: false });
    expect(h.fastPresetNow()).toBe(false);
    expect(h.ephemerals.join(" ")).toMatch(/does not advertise config id "fast"/);
  });

  it("a model-only change with Fast OFF does not reset or start anything", async () => {
    const plain: ThreadConfigDraft = { ...draft(), overlay: { model: "claude-sonnet-5" } };
    expect(willResetSession(plain)).toBe(false);
    expect(willVerifyFastMode(plain)).toBe(false);

    const h = saveHarness();
    await h.run(plain);
    expect(h.invalidated).toEqual([]);
    expect(h.started).toEqual([]);
    expect(h.ephemerals).toEqual([]);
  });

  it("turning Fast OFF resets the session but never needs verification", async () => {
    const started = draft({ snapshot: snapshot({ fastMode: setting(true, "thread preset") }) });
    const off = applyPickerValue(started, "fast", FAST_MODE_OFF, caps);
    expect(willVerifyFastMode(off)).toBe(false);

    const h = saveHarness({ fastMode: true });
    await h.run(off);
    expect(h.invalidated).toHaveLength(1);
    expect(h.started).toEqual([]);
    expect(h.ephemerals).toEqual([]);
  });
});
