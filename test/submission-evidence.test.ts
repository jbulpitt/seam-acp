import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { newSubmissionEvidence, observeClaudeSubmission, observePromptWrites } from "../packages/core/src/agents/submission-evidence.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { makeClaudeProfile } from "../packages/adapters/src/profiles/claude.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); vi.restoreAllMocks(); });
const logger = { debug() {}, info() {}, error() {}, warn: vi.fn(), child() { return this; } } as any;
function storeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-536-"));
  const file = path.join(dir, "test.db");
  const store = new SessionStore(file);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const spec = { id: "job", target: "thread", session: "live" as const, kind: "handoff" as const,
    prompt: "PRIVATE ORIGINAL", createdUtc: new Date().toISOString() };
  const attempt = store.turnAttempts.claim(spec, "fixture", "boot-A");
  store.turnAttempts.bind(attempt, "session"); store.turnAttempts.startPrompt(attempt);
  return { store, attempt, file, spec };
}

async function runtimeFixture(fault: "before" | "accepted" | "effect" | "update" | "none", adapter = "claude", holdNewSessionWrite = false) {
  const h = storeFixture();
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  let releaseNewSessionWrite: (() => void) | undefined;
  const input = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    stdin.write(chunk);
    if (holdNewSessionWrite && JSON.parse(chunk.toString()).method === "session/new") releaseNewSessionWrite = callback;
    else callback();
  } });
  const child = Object.assign(new EventEmitter(), { stdin: input, stdout, stderr, killed: false,
    kill() { this.killed = true; return true; } });
  cleanups.push(() => { input.destroy(); stdin.destroy(); stdout.destroy(); stderr.destroy(); });
  const prompts: any[] = []; let effects = 0, rawFeed = false;
  agent({ name: "fixture" })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      rawFeed = Array.isArray((params._meta?.claudeCode as any)?.emitRawSDKMessages);
      return { sessionId: "session" };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      prompts.push(params);
      if (prompts.length === 1 && fault !== "none") {
        if (fault === "accepted" && rawFeed) {
          await client.notify("_claude/sdkMessage", { sessionId: "session", message: {
            type: "command_lifecycle", command_uuid: "cmd-1", state: "started", content: "PRIVATE COMMAND" } });
          await client.notify("_claude/sdkMessage", { sessionId: "session", message: {
            type: "stream_event", parent_tool_use_id: null,
            event: { type: "message_start", message: { id: "msg-1", model: "claude-fixture", content: "PRIVATE RESPONSE" } } } });
        }
        if (fault === "effect") effects++;
        if (fault === "update") await client.notify(methods.client.session.update, { sessionId: "session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PRIVATE UPDATE" } } });
        throw RequestError.internalError({ errorKind: "server_error", agentId: adapter }, "PRIVATE FAILURE");
      }
      effects++;
      return { stopReason: "end_turn" };
    })
    .onNotification(methods.agent.session.cancel, () => {})
    .connect(ndJsonStream(Writable.toWeb(stdout) as WritableStream<Uint8Array>, Readable.toWeb(stdin) as ReadableStream<Uint8Array>));
  const profile = { ...(adapter === "claude" ? makeClaudeProfile({}) : { id: adapter }),
    defaultModel: "default", spawn: () => child } as unknown as AgentProfile;
  const runtime = new AgentRuntime({ profile, logger });
  runtime.onEvent(event => { if (event.kind === "submission-evidence") h.store.turnAttempts.recordSubmission(h.attempt, event.evidence); });
  await runtime.start(); await runtime.newSession({ cwd: tmpdir() });
  const timeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    timeout(fn, [2000, 5000, 10000].includes(ms ?? 0) ? 0 : ms)) as typeof setTimeout);
  return { ...h, runtime, prompts, effects: () => effects, releaseNewSessionWrite: () => releaseNewSessionWrite?.() };
}

describe("#536 evidence with #467's acceptance-scoped retry policy", () => {
  // Without the pre-call receipt, a crash before runtime.prompt disappears from the inventory.
  it("retains intent/unknown before submission and survives reopening", () => {
    const h = storeFixture(), evidence = newSubmissionEvidence("session");
    expect(h.store.turnAttempts.recordSubmission(h.attempt, evidence)).toBe(true);
    const reopened = new SessionStore(h.file);
    try { expect(reopened.turnAttempts.get("job")?.submissions).toEqual([{ ...evidence, generation: h.attempt.generation }]); }
    finally { reopened.close(); }
    expect(evidence.acceptance).toMatchObject({ state: "unknown", reason: "no_correlated_provider_ack" });
    expect(evidence.rpcInvokedUtc).toBeUndefined();
  });

  // Removing intent-vs-call separation labels a cancelled backoff as a paid retry.
  it("records cancelled retry intent as not sent without changing cancellation", async () => {
    const h = await runtimeFixture("before");
    h.runtime.onEvent(async event => {
      if (event.kind === "submission-evidence") h.store.turnAttempts.recordSubmission(h.attempt, event.evidence);
      if (event.kind === "recovery") await h.runtime.cancel();
    });
    await expect(h.runtime.prompt("PRIVATE ORIGINAL")).rejects.toThrow("PRIVATE FAILURE");
    const [first, second] = h.store.turnAttempts.get("job")!.submissions!;
    expect(h.prompts).toHaveLength(1);
    expect(first).toMatchObject({ outcome: "failed", failure: { kind: "server_error" } });
    expect(second).toMatchObject({ phase: "intent", outcome: "not_sent", retry: { number: 1, mode: "continue" },
      acceptance: { state: "not_accepted", reason: "rpc_never_invoked" } });
    expect(second!.localWriteCompletedUtc).toBeUndefined();
  });

  // Unlike a crash with unknown outcome, a caught pre-RPC failure proves this submission was not sent.
  it("records an interrupted first submission as not accepted before any send", async () => {
    const h = await runtimeFixture("none");
    vi.spyOn(h.runtime as any, "requireConnection").mockImplementation(() => { throw new Error("interrupted before RPC"); });
    await expect(h.runtime.prompt("PRIVATE ORIGINAL")).rejects.toThrow("interrupted before RPC");
    expect(h.prompts).toHaveLength(0);
    expect(h.store.turnAttempts.get("job")!.submissions).toMatchObject([
      { phase: "intent", outcome: "not_sent", adapterId: "claude",
        acceptance: { state: "not_accepted", reason: "rpc_never_invoked" } },
    ]);
  });

  // This is the existing positive-update retry branch: removing observation loses the reason for continuing.
  it("records update types and actual continuation without retaining content", async () => {
    const h = await runtimeFixture("update");
    await h.runtime.prompt("PRIVATE ORIGINAL");
    const [first, second] = h.store.turnAttempts.get("job")!.submissions!;
    expect(first).toMatchObject({ observedUpdateTypes: ["agent_message_chunk"], outcome: "failed" });
    expect(second).toMatchObject({ retry: { mode: "continue" }, phase: "local_write_completed", outcome: "completed" });
    expect(h.prompts[1].prompt).not.toEqual(h.prompts[0].prompt);
    expect(JSON.stringify([first, second])).not.toContain("PRIVATE");
  });

  // A supported feed must reach durable storage; wrapper activity must not become billing proof or alter sawUpdate.
  it("records the supported Claude feed and continues rather than resending accepted work", async () => {
    const h = await runtimeFixture("accepted");
    await h.runtime.prompt("PRIVATE ORIGINAL");
    const [first, second] = h.store.turnAttempts.get("job")!.submissions!;
    expect(first).toMatchObject({ phase: "local_write_completed", outcome: "failed", billing: "unknown",
      acceptance: { state: "unknown", scope: "provider_submission" },
      providerMessage: { state: "accepted", scope: "provider_message_started", correlation: "active_session_window", lastId: "msg-1" },
      wrapperCommand: { scope: "claude_wrapper_command_lifecycle", lastId: "cmd-1", lastState: "started" } });
    expect(second).toMatchObject({ outcome: "completed", retry: { mode: "continue", previousSubmissionId: first!.id } });
    expect(h.prompts[1].prompt).not.toEqual(h.prompts[0].prompt);
    expect(JSON.stringify([first, second])).not.toMatch(/PRIVATE/);
  });

  // Unknown acceptance cannot authorize a billable resend. Continuing may be
  // useless when nothing ran, but that is cheaper and recoverable (#467).
  it("continues after an effect whose acceptance notification was lost", async () => {
    const h = await runtimeFixture("effect", "codex");
    await h.runtime.prompt("PRIVATE ORIGINAL");
    expect(h.effects()).toBe(2);
    expect(h.store.turnAttempts.get("job")!.submissions).toMatchObject([
      { outcome: "failed", acceptance: { state: "unknown" }, providerMessage: { state: "unknown" }, observedUpdateTypes: [] },
      { outcome: "completed", acceptance: { state: "unknown" }, retry: { mode: "continue" } },
    ]);
    expect(h.prompts[1].prompt).not.toEqual(h.prompts[0].prompt);
  });

  // No signal is a useful answer; deleting this would let success masquerade as acceptance telemetry.
  it.each(["codex", "grok", "copilot", "agy"])("keeps %s acceptance explicitly unknown on success", async adapter => {
    const h = await runtimeFixture("none", adapter);
    await h.runtime.prompt("PRIVATE ORIGINAL");
    expect(h.store.turnAttempts.get("job")!.submissions).toMatchObject([
      { acceptance: { state: "unknown" }, providerMessage: { state: "unknown" }, billing: "unknown", outcome: "completed" },
    ]);
  });

  // Rebinding and another telemetry writer must not erase this evidence; stale generations must not amend it.
  it("preserves evidence with fallback, rebinding and settlement while fencing stale writers", () => {
    const h = storeFixture(), e = newSubmissionEvidence("session");
    h.store.turnAttempts.recordSubmission(h.attempt, e);
    h.store.turnAttempts.recordStdoutFallback(h.attempt, "unauthenticated");
    h.store.turnAttempts.bindRuntime(h.attempt, process.pid);
    h.store.turnAttempts.bindRuntime(h.attempt, undefined);
    expect(h.store.turnAttempts.recordSubmission({ ...h.attempt, generation: 999 }, { ...e, revision: 1 })).toBe(false);
    // A new id has no prior revision guard: only the SQL owner fence can reject this stale writer.
    expect(h.store.turnAttempts.recordSubmission({ ...h.attempt, generation: 999 }, newSubmissionEvidence("session"))).toBe(false);
    expect(h.store.turnAttempts.recordSubmission({ ...h.attempt, id: "missing" }, newSubmissionEvidence("session"))).toBe(false);
    expect(h.store.turnAttempts.recordSubmission(h.attempt, e)).toBe(false);
    h.store.turnAttempts.complete(h.attempt, { id: "job", target: "thread", status: "completed", output: "", finishedUtc: new Date().toISOString() });
    expect(h.store.turnAttempts.recordSubmission(h.attempt, newSubmissionEvidence("session"))).toBe(false);
    expect(h.store.turnAttempts.get("job")).toMatchObject({ runtimeOwner: null, deliveryDone: false,
      stdoutFallback: { count: 1 }, submissions: [{ id: e.id, revision: 0 }] });
  });

  // Absent opt-in is the previous dead path. This protects production construction, not just parsing fixtures.
  it("opts Claude into only the supported lifecycle/stream feed", () => {
    const p = makeClaudeProfile({});
    expect(p.submissionSignals).toBe("claude_sdk");
    expect(p.newSessionMeta?.()).toMatchObject({ claudeCode: {
      emitRawSDKMessages: [{ type: "command_lifecycle" }, { type: "stream_event" }],
    } });
  });

  // Old-session/subagent/synthetic events cannot certify this provider submission or leak raw fields.
  it("rejects unrelated/unsafe identities and synthetic provider observations", () => {
    const e = newSubmissionEvidence("session");
    for (const raw of [
      { sessionId: "other", message: { type: "command_lifecycle", command_uuid: "id", state: "started" } },
      { sessionId: "session", message: { type: "command_lifecycle", command_uuid: "https://secret", state: "started" } },
      { sessionId: "session", message: { type: "stream_event", parent_tool_use_id: null,
        event: { type: "message_start", message: { id: "msg", model: "<synthetic>" } } } },
    ]) expect(observeClaudeSubmission(e, raw)).toBe(false);
    expect(e.providerMessage.state).toBe("unknown");
    expect(e.wrapperCommand.observations).toBe(0);
  });

  // A completed local write is different from attempted write, and must preserve the original request.
  it("observes transport completion only after write succeeds", async () => {
    const phases: string[] = [], frames: unknown[] = [];
    const stream = observePromptWrites({ readable: new ReadableStream(),
      writable: new WritableStream({ write(c) { frames.push(c); throw new Error("write failed"); } }) },
      () => async phase => { phases.push(phase); });
    const frame = { jsonrpc: "2.0" as const, id: 1, method: "session/prompt", params: { sessionId: "session", prompt: "PRIVATE" } };
    await expect(stream.writable.getWriter().write(frame)).rejects.toThrow("write failed");
    expect(phases).toEqual(["local_write_started"]);
    expect(frames[0]).toBe(frame);
  });

  // The SDK queues writes: using the active receipt instead of request identity falsely marks a later retry sent.
  it("attributes a queued write to its original request, not the current retry", async () => {
    const h = await runtimeFixture("none", "codex", true);
    let retryInvoked!: () => void;
    const retryReady = new Promise<void>(resolve => { retryInvoked = resolve; });
    h.runtime.onEvent(event => {
      if (event.kind !== "submission-evidence") return;
      h.store.turnAttempts.recordSubmission(h.attempt, event.evidence);
      if (event.evidence.phase !== "rpc_invoked") return;
      if (event.evidence.retry) retryInvoked();
      else setImmediate(() => (h.runtime as any).rejectInFlightPrompt(
        RequestError.internalError({ errorKind: "server_error", agentId: "codex" }, "interrupted queued write")));
    });
    const turn = h.runtime.prompt("PRIVATE ORIGINAL");
    await retryReady;
    expect(h.prompts).toHaveLength(0);
    h.releaseNewSessionWrite();
    await turn;
    expect(h.prompts).toHaveLength(2);
    expect(h.store.turnAttempts.get("job")!.submissions).toMatchObject([
      { phase: "local_write_completed", outcome: "failed" },
      { phase: "local_write_completed", outcome: "completed", retry: { number: 1 } },
    ]);
  });

  // A late transport callback can run after onEvent is rebound; deleting sink ownership contaminates the next turn.
  it("keeps late evidence with its original owner and does not refresh activity", async () => {
    const h = await runtimeFixture("none");
    const evidence = newSubmissionEvidence("session");
    await h.runtime.prompt("PRIVATE ORIGINAL", undefined, { submissionEvidence: evidence });
    const replacement = vi.fn(); h.runtime.onEvent(replacement);
    const activity = h.runtime.lastActivityAtMs;
    await (h.runtime as any).publishSubmission(evidence);
    expect(replacement).not.toHaveBeenCalled();
    expect(h.runtime.lastActivityAtMs).toBe(activity);
  });

  // Receipt failure must not become provider failure or another paid retry.
  it("keeps a successful turn successful when evidence persistence throws", async () => {
    const h = await runtimeFixture("none");
    h.runtime.onEvent(event => { if (event.kind === "submission-evidence") throw new Error("PRIVATE STORAGE"); });
    await expect(h.runtime.prompt("PRIVATE ORIGINAL")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(h.prompts).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ submissionId: expect.any(String) }), "submission evidence could not be recorded");
  });
});
