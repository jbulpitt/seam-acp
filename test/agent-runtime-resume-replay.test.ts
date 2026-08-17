import { describe, it, expect, beforeEach } from "vitest";
import { AgentRuntime, type AgentEvent } from "../src/agents/agent-runtime.js";
import type { AgentProfile } from "../src/agents/agent-profile.js";
import { logger } from "../src/lib/logger.js";

/**
 * Drives AgentRuntime against a fake ACP connection to prove the resume-replay
 * suppression: after a `loadSession`, the first prompt's replayed history is
 * dropped and only the live turn streams downstream — for both wrapper variants
 * (replay-during-load and replay-as-prompt-preamble) — while fresh and warm
 * turns are never gated and a prompt that never echoes is never truncated.
 */

// Minimal profile — the runtime only reads `id` here; all model/effort paths
// no-op because the optional fields are absent.
const fakeProfile = { id: "fake" } as unknown as AgentProfile;

type Update = Record<string, unknown>;

const userChunk = (text: string): Update => ({
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text },
});
const agentChunk = (text: string): Update => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const thoughtChunk = (text: string): Update => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});
const usageUpdate = (): Update => ({
  sessionUpdate: "usage_update",
  used: 10,
  size: 100,
});

/** Fake ACP connection. Its `loadSession`/`prompt` replay a scripted list of
 *  session updates through the runtime's REAL handler pipeline (SerialQueue →
 *  handleSessionUpdateInner → emit), exactly as the SDK read loop would. */
class FakeConn {
  loadUpdates: Update[] = [];
  promptUpdates: Update[] = [];
  private feed: (u: Update) => Promise<void>;

  constructor(rt: AgentRuntime) {
    // handleSessionUpdate is private; the fake is a test double for the SDK.
    this.feed = (u) => (rt as unknown as { handleSessionUpdate(u: Update): Promise<void> }).handleSessionUpdate(u);
  }
  async loadSession(params: { sessionId: string }) {
    for (const u of this.loadUpdates) await this.feed(u);
    return { sessionId: params.sessionId, configOptions: null, modes: null };
  }
  async newSession() {
    return { sessionId: "fresh-session", configOptions: null, modes: null };
  }
  async prompt() {
    for (const u of this.promptUpdates) await this.feed(u);
    return { stopReason: "end_turn" };
  }
  async cancel() {}
  async setSessionConfigOption() {}
  async setSessionMode() {}
}

function makeRuntime() {
  const rt = new AgentRuntime({ profile: fakeProfile, logger });
  const conn = new FakeConn(rt);
  // Inject the fake connection + capabilities, bypassing start()/spawn.
  (rt as unknown as { connection: unknown }).connection = conn;
  (rt as unknown as { promptCapabilities: unknown }).promptCapabilities = {};
  const events: AgentEvent[] = [];
  rt.onEvent((e) => {
    events.push(e);
  });
  const agentText = () =>
    events.filter((e) => e.kind === "agent-text").map((e) => (e as { text: string }).text);
  return { rt, conn, events, agentText };
}

const PROMPT = "What is my favourite colour? Answer in one short sentence.";

describe("AgentRuntime resume-replay suppression", () => {
  let h: ReturnType<typeof makeRuntime>;
  beforeEach(() => {
    h = makeRuntime();
  });

  it("variant B (replay as prompt preamble): emits ONLY the live turn", async () => {
    // loadSession itself emits nothing — this wrapper replays on the first prompt.
    await h.rt.loadSession({ sessionId: "s1", cwd: "/tmp" });

    // First prompt stream: replayed (user,agent) pairs, then the current prompt
    // echoed back, then the live response (in two chunks). A usage update rides
    // along in the preamble and must survive suppression.
    h.conn.promptUpdates = [
      userChunk("What did we build yesterday?"),
      agentChunk("Yesterday we shipped the wake feature."),
      thoughtChunk("(stale reasoning from a past turn)"),
      userChunk("And the watch tests?"),
      agentChunk("The watch tests passed."),
      usageUpdate(),
      userChunk(PROMPT), // <-- boundary: current prompt echoed
      agentChunk("Your favourite "),
      agentChunk("colour is teal."),
    ];

    const outcome = await h.rt.prompt(PROMPT);
    expect(outcome.stopReason).toBe("end_turn");

    // Only the live response streamed; all replayed agent text suppressed.
    expect(h.agentText()).toEqual(["Your favourite ", "colour is teal."]);
    expect(h.agentText().join("")).not.toContain("Yesterday");
    expect(h.agentText().join("")).not.toContain("watch tests");
    // Replayed reasoning suppressed too.
    expect(h.events.some((e) => e.kind === "agent-thought")).toBe(false);
    // State events (usage) preserved through suppression.
    expect(h.events.some((e) => e.kind === "usage-update")).toBe(true);
  });

  it("variant A (replay during loadSession): preamble dropped, first prompt fully live", async () => {
    // This is the actual installed-wrapper behavior: history replays DURING the
    // load call, and the first prompt carries no echo — it's entirely live.
    h.conn.loadUpdates = [
      userChunk("Remember: my favourite colour is teal."),
      agentChunk("OK"),
    ];
    await h.rt.loadSession({ sessionId: "s2", cwd: "/tmp" });

    // Nothing emitted during load (all suppressed).
    expect(h.agentText()).toEqual([]);

    h.conn.promptUpdates = [agentChunk("Your favourite colour is teal.")];
    await h.rt.prompt(PROMPT);

    expect(h.agentText()).toEqual(["Your favourite colour is teal."]);
  });

  it("fresh newSession is never gated", async () => {
    await h.rt.newSession({ cwd: "/tmp" });
    h.conn.promptUpdates = [agentChunk("hello"), agentChunk(" world")];
    await h.rt.prompt("hi there");
    expect(h.agentText()).toEqual(["hello", " world"]);
  });

  it("warm second prompt after a resume is never gated", async () => {
    await h.rt.loadSession({ sessionId: "s3", cwd: "/tmp" });
    // First (gated) prompt.
    h.conn.promptUpdates = [userChunk(PROMPT), agentChunk("teal.")];
    await h.rt.prompt(PROMPT);
    expect(h.agentText()).toEqual(["teal."]);

    // Second prompt: suppression must be fully torn down — no echo, all live.
    h.conn.promptUpdates = [agentChunk("A warm reply, "), agentChunk("streamed in full.")];
    await h.rt.prompt("another question");
    expect(h.agentText()).toEqual(["teal.", "A warm reply, ", "streamed in full."]);
  });

  it("resumed prompt that never echoes falls back to emitting (no lost response)", async () => {
    await h.rt.loadSession({ sessionId: "s4", cwd: "/tmp" });
    // No user_message_chunk anywhere → boundary never fires → must NOT eat the
    // live response.
    h.conn.promptUpdates = [agentChunk("The live answer, "), agentChunk("emitted normally.")];
    await h.rt.prompt(PROMPT);
    expect(h.agentText()).toEqual(["The live answer, ", "emitted normally."]);
  });

  it("boundary matches even when the echo is split across chunks", async () => {
    await h.rt.loadSession({ sessionId: "s5", cwd: "/tmp" });
    h.conn.promptUpdates = [
      userChunk("old question"),
      agentChunk("old answer"),
      // Current prompt echoed as two fragments.
      userChunk("What is my favourite colour? "),
      userChunk("Answer in one short sentence."),
      agentChunk("Teal."),
    ];
    await h.rt.prompt(PROMPT);
    expect(h.agentText()).toEqual(["Teal."]);
  });
});
