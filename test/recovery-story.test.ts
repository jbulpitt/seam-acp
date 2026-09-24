/**
 * #451: the resume situation is a template over facts already in hand.
 * A prompt that is only the word "continue" fails these tests.
 */
import { describe, expect, it } from "vitest";
import {
  REAUTH_COMPLETED_PREFIX,
  REAUTH_WAITING_PREFIX,
  recoveryFactsFromAttempt,
  recoveryStory,
} from "../packages/core/src/core/dispatch/recovery-story.js";

const LEAD = "The turn stopped and this session is being resumed in place.";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("recoveryStory", () => {
  it("appends a process-restart situation and repeats it in the note", () => {
    const facts = recoveryFactsFromAttempt({
      updatedUtc: "2026-09-22T04:00:00.000Z",
      stalledReason: null,
      promptStarted: true,
      providerIdentity: JSON.stringify({ title: "Claude Agent", name: "claude-agent-acp" }),
      identity: JSON.stringify({
        agent: "claude",
        model: "claude-opus-5",
        location: "local",
        cwd: "/home/ubuntu/Projects/seam-acp",
      }),
    }, new Date("2026-09-22T04:48:31.000Z"));
    facts.defaultBranch = { name: "origin/main", sha: SHA };
    const { prompt, note } = recoveryStory(facts);

    expect(prompt.startsWith("continue\n")).toBe(true);
    expect(prompt.indexOf(LEAD)).toBeGreaterThan(prompt.indexOf("continue"));
    expect(prompt).toContain("The process restarted while the turn was in flight.");
    expect(prompt).toContain("The attempt was last recorded 48m ago.");
    expect(prompt).toContain("The recorded model is claude-opus-5.");
    expect(prompt).toContain("The recorded agent is claude.");
    expect(prompt).toContain("The provider is Claude Agent.");
    expect(prompt).toContain("The session directory is /home/ubuntu/Projects/seam-acp.");
    expect(prompt).toContain(`The default branch origin/main is currently ${SHA}.`);
    expect(prompt).toContain("The transcript in this session is the work done before the stop.");
    expect(prompt).toContain("What is safe to assume is the transcript");
    expect(prompt).toContain("The attempt does not record that worktree or pull request.");
    expect(prompt).not.toContain("worktree path");

    // The person sees one line; the situation is for the model (#631).
    expect(note).toBe("🔌 Reconnected to session");
  });

  it("uses a stored stall reason and does not invent a worktree or a sha", () => {
    const { prompt } = recoveryStory(recoveryFactsFromAttempt({
      updatedUtc: "2026-09-22T04:48:00.000Z",
      stalledReason: "provider acquisition failed during execution: rpc timed out",
      promptStarted: true,
      identity: JSON.stringify({
        agent: "codex",
        location: "rhc-server",
        cwd: "/home/ubuntu/Projects/pronoa",
      }),
    }, new Date("2026-09-22T05:00:00.000Z")));

    expect(prompt).toContain("The recorded reason is: provider acquisition failed during execution: rpc timed out.");
    expect(prompt).not.toContain("The process restarted while the turn was in flight.");
    expect(prompt).toContain("The session runs on rhc-server. This resume does not include that host's git state.");
    expect(prompt).not.toContain("is currently");
    expect(prompt).not.toContain("/.worktrees/");
  });

  it("drops a default-branch tip when the session is not local", () => {
    const { prompt, note } = recoveryStory({
      cause: "process_restart",
      promptStarted: true,
      location: "rhc-server",
      defaultBranch: { name: "origin/main", sha: SHA },
    });
    expect(prompt).not.toContain(SHA);
    expect(note).not.toContain(SHA);
    expect(prompt).toContain("does not include that host's git state");
  });

  it("omits a gap that was just rewritten", () => {
    const now = new Date("2026-09-22T05:00:00.000Z");
    const { prompt } = recoveryStory(recoveryFactsFromAttempt({
      updatedUtc: now.toISOString(),
      promptStarted: true,
    }, now));
    expect(prompt).not.toContain("last recorded");
  });

  it("renders a classified retry from the verdict, without a pull-request check", () => {
    const { prompt, note } = recoveryStory({
      cause: "classified_retry",
      errorKind: "rate_limit",
      agentId: "claude",
      rung: 1,
      retry: 2,
      retryBudget: 3,
      backoffSeconds: 5,
      alreadyProducedOutput: true,
      substitutedModel: "claude-sonnet-5",
    });
    expect(prompt.startsWith("continue\n")).toBe(true);
    expect(prompt).toContain("claude reported rate_limit.");
    expect(prompt).toContain("The recovery ladder is executing rung 1, retry 2 of 3 after 5s.");
    expect(prompt).toContain("The model for this attempt is claude-sonnet-5.");
    expect(prompt).toContain("continuing the existing conversation");
    expect(prompt).not.toContain("pull request");
    expect(prompt).not.toContain("The process restarted");
    expect(note.startsWith("Recovery:\n")).toBe(true);
    expect(note).toContain("claude reported rate_limit.");
    expect(note).toContain("rung 1, retry 2 of 3 after 5s");
  });

  it("tells a completed re-auth to continue without replaying the prompt", () => {
    const facts = recoveryFactsFromAttempt({
      updatedUtc: "2026-09-22T06:00:00.000Z",
      stalledUtc: "2026-09-22T04:00:00.000Z",
      stalledReason: `${REAUTH_COMPLETED_PREFIX} provider authentication was completed outside this turn`,
      promptStarted: true,
      identity: JSON.stringify({ agent: "claude", model: "claude-opus-5", cwd: "/repo" }),
    }, new Date("2026-09-22T06:00:00.000Z"));
    expect(facts.cause).toBe("reauthentication");
    const { prompt, note } = recoveryStory(facts);
    expect(prompt.startsWith("continue\n")).toBe(true);
    expect(prompt).toContain("Authentication was completed outside this turn.");
    expect(prompt).toContain("Do not repeat it.");
    expect(prompt).toContain("The attempt was last recorded 2h ago.");
    expect(prompt).not.toContain("retries it as-is");
    expect(prompt).not.toContain("The process restarted");
    expect(prompt).not.toContain(REAUTH_COMPLETED_PREFIX);
    expect(prompt).not.toContain(REAUTH_WAITING_PREFIX);
    expect(note.startsWith("Recovery:\n")).toBe(true);
    expect(note).not.toContain("resuming after restart");
  });

  it("a classified retry with no output says it is retrying the request", () => {
    const { prompt } = recoveryStory({
      cause: "classified_retry",
      errorKind: "auth_contention",
      agentId: "claude",
      rung: 1,
      retry: 1,
      retryBudget: 3,
      backoffSeconds: 2,
      alreadyProducedOutput: false,
    });
    expect(prompt).toContain("claude reported auth_contention.");
    expect(prompt).toContain("The request had not produced output yet, so this retries it as-is.");
    expect(prompt).not.toContain("continuing the existing conversation");
  });
});
