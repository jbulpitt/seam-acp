import { describe, it, expect, beforeEach } from "vitest";
import { AgentRuntime, type AgentEvent } from "../src/agents/agent-runtime.js";
import type { AgentProfile } from "../src/agents/agent-profile.js";
import { logger } from "../src/lib/logger.js";
import { WATCH_FEEDBACK_INSTRUCTION, applyWatchFeedback } from "../src/core/dispatch/types.js";

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
  /** Stop reason the prompt RPC resolves with. Default clean end_turn; set to
   *  "cancelled" (or anything non-end_turn) to model an interrupted turn (#67). */
  promptStopReason = "end_turn";
  /** When true, the prompt RPC feeds its updates then REJECTS — models a turn
   *  that dies via error/dispose (also an abnormal teardown, #64). */
  promptShouldReject = false;
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
    if (this.promptShouldReject) throw new Error("simulated turn error/dispose");
    return { stopReason: this.promptStopReason };
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

  it("cold resume: replayed agent content BEFORE the first user echo is suppressed (no bloat)", async () => {
    // #64 failure mode (b): the replay preamble LEADS with prior agent output
    // (no user_message_chunk ahead of it). With `resumeLiveSegment` starting
    // true, that stale history streamed through and bloated the turn. It must be
    // treated as replay and dropped once the boundary confirms this is a replay.
    await h.rt.loadSession({ sessionId: "s6", cwd: "/tmp" });
    h.conn.promptUpdates = [
      // Stale prior-turn history with NO leading user echo.
      agentChunk("STALE: old build report from feat/inject-turn."),
      agentChunk(" (2k chars of prior demos)"),
      userChunk("a prior user question"),
      agentChunk("a prior answer"),
      userChunk(PROMPT), // boundary: current prompt echoed
      agentChunk("The live answer."),
    ];
    await h.rt.prompt(PROMPT);
    expect(h.agentText()).toEqual(["The live answer."]);
    expect(h.agentText().join("")).not.toContain("STALE");
    expect(h.agentText().join("")).not.toContain("prior answer");
  });

  it("cold watchFeedback resume: reformatted + appended echo still bounds the live turn", async () => {
    // #64 core failure: a long, multi-line watchFeedback prompt (spec.prompt with
    // the standing poll_inbox instruction appended) whose echo comes back NOT
    // byte-identical — newlines collapsed and the appended tail reworded. The
    // old byte-exact `endsWith` boundary never matched, so (combined with leading
    // replayed agent content) stale history leaked AND the live turn was eaten.
    const specPrompt = [
      "Refactor dispatchInjectTurn so the watchFeedback instruction is appended",
      "after the preset-identity block, and add a regression test proving the",
      "resume-replay suppression holds on a cold handoff to a stale thread.",
    ].join("\n");
    // Exactly what dispatchInjectTurn composes and sends to prompt().
    const sent = applyWatchFeedback(specPrompt, true);
    // The wrapper echoes it reformatted: whitespace collapsed to single spaces
    // and the appended instruction reworded ("poll_inbox" -> "the poll_inbox tool").
    const reformattedEcho = sent
      .replace(/\s+/g, " ")
      .replace("poll_inbox", "the poll_inbox tool");

    await h.rt.loadSession({ sessionId: "s7", cwd: "/tmp" });
    h.conn.promptUpdates = [
      // Leading stale agent history (feature (b)).
      agentChunk("STALE: 2k of feat/presets-salvage build report dumped ahead."),
      // A prior watchFeedback turn — its echo ALSO ends with the standing
      // instruction, but it is NOT the current prompt and must not false-match.
      userChunk(applyWatchFeedback("an earlier, unrelated handoff prompt", true)),
      agentChunk("stale answer to the earlier handoff"),
      // Current prompt echoed back, reformatted/appended-differently (feature (a)).
      userChunk(reformattedEcho),
      agentChunk("Live: refactor done, regression test added."),
    ];
    await h.rt.prompt(sent);
    expect(h.agentText()).toEqual(["Live: refactor done, regression test added."]);
    expect(h.agentText().join("")).not.toContain("STALE");
    expect(h.agentText().join("")).not.toContain("earlier handoff");
    // Sanity: the appended instruction really is part of the sent prompt.
    expect(sent.endsWith(WATCH_FEEDBACK_INSTRUCTION)).toBe(true);
  });

  // --- #64 drop-on-abnormal-teardown refinement (#67) ----------------------
  // The held pre-echo buffer is only ever flushed on a CLEAN end_turn. An
  // interrupted turn (cancel/abort) or an errored one is exactly a
  // cancelled/never-echoed turn — flushing would surface stale replayed history,
  // so the abnormal-teardown path DROPS the buffer instead.

  it("cold resume ending in CANCEL drops the held pre-echo buffer (no replayed content) (#64/#67)", async () => {
    await h.rt.loadSession({ sessionId: "s8", cwd: "/tmp" });
    // Leading replayed agent content, NO user echo → held in the pre-echo buffer
    // (its live-vs-replay status is undecided when the turn is cut short).
    h.conn.promptStopReason = "cancelled";
    h.conn.promptUpdates = [
      agentChunk("STALE: replayed history held before any echo."),
      agentChunk(" (more stale content)"),
    ];
    const outcome = await h.rt.prompt(PROMPT);
    expect(outcome.stopReason).toBe("cancelled");
    // Abnormal teardown ⇒ the buffer is DROPPED, not flushed.
    expect(h.agentText()).toEqual([]);
  });

  it("cold resume whose turn ERRORS (RPC rejects) also drops the held buffer (#64/#67)", async () => {
    await h.rt.loadSession({ sessionId: "s9", cwd: "/tmp" });
    h.conn.promptShouldReject = true;
    h.conn.promptUpdates = [agentChunk("STALE held content before the crash.")];
    await expect(h.rt.prompt(PROMPT)).rejects.toBeTruthy();
    // No stopReason ever resolved ⇒ treated as abnormal ⇒ buffer dropped.
    expect(h.agentText()).toEqual([]);
  });

  it("cold resume ending CLEANLY (end_turn) still flushes the SAME held buffer (#64 clean path unchanged)", async () => {
    await h.rt.loadSession({ sessionId: "s10", cwd: "/tmp" });
    // Identical shape to the cancel case — the ONLY difference is the stop reason.
    h.conn.promptStopReason = "end_turn";
    h.conn.promptUpdates = [
      agentChunk("Genuinely live answer, no echo — "),
      agentChunk("held then flushed."),
    ];
    await h.rt.prompt(PROMPT);
    // Clean completion ⇒ the fail-safe flushes, so the live answer is not lost.
    expect(h.agentText()).toEqual(["Genuinely live answer, no echo — ", "held then flushed."]);
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
