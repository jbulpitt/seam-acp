import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { ConfigDescription } from "../packages/core/src/core/session-router.js";
import type { ChannelRef } from "../packages/core/src/platforms/chat-adapter.js";
import { executeGoogleChatCommand, type GoogleChatCommandDeps } from "../packages/core/src/platforms/google-chat/command-actions.js";
import { parseGoogleChatCommand, type GoogleChatCommand } from "../packages/core/src/platforms/google-chat/commands.js";

const command = {
  command: "model", args: "unlisted-model", space: "spaces/dm", thread: "spaces/dm/threads/old",
  user: { id: "users/person", name: "A Person" },
} satisfies GoogleChatCommand;
const channel: ChannelRef = { platform: "google-chat", id: "dm.old", parentId: "dm" };
const parent: ChannelRef = { platform: "google-chat", id: "dm" };
const created: ChannelRef = { platform: "google-chat", id: "dm.new", parentId: "dm" };
const record: SessionRecord = {
  id: "google-chat:dm.old", platform: "google-chat", channelRef: "dm.old", parentRef: "dm",
  agentId: "claude", acpSessionId: "old-acp", repoPath: "/repo", configJson: "{}",
  createdUtc: "2026-10-10T00:00:00Z", updatedUtc: "2026-10-10T00:00:00Z",
};

function harness() {
  const cancelOutcome: Awaited<ReturnType<GoogleChatCommandDeps["cancelChannel"]>> = {
    parked: null, cancelled: { cancelled: false, starting: false }, outcome: "idle",
    queue: {
      state: "idle", epoch: 0, queued: 0, ageMs: 0, runtimeBusy: false,
      stalledDispatchCount: 0, stalledDispatchIds: [], unsettledDispatchCount: 0, unsettledDispatchIds: [],
    },
  };
  const switchOutcome = { ok: true as const, message: "The existing switch response" };
  const newRecord = { ...record, id: "google-chat:dm.new", channelRef: "dm.new", acpSessionId: "" };
  const trace: string[] = [];
  const channelFor = vi.fn((_space: string, thread: string | null) => thread ? channel : parent);
  const createThread = vi.fn(async (_parent: ChannelRef, _name: string) => { trace.push("create"); return created; });
  const ensureSessionRecord = vi.fn((opts: { channelRef: string }) => {
    trace.push(`bind:${opts.channelRef}`);
    return opts.channelRef === created.id ? newRecord : record;
  });
  const applyAgentChange: GoogleChatCommandDeps["runtimeTransition"]["applyAgentChange"] = vi.fn(async (_channel, _record, _id, _actor, respond) => {
    await respond(switchOutcome.message);
    return switchOutcome;
  });
  const applyModelChange: GoogleChatCommandDeps["runtimeTransition"]["applyModelChange"] = vi.fn(async (_channel, _record, _id, _actor, respond) => {
    await respond(switchOutcome.message);
    return switchOutcome;
  });
  const cancelChannel = vi.fn(async (_channel: ChannelRef) => cancelOutcome);
  const respond = vi.fn(async (_channel: ChannelRef, _text: string) => {});
  const describeConfig = vi.fn(() => ({ agent: { value: "codex" }, model: { value: "pinned-model" },
    cwd: { value: "/remote/projects/old" }, location: { value: "remote" }, effort: { value: "low" } } as ConfigDescription));
  const listRepos = vi.fn(async () => ["/remote/projects/old", "/remote/projects/other repo"]);
  const applyRepoChange = vi.fn(async () => ({ ok: true as const, message: "Repo changed; session reset.", sessionReset: true, resetPending: false }));
  const unchanged = { before: "fixture", after: "fixture", changed: false };
  const configure = vi.fn(async () => ({ ok: true as const,
    applied: { agent: "codex", model: "pinned-model", effort: "high", role: "auto", disableThreadPrefix: false, fastMode: false },
    changes: { agent: unchanged, model: unchanged, role: unchanged, disableThreadPrefix: unchanged, fastMode: unchanged,
      effort: { before: "low", after: "high", changed: true } },
    sessionReset: false, runtimeReloaded: true, warnings: [] }));
  const effortChoices = vi.fn(() => ["low", "high", "provider-special"]);
  const router = { ensureSessionRecord, describeConfig, bindRecordLocation: vi.fn(() => "local"), listProfiles: () => [] };
  const deps: GoogleChatCommandDeps = {
    channelFor, router, store: { getByChannel: () => record },
    mutation: { readThreadPresetEntry: () => undefined,
      applyThreadOverlay: vi.fn(() => ({ ok: true as const, message: "Applied", auditId: "fixture" })) },
    runtimeTransition: { applyAgentChange, applyModelChange, configure },
    configPlan: { applyRepoChange, listRepos }, modelCatalog: { effortChoices, models: () => [], model: () => null },
    cancelChannel, respond, cwd: "/repo",
  };
  return { deps, cancelOutcome, switchOutcome, newRecord, trace, channelFor, createThread, ensureSessionRecord, describeConfig, cancelChannel, applyAgentChange, applyModelChange, respond, listRepos, applyRepoChange, configure, effortChoices };
}

describe("Google Chat command -> existing core operations", () => {
  it.each(["repo", "effort", "agent", "model"] as const)("opens /%s's picker without attempting an empty change", async kind => {
    const h = harness();
    const result = await executeGoogleChatCommand({ ...command, command: kind, args: "" }, h.deps);
    expect(result).toEqual({ command: "picker", requestedCommand: kind, channel });
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.applyRepoChange).not.toHaveBeenCalled(); expect(h.configure).not.toHaveBeenCalled();
    expect(h.applyAgentChange).not.toHaveBeenCalled(); expect(h.applyModelChange).not.toHaveBeenCalled();
  });

  it("delegates /repo unchanged to the shared thread-overlay operation with the real actor", async () => {
    const h = harness();
    await executeGoogleChatCommand({ ...command, command: "repo", args: "/remote/projects/other repo" }, h.deps);
    expect(h.applyRepoChange).toHaveBeenCalledExactlyOnceWith(channel, record, "/remote/projects/other repo", command.user);
    expect(h.respond).toHaveBeenCalledWith(channel, "Repo changed; session reset.");
    expect(h.configure).not.toHaveBeenCalled();
  });

  it("lets configure_thread validate provider-specific effort instead of a Chat whitelist", async () => {
    const h = harness();
    await executeGoogleChatCommand({ ...command, command: "effort", args: "provider-special" }, h.deps);
    expect(h.configure).toHaveBeenCalledExactlyOnceWith(record, record, { effort: "provider-special" }, command.user);
    expect(h.respond).toHaveBeenCalledWith(channel, expect.stringContaining("Session not reset"));
    expect(h.applyModelChange).not.toHaveBeenCalled();
    expect(h.applyAgentChange).not.toHaveBeenCalled();
  });

  it.each(["repo", "effort"] as const)("preserves /%s's shared operation refusal verbatim", async kind => {
    const h = harness();
    const error = kind === "repo" ? "spawn /bin/sh ENOENT: /remote/projects/missing" : "Runtime/catalog drift: provider-special is not advertised";
    const operation = kind === "repo" ? h.applyRepoChange : h.configure;
    operation.mockResolvedValue({ ok: false, error } as any);
    const result = await executeGoogleChatCommand({ ...command, command: kind, args: "missing" }, h.deps);
    expect(result).toMatchObject({ command: kind, outcome: { ok: false, error } });
    expect(h.respond).toHaveBeenCalledExactlyOnceWith(channel, error);
  });

  it("cancels only the invocation's canonical channel through cancelChannel", async () => {
    const h = harness();
    const result = await executeGoogleChatCommand({ ...command, command: "cancel", args: "" }, h.deps);
    expect(result).toEqual({ command: "cancel", channel, outcome: h.cancelOutcome });
    if (result.command !== "cancel") throw new Error("Expected cancel result");
    expect(result.outcome).toBe(h.cancelOutcome);
    expect(h.channelFor).toHaveBeenCalledWith(command.space, command.thread);
    expect(h.cancelChannel).toHaveBeenCalledExactlyOnceWith(channel);
    expect(h.ensureSessionRecord).not.toHaveBeenCalled();
    expect(h.createThread).not.toHaveBeenCalled();
  });

  it("does not create a thread-bound session to configure an unbound launcher", async () => {
    const h = harness(); h.deps.store.getByChannel = () => null;
    await executeGoogleChatCommand(command, h.deps);
    expect(h.respond).toHaveBeenCalledExactlyOnceWith(channel, expect.stringContaining("/new"));
    expect(h.ensureSessionRecord).not.toHaveBeenCalled(); expect(h.applyModelChange).not.toHaveBeenCalled();
  });

  it.each(["agent", "model"] as const)("uses RuntimeTransition.apply%sChange with the real actor and unchanged id", async (kind) => {
    const h = harness();
    const args = kind === "agent" ? "claude@remote" : "unlisted-native-model";
    const result = await executeGoogleChatCommand({ ...command, command: kind, args }, h.deps);
    expect(result).toEqual({ command: kind, channel, outcome: h.switchOutcome });
    const selected = kind === "agent" ? h.applyAgentChange : h.applyModelChange;
    expect(selected).toHaveBeenCalledExactlyOnceWith(channel, record, args, { id: "users/person", name: "A Person" }, expect.any(Function));
    expect(h.ensureSessionRecord).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledExactlyOnceWith(channel, h.switchOutcome.message);
    expect(h.cancelChannel).not.toHaveBeenCalled();
    expect(h.createThread).not.toHaveBeenCalled();
  });

  it("preserves the core refusal and its response without claiming a successful switch", async () => {
    const h = harness();
    const failure = { ok: false as const, error: "Invalid params (code -32602): native model rejection" };
    h.deps.runtimeTransition.applyModelChange = async (_channel, _record, _id, _actor, respond) => {
      await respond(failure.error);
      return failure;
    };
    const result = await executeGoogleChatCommand(command, h.deps);
    if (result.command !== "model") throw new Error("Expected model result");
    expect(result.outcome).toBe(failure);
    expect(h.respond).toHaveBeenCalledExactlyOnceWith(channel, failure.error);
  });

  it("preserves a cancel error rather than turning it into a generic response", async () => {
    const h = harness();
    const cause = new Error("ECONNRESET while cancelling", { cause: new Error("socket closed") });
    const failure = { parked: null, cancelled: { cancelled: false, starting: false }, error: cause };
    h.deps.cancelChannel = async () => failure;
    const result = await executeGoogleChatCommand({ ...command, command: "cancel" }, h.deps);
    if (result.command !== "cancel") throw new Error("Expected cancel result");
    expect(result.outcome).toBe(failure);
  });

  it("propagates a thrown switch cause unchanged", async () => {
    const h = harness();
    const cause = new Error("switch: original cause", { cause: new Error("native detail") });
    h.deps.runtimeTransition.applyModelChange = async () => { throw cause; };
    await expect(executeGoogleChatCommand(command, h.deps)).rejects.toBe(cause);
  });

  it("passes a parsed slash command through the action map exactly once", async () => {
    const h = harness();
    const parsed = parseGoogleChatCommand({ type: "MESSAGE", space: { name: command.space }, user: { name: command.user.id },
      message: { thread: { name: command.thread! }, slashCommand: { commandId: "2" }, argumentText: "/cancel" },
    });
    if (!parsed || parsed.command !== "cancel") throw new Error("Expected cancel command");
    await executeGoogleChatCommand(parsed, h.deps);
    expect(h.cancelChannel).toHaveBeenCalledExactlyOnceWith(channel);
  });
});
