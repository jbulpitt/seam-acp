import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { applyPresetIdentity, applyWatchFeedback } from "../packages/core/src/core/dispatch/types.js";
import type { ConfigDescription } from "../packages/core/src/core/session-router.js";
import type { AgentProfile } from "@seam/adapters";
import type { SessionRecord } from "../packages/core/src/core/types.js";
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

const claudeProfile = { id: "claude" } as unknown as AgentProfile;
const profiles = new Map<string, AgentProfile>([["claude", claudeProfile]]);

function describeConfig(record: SessionRecord): ConfigDescription {
  const cfg = store.readConfig(record);
  return {
    sessionId: record.id,
    channelRef: record.channelRef,
    parentRef: record.parentRef,
    agent: { value: record.agentId, source: "session config" },
    model: cfg.model ? { value: cfg.model, source: "session config" } : { value: "d", source: "default" },
    effort: { value: null, source: "default" },
    cwd: { value: record.repoPath ?? "/cwd", source: "session config" },
    permission: { value: cfg.permissionPolicy ?? "ask", source: "session config" },
    locked: false,
    detached: { value: false, source: "default" },
    tts: { value: false, source: "default" },
    ttsVoice: { value: null, source: "default" },
    ttsPace: { value: "natural", source: "default" },
    ttsStyle: { value: "neutral", source: "default" },
    location: { value: "local", source: "default" },
  };
}

function makeService(): ConfigMutationService {
  return new ConfigMutationService({
    store,
    describeConfig,
    profiles,
    defaultModel: "gpt-5.4",
    presetsFile: undefined,
    tierCEnabled: false,
    reloadPresets: () => ({ ok: true }),
    reschedule: () => {},
    defaultTimezone: "America/Chicago",
    logger: silent,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-inject-"));
  store = new SessionStore(path.join(dir, "test.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------------------
// #72 headline: a preset created conversationally WITH instructions carries
// its identity into a handoff. This exercises the REAL path end-to-end —
//   1. create the preset through ConfigMutationService (the config_propose path)
//   2. resolve it via store.getPresetByName (exactly what dispatchInjectTurn does)
//   3. assemble the worker prompt with applyPresetIdentity (the SAME pure helper
//      dispatchInjectTurn now calls) and assert the <seam-worker-identity> block
// No inline copy of the assembly logic — the production function is under test.
// -------------------------------------------------------------------------
describe("preset instructions injection (#72, end-to-end)", () => {
  const IDENTITY =
    "You are a ruthless code reviewer. Only report high-confidence correctness bugs.";

  it("a conversationally-created preset injects its instructions into the handoff prompt", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();

    // 1. Create the preset with instructions via the config_propose path.
    const built = svc.buildProposal(record, {
      preset: { name: "reviewer", agent: "claude", instructions: IDENTITY },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });

    // 2. Resolve it EXACTLY as dispatchInjectTurn does (store.getPresetByName).
    const preset = store.getPresetByName("reviewer");
    expect(preset).not.toBeNull();
    expect(preset!.instructions).toBe(IDENTITY);

    // 3. Assemble the worker prompt through the production helper.
    const task = "Review the diff on branch feat/x.";
    const workerPrompt = applyWatchFeedback(applyPresetIdentity(task, preset), false);

    // The identity block is prepended, names the preset, carries the FULL
    // instructions, and sits AHEAD of the task prompt.
    expect(workerPrompt).toBe(
      `<seam-worker-identity name="reviewer">\n${IDENTITY}\n</seam-worker-identity>\n\n${task}`
    );
    expect(workerPrompt.indexOf("<seam-worker-identity")).toBeLessThan(workerPrompt.indexOf(task));
  });

  it("a preset WITHOUT instructions leaves the prompt verbatim (no empty block)", () => {
    const record = makeRecord();
    store.upsert(record);
    const svc = makeService();
    const built = svc.buildProposal(record, { preset: { name: "plain", agent: "claude" } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    built.proposal.apply({ id: "u", name: "U" });

    const preset = store.getPresetByName("plain");
    const task = "do the thing";
    expect(applyPresetIdentity(task, preset)).toBe(task);
    expect(applyPresetIdentity(task, preset)).not.toContain("seam-worker-identity");
  });
});
