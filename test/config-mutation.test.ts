import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../src/core/session-store.js";
import { ConfigMutationService } from "../src/core/config-mutation.js";
import { reloadChannelPresets } from "../src/core/config-reload.js";
import { PresetsFileSchema } from "../src/config.js";
import type { ChannelPreset, ThreadPreset } from "../src/config.js";
import type { ConfigDescription } from "../src/core/session-router.js";
import type { AgentProfile } from "../src/agents/agent-profile.js";
import type { SessionRecord } from "../src/core/types.js";
import type { ScheduledPrompt } from "../src/core/scheduled-prompts/types.js";
import type { Logger } from "../src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;

function makeRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "discord:thread-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    agentId: "claude",
    acpSessionId: "acp-1",
    repoPath: "/repo",
    configJson: JSON.stringify({ model: "gpt-5.4", permissionPolicy: "ask" }),
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
    ...over,
  };
}

// A profile whose effort supports "high"/"low" — enough to exercise Trap 2.
const claudeProfile = {
  id: "claude",
  effort: { mechanism: "meta", levels: ["low", "high"] },
} as unknown as AgentProfile;
const profiles = new Map<string, AgentProfile>([["claude", claudeProfile]]);

/** describeConfig stub that re-derives effective values from the CURRENT stored
 *  config, so before/after genuinely differ across an apply. */
function describeConfig(record: SessionRecord): ConfigDescription {
  const cfg = store.readConfig(record);
  return {
    sessionId: record.id,
    channelRef: record.channelRef,
    parentRef: record.parentRef,
    agent: { value: record.agentId, source: "session config" },
    model: cfg.model
      ? { value: cfg.model, source: "session config" }
      : { value: "default-model", source: "default" },
    effort: cfg.reasoningEffort
      ? { value: cfg.reasoningEffort, source: "session config" }
      : { value: null, source: "default" },
    cwd: record.repoPath
      ? { value: record.repoPath, source: "session config" }
      : { value: "/cwd", source: "default" },
    permission: cfg.permissionPolicy
      ? { value: cfg.permissionPolicy, source: "session config" }
      : { value: "ask", source: "default" },
    locked: false,
  };
}

/** Ids passed to `reschedule` (the timer-arm hook), so a test can assert the
 *  HARD REQUIREMENT that every schedule write re-arms the manager. */
let rescheduled: string[] = [];
/** Ids whose on-disk attachments were cleaned up (delete path). */
let cleanedUp: string[] = [];

function makeService(over: {
  presetsFile?: string;
  tierCEnabled?: boolean;
  reloadPresets?: () => { ok: boolean; error?: string };
  reschedule?: (id: string) => void;
  defaultTimezone?: string;
} = {}): ConfigMutationService {
  return new ConfigMutationService({
    store,
    describeConfig,
    profiles,
    defaultModel: "gpt-5.4",
    presetsFile: over.presetsFile,
    tierCEnabled: over.tierCEnabled ?? false,
    reloadPresets: over.reloadPresets ?? (() => ({ ok: true })),
    reschedule: over.reschedule ?? ((id) => rescheduled.push(id)),
    defaultTimezone: over.defaultTimezone ?? "America/Chicago",
    cleanupScheduleAttachments: (id) => cleanedUp.push(id),
    logger: silent,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-cfgmut-"));
  store = new SessionStore(path.join(dir, "test.db"));
  rescheduled = [];
  cleanedUp = [];
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------------------
// Tier A — session config: propose is side-effect free; apply mutates + audits
// -------------------------------------------------------------------------

describe("session config mutation (Tier A)", () => {
  it("buildProposal computes a before→after diff and writes NOTHING (D5)", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();

    const built = svc.buildProposal(record, { session: { model: "claude-opus-4.8" } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.fields).toEqual([
      { label: "model", before: "gpt-5.4", after: "claude-opus-4.8" },
    ]);
    // Nothing applied yet — the stored config is unchanged.
    expect(store.readConfig(store.get(record.id)!).model).toBe("gpt-5.4");
    // Audit ledger is empty until a human confirms.
    expect(store.listConfigMutations()).toHaveLength(0);
  });

  it("apply mutates the session config and records actor/scope/before/after (D6)", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();
    const built = svc.buildProposal(record, {
      session: { model: "claude-opus-4.8", permission: "always" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const result = built.proposal.apply({ id: "user-jesse", name: "Jesse" });
    expect(result.ok).toBe(true);

    const after = store.readConfig(store.get(record.id)!);
    expect(after.model).toBe("claude-opus-4.8");
    expect(after.permissionPolicy).toBe("always");

    const audit = store.listConfigMutations();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tier: "session",
      actorId: "user-jesse",
      actorName: "Jesse",
      scope: "thread-1",
    });
    expect(audit[0]!.beforeJson).toContain("gpt-5.4");
    expect(audit[0]!.afterJson).toContain("claude-opus-4.8");
    expect(audit[0]!.correlationId).toBe(built.proposal.id);
  });

  it("refuses an unknown agent", () => {
    const record = makeRecord();
    store.upsert(record);
    const built = makeService().buildProposal(record, { session: { agent: "nope" } });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("Unknown agent");
  });

  it("warns and ignores an effort the agent cannot honor (Trap 2)", () => {
    const record = makeRecord();
    store.upsert(record);
    const built = makeService().buildProposal(record, { session: { effort: "ultra" } });
    // "ultra" isn't a level → no effective change, refused with a clear reason.
    expect(built.ok).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Tier B — preset create/update
// -------------------------------------------------------------------------

describe("preset mutation (Tier B)", () => {
  it("creates a project-scoped preset only on apply", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();
    const built = svc.buildProposal(record, {
      preset: { name: "reviewer", agent: "claude", model: "claude-opus-4.8" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Not created before apply.
    expect(store.getPresetByNameScoped("reviewer", record.parentRef)).toBeNull();

    built.proposal.apply({ id: "user-jesse", name: "Jesse" });
    const preset = store.getPresetByNameScoped("reviewer", record.parentRef);
    expect(preset).not.toBeNull();
    expect(preset!.agentId).toBe("claude");
    expect(preset!.projectRef).toBe("chan-1");
    expect(store.listConfigMutations()[0]!.tier).toBe("preset");
  });

  it("refuses the inert `instructions` field rather than promise a no-op", () => {
    const record = makeRecord();
    store.upsert(record);
    const built = makeService().buildProposal(record, {
      preset: { name: "x", instructions: "be terse" } as never,
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("instructions");
  });
});

// -------------------------------------------------------------------------
// Tier C — channel-presets.json (flag-gated, D7 validated, lock untouchable)
// -------------------------------------------------------------------------

describe("channel-preset mutation (Tier C)", () => {
  function writePresetsFile(doc: unknown): string {
    const file = path.join(dir, "channel-presets.json");
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    return file;
  }

  it("is refused when the Tier-C flag is off", () => {
    const record = makeRecord();
    const file = writePresetsFile({ channels: {} });
    const built = makeService({ presetsFile: file, tierCEnabled: false }).buildProposal(record, {
      channelPreset: { model: "claude-opus-4.8" },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("disabled");
  });

  // Channel-presets keys must be numeric Discord ids (PresetsFileSchema).
  const CHAN = "111111111111111111";
  const OTHER = "222222222222222222";

  it("writes a file that always passes PresetsFileSchema and preserves `locked` + other channels (D7/D2)", () => {
    const record = makeRecord({ parentRef: CHAN });
    const file = writePresetsFile({
      channels: {
        [CHAN]: { model: { value: "old-model" }, locked: true },
        [OTHER]: { agent: { value: "copilot" } },
      },
    });
    // Live maps + real hot-reload, so we also prove the swap takes effect.
    const live = { channelPresets: new Map<string, ChannelPreset>(), threadPresets: new Map<string, ThreadPreset>() };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: true,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });

    const built = svc.buildProposal(record, { channelPreset: { model: "claude-opus-4.8", rider: "stay in your lane" } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });

    // The written file round-trips through the exact boot schema.
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(PresetsFileSchema.safeParse(raw).success).toBe(true);

    // This channel's model changed; its lock is preserved; the other channel is intact.
    expect(raw.channels[CHAN].model.value).toBe("claude-opus-4.8");
    expect(raw.channels[CHAN].locked).toBe(true);
    expect(raw.channels[OTHER].agent.value).toBe("copilot");

    // The live map observed the swap (hot-reload, no redeploy).
    expect(live.channelPresets.get(CHAN)?.model?.value).toBe("claude-opus-4.8");
    expect(live.channelPresets.get(CHAN)?.locked).toBe(true);

    expect(store.listConfigMutations()[0]).toMatchObject({ tier: "channel-preset", scope: CHAN });
  });

  it("never lets the `locked` flag be set through the tool (D2/P3)", () => {
    const record = makeRecord({ parentRef: CHAN });
    const file = writePresetsFile({ channels: { [CHAN]: { model: { value: "m" } } } });
    const built = makeService({ presetsFile: file, tierCEnabled: true }).buildProposal(record, {
      channelPreset: { locked: false } as never,
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.toLowerCase()).toContain("locked");
  });

  it("cannot target another channel — scope is always the caller's own parent (D3)", () => {
    // There is no channel-id parameter, so a Tier-C proposal can only ever touch
    // record.parentRef. A thread with no parent has nothing to scope to.
    const record = makeRecord({ parentRef: null });
    const file = writePresetsFile({ channels: {} });
    const built = makeService({ presetsFile: file, tierCEnabled: true }).buildProposal(record, {
      channelPreset: { model: "x" },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("no parent channel");
  });
});

// -------------------------------------------------------------------------
// Tier C — thread-level presets (#68): the `threads` map, keyed on the
// caller's OWN thread id. Same guardrails as the channel branch (flag, D7
// schema round-trip, atomic write, hot-reload, one audit row), but a thread
// preset overrides the channel preset and never touches `locked`.
// -------------------------------------------------------------------------

describe("thread-preset mutation (Tier C, #68)", () => {
  function writePresetsFile(doc: unknown): string {
    const file = path.join(dir, "channel-presets.json");
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    return file;
  }

  // channel-presets keys must be numeric Discord ids (PresetsFileSchema).
  const CHAN = "111111111111111111";
  const THREAD = "333333333333333333";
  const SIBLING = "444444444444444444";

  it("is refused when the Tier-C flag is off", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({ threads: {} });
    const built = makeService({ presetsFile: file, tierCEnabled: false }).buildProposal(record, {
      threadPreset: { rider: "read-only" },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("disabled");
  });

  it("edits ONLY the caller's own thread; channel + sibling threads stay byte-identical (D3/D7)", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({
      channels: { [CHAN]: { model: { value: "chan-model" }, locked: false } },
      threads: {
        [THREAD]: { model: { value: "old-thread-model" } },
        [SIBLING]: { rider: { value: "sibling rider — must not move" } },
      },
    });
    const before = fs.readFileSync(file, "utf8");
    const live = { channelPresets: new Map<string, ChannelPreset>(), threadPresets: new Map<string, ThreadPreset>() };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: true,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });

    const built = svc.buildProposal(record, { threadPreset: { rider: "this student only" } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.tier).toBe("thread-preset");
    expect(built.proposal.scope).toBe(THREAD);

    // Side-effect free until apply (D5): the file is unchanged after buildProposal.
    expect(fs.readFileSync(file, "utf8")).toBe(before);

    built.proposal.apply({ id: "user-jesse", name: "Jesse" });

    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(PresetsFileSchema.safeParse(raw).success).toBe(true);
    // The caller's own thread got the new rider...
    expect(raw.threads[THREAD].rider.value).toBe("this student only");
    expect(raw.threads[THREAD].model.value).toBe("old-thread-model"); // untouched field preserved
    // ...and NOTHING else moved: channel entry and the sibling thread are identical.
    expect(raw.channels[CHAN]).toEqual({ model: { value: "chan-model" }, locked: false });
    expect(raw.threads[SIBLING]).toEqual({ rider: { value: "sibling rider — must not move" } });

    // Hot-reload observed the swap; the live thread map won.
    expect(live.threadPresets.get(THREAD)?.rider?.value).toBe("this student only");
    expect(live.channelPresets.get(CHAN)?.model?.value).toBe("chan-model");

    expect(store.listConfigMutations()[0]).toMatchObject({ tier: "thread-preset", scope: THREAD });
  });

  it("warns when a thread field shadows a channel value (Trap 1)", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({
      channels: { [CHAN]: { model: { value: "chan-model" } } },
      threads: {},
    });
    const built = makeService({ presetsFile: file, tierCEnabled: true }).buildProposal(record, {
      threadPreset: { model: "thread-model" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.warnings.join(" ")).toMatch(/overrides it|thread preset/i);
    expect(built.proposal.warnings.join(" ")).toContain("chan-model");
  });

  it("never lets the `locked` flag be set on a thread preset (D2/P3)", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({ threads: { [THREAD]: { model: { value: "m" } } } });
    const built = makeService({ presetsFile: file, tierCEnabled: true }).buildProposal(record, {
      threadPreset: { locked: false } as never,
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.toLowerCase()).toContain("locked");
  });

  it("refuses an invalid candidate BEFORE any file write (D7)", () => {
    // A non-numeric thread id makes the `threads` key fail PresetsFileSchema; the
    // proposal must be refused and the on-disk file left byte-for-byte unchanged.
    const record = makeRecord({ channelRef: "not-a-numeric-id", parentRef: CHAN });
    const file = writePresetsFile({ threads: {} });
    const before = fs.readFileSync(file, "utf8");
    const built = makeService({ presetsFile: file, tierCEnabled: true }).buildProposal(record, {
      threadPreset: { model: "m" },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("invalid");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("removing a field with null drops it and reports (removed)", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({ threads: { [THREAD]: { rider: { value: "gone soon" } } } });
    const built = makeService({ presetsFile: file, tierCEnabled: true }).buildProposal(record, {
      threadPreset: { rider: null },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.fields).toEqual([{ label: "rider", before: "gone soon", after: "(removed)" }]);
    built.proposal.apply({ id: "u", name: "U" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.threads[THREAD]?.rider).toBeUndefined();
  });

  it("refuses when there is no effective change", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({ threads: { [THREAD]: { model: { value: "same" } } } });
    const built = makeService({ presetsFile: file, tierCEnabled: true }).buildProposal(record, {
      threadPreset: { model: "same" },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("No effective change");
  });
});

// -------------------------------------------------------------------------
// Tier D — scheduled prompts: NL→cron write, validate-before-persist, re-arm
// -------------------------------------------------------------------------

describe("scheduled-prompt mutation (Tier D)", () => {
  function seedSchedule(over: Partial<ScheduledPrompt> = {}): ScheduledPrompt {
    const row: ScheduledPrompt = {
      id: "sch_seed01",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: "chan-1",
      name: "Morning brief",
      promptText: "Summarize overnight PRs",
      cron: "0 7 * * 1-5",
      timezone: "America/Chicago",
      model: null,
      cwd: null,
      targetChannel: null,
      outputType: "card",
      sessionMode: "isolated",
      catchupSeconds: 7200,
      enabled: true,
      attachments: [],
      createdBy: "user-jesse",
      createdUtc: "2026-01-01T00:00:00Z",
      updatedUtc: "2026-01-01T00:00:00Z",
      lastRunUtc: null,
      lastStatus: null,
      nextRunUtc: "2026-01-02T13:00:00Z",
      pinnedSessionId: null,
      ...over,
    };
    store.upsertScheduled(row);
    return row;
  }

  it("create: side-effect free build; apply writes the row, arms the timer, echoes next run + parsed cron (D5/#69)", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();

    // "every weekday at 7am" → the agent supplies the translated cron.
    const built = svc.buildProposal(record, {
      schedule: { action: "create", name: "Standup", promptText: "Post the standup", cron: "0 7 * * 1-5" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // The card echoes the parsed cadence AND the resolved next run (the proof).
    const labels = built.proposal.fields.map((f) => f.label);
    expect(labels).toContain("cadence");
    expect(labels).toContain("next run");
    const nextField = built.proposal.fields.find((f) => f.label === "next run")!;
    expect(nextField.after).toMatch(/^\d{4}-\d{2}-\d{2}T/); // a real ISO timestamp

    // Nothing written, nothing armed until a human confirms (D5).
    expect(store.listScheduledByChannel("discord", "thread-1")).toHaveLength(0);
    expect(rescheduled).toHaveLength(0);

    built.proposal.apply({ id: "user-jesse", name: "Jesse" });

    const rows = store.listScheduledByChannel("discord", "thread-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cron).toBe("0 7 * * 1-5");
    expect(rows[0]!.promptText).toBe("Post the standup");
    expect(rows[0]!.timezone).toBe("America/Chicago"); // deployment default
    expect(rows[0]!.nextRunUtc).not.toBeNull();
    // HARD REQUIREMENT: the timer was (re)armed for the exact new row.
    expect(rescheduled).toEqual([rows[0]!.id]);
    // Audited under the schedule tier.
    expect(store.listConfigMutations()[0]).toMatchObject({ tier: "schedule", scope: "thread-1" });
  });

  it("refuses an invalid cron BEFORE persisting — no row, no arm (#69 trap)", () => {
    const record = makeRecord();
    store.upsert(record);
    const built = makeService().buildProposal(record, {
      schedule: { action: "create", name: "Bad", promptText: "x", cron: "not a cron" },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.toLowerCase()).toContain("invalid schedule");
    expect(store.listScheduledByChannel("discord", "thread-1")).toHaveLength(0);
    expect(rescheduled).toHaveLength(0);
  });

  it("refuses a non-IANA timezone", () => {
    const record = makeRecord();
    store.upsert(record);
    const built = makeService().buildProposal(record, {
      schedule: { action: "create", name: "TZ", promptText: "x", cron: "0 7 * * *", timezone: "Mars/Phobos" },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("IANA");
  });

  it("update: recomputes next run and re-arms the timer", () => {
    const record = makeRecord();
    store.upsert(record);
    const seed = seedSchedule();
    const svc = makeService();

    const built = svc.buildProposal(record, {
      schedule: { action: "update", id: seed.id, cron: "0 9 * * 1-5" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });

    const row = store.getScheduled(seed.id)!;
    expect(row.cron).toBe("0 9 * * 1-5");
    expect(row.promptText).toBe("Summarize overnight PRs"); // preserved
    expect(rescheduled).toEqual([seed.id]);
    expect(store.listConfigMutations()[0]!.summary).toContain("update schedule");
  });

  it("enable/disable flips the row and re-arms (arm on enable, disarm on disable)", () => {
    const record = makeRecord();
    store.upsert(record);
    const seed = seedSchedule({ enabled: false });
    const svc = makeService();

    const built = svc.buildProposal(record, { schedule: { action: "enable", id: seed.id } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });

    expect(store.getScheduled(seed.id)!.enabled).toBe(true);
    expect(rescheduled).toEqual([seed.id]);

    // Enabling an already-enabled schedule is a no-op refusal.
    const again = svc.buildProposal(record, { schedule: { action: "enable", id: seed.id } });
    expect(again.ok).toBe(false);
  });

  it("delete: removes the row, disarms the timer (via reschedule), cleans attachments, audits", () => {
    const record = makeRecord();
    store.upsert(record);
    const seed = seedSchedule();
    const svc = makeService();

    const built = svc.buildProposal(record, { schedule: { action: "delete", id: seed.id } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });

    expect(store.getScheduled(seed.id)).toBeNull();
    expect(rescheduled).toEqual([seed.id]); // reschedule with row gone → disarm
    expect(cleanedUp).toEqual([seed.id]);
    expect(store.listConfigMutations()[0]).toMatchObject({ tier: "schedule" });
  });

  it("self-scope: refuses a schedule id bound to another thread (D3)", () => {
    const caller = makeRecord({ id: "discord:thread-1", channelRef: "thread-1" });
    store.upsert(caller);
    // A schedule that lives in a DIFFERENT thread.
    seedSchedule({ id: "sch_other", channelRef: "thread-2" });

    const built = makeService().buildProposal(caller, { schedule: { action: "delete", id: "sch_other" } });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("No schedule");
    // Untouched — no write, no arm.
    expect(store.getScheduled("sch_other")).not.toBeNull();
    expect(rescheduled).toHaveLength(0);
  });

  it("live mode nulls isolated-only fields and warns they're ignored", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();
    const built = svc.buildProposal(record, {
      schedule: {
        action: "create",
        name: "Live one",
        promptText: "do it here",
        cron: "0 7 * * *",
        sessionMode: "live",
        model: "claude-opus-4.8",
      },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.warnings.some((w) => w.includes("Live mode ignores"))).toBe(true);
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });
    const row = store.listScheduledByChannel("discord", "thread-1")[0]!;
    expect(row.sessionMode).toBe("live");
    expect(row.model).toBeNull();
  });
});
