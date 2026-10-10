import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { ConfigDescription } from "../packages/core/src/core/session-router.js";
import type { ChannelRef } from "../packages/core/src/platforms/chat-adapter.js";
import { executeGoogleChatCommand, type GoogleChatCommandDeps } from "../packages/core/src/platforms/google-chat/command-actions.js";
import { parseGoogleChatCommand, type GoogleChatCommand } from "../packages/core/src/platforms/google-chat/commands.js";

const command: GoogleChatCommand = {
  command: "model", args: "unlisted-model", space: "spaces/dm", thread: "spaces/dm/threads/old",
  user: { id: "users/person", name: "A Person" },
};
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
  const describeConfig = vi.fn(() => ({ agent: { value: "codex" }, model: { value: "pinned-model" } } as ConfigDescription));
  const router = { ensureSessionRecord, describeConfig };
  const deps: GoogleChatCommandDeps = {
    channelFor, createThread, router,
    runtimeTransition: { applyAgentChange, applyModelChange },
    cancelChannel, respond, cwd: "/repo",
  };
  return { deps, cancelOutcome, switchOutcome, newRecord, trace, channelFor, createThread, ensureSessionRecord, describeConfig, cancelChannel, applyAgentChange, applyModelChange, respond };
}

describe("Google Chat command -> existing core operations", () => {
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

  it("creates a sibling top-level DM thread then binds it, without touching the old session", async () => {
    const h = harness();
    const result = await executeGoogleChatCommand({ ...command, command: "new", args: "Another task" }, h.deps);
    expect(result).toEqual({ command: "new", channel: created, record: h.newRecord });
    expect(h.channelFor).toHaveBeenCalledExactlyOnceWith(command.space, null);
    expect(h.createThread).toHaveBeenCalledExactlyOnceWith(parent, "Another task");
    expect(h.ensureSessionRecord).toHaveBeenCalledExactlyOnceWith({ platform: "google-chat", channelRef: "dm.new", parentRef: "dm", cwd: "/repo" });
    expect(h.trace).toEqual(["create", "bind:dm.new"]);
    expect(h.cancelChannel).not.toHaveBeenCalled();
    expect(h.applyAgentChange).not.toHaveBeenCalled();
    expect(h.applyModelChange).not.toHaveBeenCalled();
    expect(record.acpSessionId).toBe("old-acp");
  });

  it("uses /seam new's existing default name when no name is supplied", async () => {
    const h = harness();
    await executeGoogleChatCommand({ ...command, command: "new", args: "" }, h.deps);
    expect(h.createThread).toHaveBeenCalledWith(parent, "seam");
  });

  it.each(["agent", "model"] as const)("uses RuntimeTransition.apply%sChange with the real actor and unchanged id", async (kind) => {
    const h = harness();
    const args = kind === "agent" ? "claude@remote" : "unlisted-native-model";
    const result = await executeGoogleChatCommand({ ...command, command: kind, args }, h.deps);
    expect(result).toEqual({ command: kind, channel, outcome: h.switchOutcome });
    const selected = kind === "agent" ? h.applyAgentChange : h.applyModelChange;
    expect(selected).toHaveBeenCalledExactlyOnceWith(channel, record, args, { id: "users/person", name: "A Person" }, expect.any(Function));
    expect(h.ensureSessionRecord).toHaveBeenCalledExactlyOnceWith({ platform: "google-chat", channelRef: "dm.old", parentRef: "dm", cwd: "/repo" });
    expect(h.respond).toHaveBeenCalledExactlyOnceWith(channel, h.switchOutcome.message);
    expect(h.cancelChannel).not.toHaveBeenCalled();
    expect(h.createThread).not.toHaveBeenCalled();
  });

  it.each(["agent", "model"] as const)("shows /%s usage and resolved identity without attempting an empty switch", async kind => {
    const h = harness();
    const before = structuredClone(record);
    await executeGoogleChatCommand({ ...command, command: kind, args: "" }, h.deps);
    expect(h.applyAgentChange).not.toHaveBeenCalled();
    expect(h.applyModelChange).not.toHaveBeenCalled();
    expect(h.describeConfig).toHaveBeenCalledExactlyOnceWith(record);
    expect(h.respond).toHaveBeenCalledExactlyOnceWith(channel,
      `Usage: /${kind} <id> — current: ${kind === "agent" ? "codex" : "pinned-model"}`);
    expect(record).toEqual(before);
    expect(h.cancelChannel).not.toHaveBeenCalled();
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

  it.each(["create", "bind", "switch"])("propagates a thrown %s cause unchanged", async (where) => {
    const h = harness();
    const cause = new Error(`${where}: original cause`, { cause: new Error("native detail") });
    if (where === "create") h.deps.createThread = async () => { throw cause; };
    if (where === "bind") h.deps.router.ensureSessionRecord = () => { throw cause; };
    if (where === "switch") h.deps.runtimeTransition.applyModelChange = async () => { throw cause; };
    await expect(executeGoogleChatCommand({ ...command, command: where === "switch" ? "model" : "new" }, h.deps)).rejects.toBe(cause);
  });

  it("passes a parsed slash command through the action map exactly once", async () => {
    const h = harness();
    const parsed = parseGoogleChatCommand({ type: "MESSAGE", space: { name: command.space }, user: { name: command.user.id },
      message: { thread: { name: command.thread! }, slashCommand: { commandId: "2" }, argumentText: "/cancel" },
    });
    if (!parsed) throw new Error("Expected command");
    await executeGoogleChatCommand(parsed, h.deps);
    expect(h.cancelChannel).toHaveBeenCalledExactlyOnceWith(channel);
  });
});
