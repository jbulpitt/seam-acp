/** #404/#448: actual prompt owner, journal-derived failures, no provider calls. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyClaudeError, type AgentProfile } from "@seam/adapters";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import { logger } from "../packages/core/src/lib/logger.js";

const CONTENTION = "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute";
const profile = { id: "claude", classifyError: classifyClaudeError } as unknown as AgentProfile;
afterEach(() => vi.restoreAllMocks());

function fixture(options: { output?: boolean; tool?: boolean; failures?: number; sessionId?: string; error?: Error } = {}) {
  const runtime = new AgentRuntime({ profile, logger });
  const events: AgentEvent[] = [];
  runtime.onEvent(event => { events.push(event); });
  let attempts = 0;
  const prompt = vi.fn(async (_request: unknown) => {
    attempts++;
    if (attempts <= (options.failures ?? 1)) {
      if (options.output || options.tool) await (runtime as any).handleSessionUpdate(options.tool
        ? { sessionUpdate: "tool_call_update", toolCallId: "sent-email", status: "completed" }
        : { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial answer" } });
      throw options.error ?? new Error(CONTENTION);
    }
    return { stopReason: "end_turn" };
  });
  Object.assign(runtime, { connection: { prompt, cancel: vi.fn() }, sessionId: options.sessionId ?? "s1", promptCapabilities: {} });
  const timeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    timeout(fn, [2000, 5000, 10000].includes(ms ?? 0) ? 0 : ms)) as typeof setTimeout);
  return { runtime, prompt, events };
}

describe("#448 one bounded prompt owner", () => {
  it("continues the measured unknown-acceptance refresh race without resending", async () => {
    const { runtime, prompt } = fixture({ failures: 2 });
    await expect(runtime.prompt("original brief")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(prompt).toHaveBeenCalledTimes(3);
    const requests = prompt.mock.calls.map(([request]) => request as {
      sessionId: string;
      prompt: Array<{ type: string; text: string }>;
    });
    expect(requests[0]).toEqual({ sessionId: "s1", prompt: [{ type: "text", text: "original brief" }] });
    expect(requests.slice(1).map((request) => request.prompt[0]!.text)).toEqual([
      expect.stringMatching(/^continue\n[\s\S]*retry 1 of 3/),
      expect.stringMatching(/^continue\n[\s\S]*retry 2 of 3/),
    ]);
    expect(JSON.stringify(requests.slice(1))).not.toContain("original brief");
  });

  it.each(["text", "tool"])("continues after %s output instead of refusing or replaying", async kind => {
    const { runtime, prompt, events } = fixture({ output: kind === "text", tool: kind === "tool" });
    await expect(runtime.prompt("send the email")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(prompt).toHaveBeenCalledTimes(2);
    const continued = (prompt.mock.calls[1]![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
    expect(continued.startsWith("continue\n")).toBe(true);
    expect(continued).toContain("claude reported auth_contention.");
    expect(continued).toContain("continuing the existing conversation");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "recovery",
      message: expect.stringContaining("claude reported auth_contention."),
    }));
  });

  it.each([false, true])("preserves the dispatch exception (output=%s)", async output => {
    const { runtime, prompt } = fixture({ sessionId: "dispatch:outward-effect", output });
    await expect(runtime.prompt("send email")).rejects.toThrow(/another Claude Code process/);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("also protects an isolated dispatch whose provider gave it an ordinary session id", async () => {
    const { runtime, prompt } = fixture({ output: true });
    await expect(runtime.prompt("send email", undefined, { recoveryScope: "ephemeral" })).rejects.toThrow(/another Claude Code process/);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("a conversation hint cannot override a dispatch-prefixed session", async () => {
    const { runtime, prompt } = fixture({ sessionId: "dispatch:outward-effect" });
    await expect(runtime.prompt("send email", undefined, { recoveryScope: "conversation" })).rejects.toThrow(/another Claude Code process/);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("moves the cold-resume echo boundary to continue so the recovered answer is visible", async () => {
    const { runtime, prompt, events } = fixture();
    Object.assign(runtime, { justResumed: true, replayLoadedDuringLoad: false });
    const feed = (sessionUpdate: string, text: string) => (runtime as any).handleSessionUpdate({ sessionUpdate, content: { type: "text", text } });
    prompt.mockImplementationOnce(async () => {
      await feed("user_message_chunk", "original brief");
      await feed("agent_message_chunk", "partial answer");
      throw new Error(CONTENTION);
    }).mockImplementationOnce(async (request: { prompt: Array<{ text: string }> }) => {
      await feed("user_message_chunk", request.prompt[0]!.text);
      await feed("agent_message_chunk", "recovered answer");
      return { stopReason: "end_turn" };
    });
    await runtime.prompt("original brief");
    expect(events.filter(event => event.kind === "agent-text").map(event => event.text)).toEqual(["partial answer", "recovered answer"]);
  });

  it("exhausts one three-retry budget even after output", async () => {
    const { runtime, prompt } = fixture({ failures: 99, output: true });
    await expect(runtime.prompt("brief")).rejects.toThrow(/another Claude Code process/);
    expect(prompt).toHaveBeenCalledTimes(4);
  });

  it("stops on a classified permanent authentication failure", async () => {
    const { runtime, prompt } = fixture({ error: new Error("Failed to authenticate: OAuth session expired and could not be refreshed") });
    await expect(runtime.prompt("brief")).rejects.toThrow(/OAuth session expired/);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("cancel during backoff prevents another prompt and leaves the session intact", async () => {
    const { runtime, prompt } = fixture({ output: true });
    runtime.onEvent(async event => { if (event.kind === "recovery") await runtime.cancel(); });
    await expect(runtime.prompt("brief")).rejects.toThrow(/another Claude Code process/);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect((runtime as any).sessionId).toBe("s1");
  });
});
