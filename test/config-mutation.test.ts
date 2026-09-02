import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { reloadChannelPresets } from "../packages/core/src/core/config-reload.js";
import { PresetsFileSchema } from "../packages/core/src/config.js";
import type { ChannelPreset, ThreadPreset } from "../packages/core/src/config.js";
import type { ConfigDescription } from "../packages/core/src/core/session-router.js";
import type { AgentProfile } from "@seam/adapters";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

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
    role: cfg.role
      ? { value: cfg.role, source: "session config" }
      : { value: null, source: "default" },
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
    detached: { value: false, source: "default" },
    tts: { value: false, source: "default" },
    ttsVoice: { value: null, source: "default" },
    ttsPace: { value: "natural", source: "default" },
    ttsStyle: { value: "neutral", source: "default" },
    location: { value: "local", source: "default" },
    statusCardStyle: cfg.statusCardStyle === "simple"
      ? { value: "simple" as const, source: "session config" }
      : cfg.statusCardStyle === "full"
        ? { value: "full" as const, source: "session config" }
        : { value: "full" as const, source: "default" },
    simpleCardGif: typeof cfg.simpleCardGif === "boolean"
      ? { value: cfg.simpleCardGif, source: "session config" }
      : { value: false, source: "default" },
    disableThreadPrefix: cfg.disableThreadPrefix === true
      ? { value: true, source: "session config" }
      : { value: false, source: "default" },
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
  it("creates a project-scoped preset with a naming role only on apply", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();
    const built = svc.buildProposal(record, {
      preset: {
        name: "reviewer",
        agent: "claude",
        model: "claude-opus-4.8",
        role: "review",
      },
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
    expect(preset!.role).toBe("review");
    expect(built.proposal.fields).toContainEqual({
      label: "role",
      before: "(unset)",
      after: "review",
    });
    expect(store.listConfigMutations()[0]!.tier).toBe("preset");
    expect(store.listConfigMutations()[0]!.afterJson).toContain('"role":"review"');
  });

  it("allows `instructions` and persists it on the preset row (#72 un-block)", () => {
    const record = makeRecord();
    store.upsert(record);
    const built = makeService().buildProposal(record, {
      preset: { name: "reviewer", agent: "claude", instructions: "Be terse and adversarial." },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // The diff surfaces the identity change...
    expect(built.proposal.fields.map((f) => f.label)).toContain("instructions");
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });
    // ...and it round-trips onto the stored preset.
    const preset = store.getPresetByNameScoped("reviewer", record.parentRef);
    expect(preset!.instructions).toBe("Be terse and adversarial.");
    // Audit captures the identity in after_json.
    expect(store.listConfigMutations()[0]!.afterJson).toContain("Be terse and adversarial.");
  });

  it("sets repoPath and tool filters on a preset, and clears them with empty values", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();
    const created = svc.buildProposal(record, {
      preset: {
        name: "specialist",
        agent: "claude",
        repoPath: "/srv/proj",
        toolsAllow: ["Read", "Grep"],
        toolsExclude: ["Bash"],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    created.proposal.apply({ id: "u", name: "U" });

    const p = store.getPresetByNameScoped("specialist", record.parentRef)!;
    expect(p.repoPath).toBe(path.resolve("/srv/proj"));
    expect(p.toolsAllow).toEqual(["Read", "Grep"]);
    expect(p.toolsExclude).toEqual(["Bash"]);

    // Clear repoPath (empty string) and toolsAllow (empty array).
    const clear = svc.buildProposal(record, {
      preset: { name: "specialist", repoPath: "", toolsAllow: [] },
    });
    expect(clear.ok).toBe(true);
    if (!clear.ok) return;
    clear.proposal.apply({ id: "u", name: "U" });
    const p2 = store.getPresetByNameScoped("specialist", record.parentRef)!;
    expect(p2.repoPath).toBeNull();
    expect(p2.toolsAllow).toBeNull();
    expect(p2.toolsExclude).toEqual(["Bash"]); // untouched field preserved
  });

  it("deletes a preset through a confirm card, recording the full removed object in before_json (#72)", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();
    // Create one to delete.
    const created = svc.buildProposal(record, {
      preset: { name: "temp", agent: "claude", model: "m", instructions: "identity here" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    created.proposal.apply({ id: "u", name: "U" });
    expect(store.getPresetByNameScoped("temp", record.parentRef)).not.toBeNull();

    // Propose delete — side-effect free until apply.
    const del = svc.buildProposal(record, { preset: { action: "delete", name: "temp" } });
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.proposal.tier).toBe("preset");
    expect(del.proposal.title).toContain("Delete preset");
    // Still present before apply (D5).
    expect(store.getPresetByNameScoped("temp", record.parentRef)).not.toBeNull();

    del.proposal.apply({ id: "user-jesse", name: "Jesse" });

    // Gone.
    expect(store.getPresetByNameScoped("temp", record.parentRef)).toBeNull();
    // Audited with the FULL removed object recoverable from before_json.
    const audit = store.listConfigMutations()[0]!;
    expect(audit.tier).toBe("preset");
    expect(audit.summary).toContain("delete preset");
    expect(audit.afterJson).toContain("null");
    const before = JSON.parse(audit.beforeJson);
    expect(before).toMatchObject({
      name: "temp",
      agentId: "claude",
      model: "m",
      instructions: "identity here",
    });
  });

  it("refuses deleting a preset that does not exist in scope", () => {
    const record = makeRecord();
    store.upsert(record);
    const built = makeService().buildProposal(record, {
      preset: { action: "delete", name: "ghost" },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("No preset");
  });
});

// -------------------------------------------------------------------------
// Tier A — new field coverage (#72): mode + tool allow/exclude lists
// -------------------------------------------------------------------------

describe("session config new fields (Tier A, #72)", () => {
  it("sets mode and tool lists, restarts the session, and clears them", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();

    const set = svc.buildProposal(record, {
      session: { mode: "acp:plan", availableTools: ["Read"], excludedTools: ["Bash"] },
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.proposal.restartsSession).toBe(true);
    expect(set.proposal.fields.map((f) => f.label).sort()).toEqual([
      "availableTools",
      "excludedTools",
      "mode",
    ]);
    set.proposal.apply({ id: "u", name: "U" });

    const cfg = store.readConfig(store.get(record.id)!);
    expect(cfg.mode).toBe("acp:plan");
    expect(cfg.availableTools).toEqual(["Read"]);
    expect(cfg.excludedTools).toEqual(["Bash"]);

    // Clearing: empty string / empty array. Re-fetch the record so its configJson
    // reflects the first apply (a real turn always reads a fresh record).
    const fresh = store.get(record.id)!;
    const clear = svc.buildProposal(fresh, { session: { mode: "", availableTools: [] } });
    expect(clear.ok).toBe(true);
    if (!clear.ok) return;
    clear.proposal.apply({ id: "u", name: "U" });
    const cfg2 = store.readConfig(store.get(record.id)!);
    expect(cfg2.mode).toBeUndefined();
    expect(cfg2.availableTools).toBeUndefined();
    expect(cfg2.excludedTools).toEqual(["Bash"]); // untouched field preserved
  });
});

describe("statusCardStyle mutation (#96)", () => {
  it("sets and clears session statusCardStyle without restarting", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();
    const set = svc.buildProposal(record, { session: { statusCardStyle: "simple" } });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.proposal.restartsSession).toBe(false);
    expect(set.proposal.fields).toEqual([
      { label: "statusCardStyle", before: "(default)", after: "simple" },
    ]);
    set.proposal.apply({ id: "u", name: "U" });
    expect(store.readConfig(store.get(record.id)!).statusCardStyle).toBe("simple");

    const fresh = store.get(record.id)!;
    const clear = svc.buildProposal(fresh, { session: { statusCardStyle: null } });
    expect(clear.ok).toBe(true);
    if (!clear.ok) return;
    clear.proposal.apply({ id: "u", name: "U" });
    expect(store.readConfig(store.get(record.id)!).statusCardStyle).toBeUndefined();
  });

  it("refuses an invalid statusCardStyle", () => {
    const record = makeRecord();
    store.upsert(record);
    const built = makeService().buildProposal(record, {
      session: { statusCardStyle: "tiny" as "full" },
    });
    expect(built.ok).toBe(false);
  });

  it("bakes statusCardStyle into a preset", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();
    const built = svc.buildProposal(record, {
      preset: { name: "quiet", statusCardStyle: "simple" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    built.proposal.apply({ id: "u", name: "U" });
    expect(store.getPresetByNameScoped("quiet", record.parentRef)?.statusCardStyle).toBe(
      "simple"
    );
  });
});

describe("statusCardStyle channel/thread overlay", () => {
  function writePresetsFile(doc: unknown): string {
    const file = path.join(dir, "channel-presets.json");
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    return file;
  }
  const CHAN = "111111111111111111";
  const THREAD = "333333333333333333";

  it("applyChannelOverlay writes statusCardStyle without the Tier-C flag", () => {
    const file = writePresetsFile({ channels: { [CHAN]: { model: { value: "old" } } } });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: false,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const result = svc.applyChannelOverlay({
      channelId: CHAN,
      changes: { statusCardStyle: "simple" },
      actor: { id: "user-jesse", name: "Jesse" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(PresetsFileSchema.safeParse(raw).success).toBe(true);
    expect(raw.channels[CHAN].statusCardStyle).toEqual({ value: "simple" });
    expect(raw.channels[CHAN].model).toEqual({ value: "old" });
    expect(live.channelPresets.get(CHAN)?.statusCardStyle?.value).toBe("simple");
  });

  it("applyThreadOverlay writes statusCardStyle over a channel value", () => {
    const file = writePresetsFile({
      channels: { [CHAN]: { statusCardStyle: { value: "simple" } } },
      threads: {},
    });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: false,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const result = svc.applyThreadOverlay({
      threadId: THREAD,
      parentRef: CHAN,
      changes: { statusCardStyle: "full" },
      actor: { id: "user-jesse", name: "Jesse" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.channels[CHAN].statusCardStyle).toEqual({ value: "simple" });
    expect(raw.threads[THREAD].statusCardStyle).toEqual({ value: "full" });
    expect(live.threadPresets.get(THREAD)?.statusCardStyle?.value).toBe("full");
  });

  it("applyChannelOverlay writes role without the Tier-C flag", () => {
    const file = writePresetsFile({ channels: { [CHAN]: { model: { value: "old" } } } });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: false,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const result = svc.applyChannelOverlay({
      channelId: CHAN,
      changes: { role: "analyst" },
      actor: { id: "user-jesse", name: "Jesse" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.channels[CHAN].role).toEqual({ value: "analyst" });
    expect(live.channelPresets.get(CHAN)?.role?.value).toBe("analyst");
  });

  it("applyChannelOverlay writes cwd without the Tier-C flag", () => {
    const file = writePresetsFile({ channels: { [CHAN]: { model: { value: "old" } } } });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: false,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const result = svc.applyChannelOverlay({
      channelId: CHAN,
      changes: { cwd: "/repo/class" },
      actor: { id: "user-jesse", name: "Jesse" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.channels[CHAN].cwd).toEqual({ value: "/repo/class" });
    expect(live.channelPresets.get(CHAN)?.cwd?.value).toBe("/repo/class");
  });

  it("applyThreadOverlay writes cwd over a channel value", () => {
    const file = writePresetsFile({
      channels: { [CHAN]: { cwd: { value: "/repo/class" } } },
      threads: {},
    });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: false,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const result = svc.applyThreadOverlay({
      threadId: THREAD,
      parentRef: CHAN,
      changes: { cwd: "/repo/this-thread" },
      actor: { id: "user-jesse", name: "Jesse" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.channels[CHAN].cwd).toEqual({ value: "/repo/class" });
    expect(raw.threads[THREAD].cwd).toEqual({ value: "/repo/this-thread" });
    expect(live.threadPresets.get(THREAD)?.cwd?.value).toBe("/repo/this-thread");
  });

  it("Tier-C channelPreset proposal can set statusCardStyle", () => {
    const record = makeRecord({ parentRef: CHAN });
    const file = writePresetsFile({ channels: { [CHAN]: {} } });
    const built = makeService({ presetsFile: file, tierCEnabled: true }).buildProposal(record, {
      channelPreset: { statusCardStyle: "simple" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.fields).toEqual([
      { label: "statusCardStyle", before: "(unset)", after: "simple" },
    ]);
    built.proposal.apply({ id: "u", name: "U" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.channels[CHAN].statusCardStyle).toEqual({ value: "simple" });
  });
});

describe("simpleCardGif mutation", () => {
  it("sets and clears session simpleCardGif without restarting", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();
    const set = svc.buildProposal(record, { session: { simpleCardGif: true } });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.proposal.restartsSession).toBe(false);
    expect(set.proposal.fields).toEqual([
      { label: "simpleCardGif", before: "(default)", after: "on" },
    ]);
    set.proposal.apply({ id: "u", name: "U" });
    expect(store.readConfig(store.get(record.id)!).simpleCardGif).toBe(true);

    const fresh = store.get(record.id)!;
    const clear = svc.buildProposal(fresh, { session: { simpleCardGif: null } });
    expect(clear.ok).toBe(true);
    if (!clear.ok) return;
    clear.proposal.apply({ id: "u", name: "U" });
    expect(store.readConfig(store.get(record.id)!).simpleCardGif).toBeUndefined();
  });

  it("refuses an invalid simpleCardGif", () => {
    const record = makeRecord();
    store.upsert(record);
    const built = makeService().buildProposal(record, {
      session: { simpleCardGif: "maybe" as unknown as boolean },
    });
    expect(built.ok).toBe(false);
  });
});

describe("simpleCardGif channel/thread overlay", () => {
  function writePresetsFile(doc: unknown): string {
    const file = path.join(dir, "channel-presets.json");
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    return file;
  }
  const CHAN = "111111111111111111";
  const THREAD = "333333333333333333";

  it("applyChannelOverlay writes simpleCardGif without the Tier-C flag", () => {
    const file = writePresetsFile({ channels: { [CHAN]: { model: { value: "old" } } } });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: false,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const result = svc.applyChannelOverlay({
      channelId: CHAN,
      changes: { simpleCardGif: true },
      actor: { id: "user-jesse", name: "Jesse" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(PresetsFileSchema.safeParse(raw).success).toBe(true);
    expect(raw.channels[CHAN].simpleCardGif).toEqual({ value: true });
    expect(raw.channels[CHAN].model).toEqual({ value: "old" });
    expect(live.channelPresets.get(CHAN)?.simpleCardGif?.value).toBe(true);
  });

  it("applyThreadOverlay writes simpleCardGif over a channel value", () => {
    const file = writePresetsFile({
      channels: { [CHAN]: { simpleCardGif: { value: true } } },
      threads: {},
    });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: false,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const result = svc.applyThreadOverlay({
      threadId: THREAD,
      parentRef: CHAN,
      changes: { simpleCardGif: false },
      actor: { id: "user-jesse", name: "Jesse" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.channels[CHAN].simpleCardGif).toEqual({ value: true });
    expect(raw.threads[THREAD].simpleCardGif).toEqual({ value: false });
    expect(live.threadPresets.get(THREAD)?.simpleCardGif?.value).toBe(false);
  });

  it("Tier-C channelPreset proposal can set simpleCardGif", () => {
    const record = makeRecord({ parentRef: CHAN });
    const file = writePresetsFile({ channels: { [CHAN]: {} } });
    const built = makeService({ presetsFile: file, tierCEnabled: true }).buildProposal(record, {
      channelPreset: { simpleCardGif: true },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.fields).toEqual([
      { label: "simpleCardGif", before: "(unset)", after: "on" },
    ]);
    built.proposal.apply({ id: "u", name: "U" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.channels[CHAN].simpleCardGif).toEqual({ value: true });
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

  it("round-trips threadPreset detached:true as a RAW boolean + writes an audit row (#80)", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({
      threads: { [THREAD]: { rider: { value: "keep me" } } },
    });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: true,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const built = svc.buildProposal(record, { threadPreset: { detached: true } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.restartsSession).toBe(false);
    expect(built.proposal.fields).toEqual([
      { label: "detached", before: "false", after: "true" },
    ]);
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });

    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(PresetsFileSchema.safeParse(raw).success).toBe(true);
    expect(raw.threads[THREAD].detached).toBe(true);
    expect(raw.threads[THREAD].rider.value).toBe("keep me");
    // RAW boolean — not wrapped {value:true}.
    expect(raw.threads[THREAD].detached).not.toEqual({ value: true });
    expect(live.threadPresets.get(THREAD)?.detached).toBe(true);
    expect(store.listConfigMutations()[0]).toMatchObject({
      tier: "thread-preset",
      scope: THREAD,
    });
    expect(store.listConfigMutations()[0].summary).toMatch(/detached/);
  });

  it("round-trips threadPreset tts:true as a RAW boolean and does not restart", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({
      threads: { [THREAD]: { rider: { value: "keep me" } } },
    });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: true,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const built = svc.buildProposal(record, { threadPreset: { tts: true } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.restartsSession).toBe(false);
    expect(built.proposal.fields).toEqual([{ label: "tts", before: "false", after: "true" }]);
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });

    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.threads[THREAD].tts).toBe(true);
    expect(raw.threads[THREAD].tts).not.toEqual({ value: true });
    expect(raw.threads[THREAD].rider.value).toBe("keep me");
    expect(live.threadPresets.get(THREAD)?.tts).toBe(true);
  });

  it("attach omits detached and deletes an empty thread key (#80)", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({
      threads: { [THREAD]: { detached: true }, [SIBLING]: { rider: { value: "sibling" } } },
    });
    const svc = makeService({ presetsFile: file, tierCEnabled: true });
    const built = svc.buildProposal(record, { threadPreset: { detached: false } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    built.proposal.apply({ id: "u", name: "U" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.threads[THREAD]).toBeUndefined();
    expect(raw.threads[SIBLING]).toEqual({ rider: { value: "sibling" } });
  });

  it("attach keeps a remaining rider and omits detached (#80)", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({
      threads: { [THREAD]: { detached: true, rider: { value: "stay" } } },
    });
    const svc = makeService({ presetsFile: file, tierCEnabled: true });
    const built = svc.buildProposal(record, { threadPreset: { detached: false } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    built.proposal.apply({ id: "u", name: "U" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.threads[THREAD].rider.value).toBe("stay");
    expect(raw.threads[THREAD].detached).toBeUndefined();
  });

  it("applyThreadDetached writes without a SessionRecord and is not gated by Tier C (#80 D10)", () => {
    const file = writePresetsFile({ threads: {} });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: false, // slash path must work with conversational Tier C off
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const result = svc.applyThreadDetached({
      threadId: THREAD,
      parentRef: CHAN,
      detached: true,
      actor: { id: "user-jesse", name: "Jesse" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.auditId).toBeTruthy();
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.threads[THREAD]).toEqual({ detached: true });
    expect(live.threadPresets.get(THREAD)?.detached).toBe(true);
    // Never upserted a session just to persist the flag.
    expect(store.get(`discord:${THREAD}`)).toBeNull();
    expect(store.listConfigMutations()).toHaveLength(1);
  });

  it("round-trips threadPreset location as a RAW string + writes an audit row (#86)", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({
      threads: { [THREAD]: { rider: { value: "keep me" } } },
    });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: true,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const built = svc.buildProposal(record, { threadPreset: { location: "mac" } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.restartsSession).toBe(true);
    expect(built.proposal.fields).toEqual([
      { label: "location", before: "local", after: "mac" },
    ]);
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });

    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(PresetsFileSchema.safeParse(raw).success).toBe(true);
    expect(raw.threads[THREAD].location).toBe("mac");
    expect(raw.threads[THREAD].location).not.toEqual({ value: "mac" });
    expect(raw.threads[THREAD].rider.value).toBe("keep me");
    expect(live.threadPresets.get(THREAD)?.location).toBe("mac");
    expect(store.listConfigMutations()[0].summary).toMatch(/location/);
  });

  it("omits location when set back to local (#86 default)", () => {
    const record = makeRecord({ channelRef: THREAD, parentRef: CHAN });
    const file = writePresetsFile({
      threads: { [THREAD]: { location: "mac", rider: { value: "stay" } } },
    });
    const svc = makeService({ presetsFile: file, tierCEnabled: true });
    const built = svc.buildProposal(record, { threadPreset: { location: "local" } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    built.proposal.apply({ id: "u", name: "U" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.threads[THREAD].location).toBeUndefined();
    expect(raw.threads[THREAD].rider.value).toBe("stay");
  });

  it("applyThreadLocation writes without Tier C and is idempotent for local (#86)", () => {
    const file = writePresetsFile({ threads: {} });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: false,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const result = svc.applyThreadLocation({
      threadId: THREAD,
      parentRef: CHAN,
      location: "mac",
      actor: { id: "user-jesse", name: "Jesse" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.auditId).toBeTruthy();
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.threads[THREAD]).toEqual({ location: "mac" });
    expect(live.threadPresets.get(THREAD)?.location).toBe("mac");
    expect(store.get(`discord:${THREAD}`)).toBeNull();
  });

  it("applyThreadOverlay pins agent/model over a locked channel preset", () => {
    const file = writePresetsFile({
      channels: {
        [CHAN]: { agent: { value: "grok" }, model: { value: "grok-4.6" }, locked: true },
      },
      threads: {},
    });
    const live = {
      channelPresets: new Map<string, ChannelPreset>(),
      threadPresets: new Map<string, ThreadPreset>(),
    };
    const svc = makeService({
      presetsFile: file,
      tierCEnabled: false,
      reloadPresets: () => reloadChannelPresets(live, file, silent),
    });
    const result = svc.applyThreadOverlay({
      threadId: THREAD,
      parentRef: CHAN,
      changes: { agent: "ollama-cloud", model: "kimi-k3:cloud" },
      actor: { id: "user-jesse", name: "Jesse" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.channels[CHAN].locked).toBe(true);
    expect(raw.channels[CHAN].agent).toEqual({ value: "grok" });
    expect(raw.threads[THREAD].agent).toEqual({ value: "ollama-cloud" });
    expect(raw.threads[THREAD].model).toEqual({ value: "kimi-k3:cloud" });
    expect(live.threadPresets.get(THREAD)?.agent?.value).toBe("ollama-cloud");
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
