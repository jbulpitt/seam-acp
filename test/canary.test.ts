import { describe, expect, it } from "vitest";
import {
  observeCanaryMessages,
  renderCanaryLayout,
  type CanaryRunResult,
} from "../packages/core/src/core/canary.js";
import type { TesterMessage } from "../packages/core/src/core/tester-bot.js";

function message(input: Partial<TesterMessage>): TesterMessage {
  return {
    id: "1",
    author: "staging",
    authorIsBot: true,
    content: "",
    embeds: [],
    components: [],
    attachments: [],
    timestamp: "2026-09-27T00:00:00.000Z",
    ...input,
  };
}

describe("staging canary observations", () => {
  it("passes only when the bot reply has the nonce and the status card is Done", () => {
    const nonce = "canary-nonce";
    expect(observeCanaryMessages([
      message({ content: nonce }),
      message({ components: ["Working", "Tool: echo"] }),
    ], nonce)).toMatchObject({ state: "working", nonceSeen: true });

    expect(observeCanaryMessages([
      message({ components: ["Done", "Completed"] }),
    ], nonce)).toMatchObject({ state: "done", nonceSeen: false });

    expect(observeCanaryMessages([
      message({ content: nonce }),
      message({ components: ["Done", "Completed"] }),
    ], nonce)).toEqual({ state: "done", nonceSeen: true });
  });

  it("keeps the real terminal cause from the status card", () => {
    const observed = observeCanaryMessages([
      message({
        embeds: [
          "Failed\nRepo: /workspace\nAction: remote agent supervisor exited before initialize on host 'local'",
        ],
      }),
    ], "unused");
    expect(observed).toEqual({
      state: "failed",
      nonceSeen: false,
      cause: "remote agent supervisor exited before initialize on host 'local'",
    });
  });
});

describe("staging canary result card", () => {
  it("renders revision, durations, skips, and the real red cause on one card", () => {
    const result: CanaryRunResult = {
      id: "12345678-aaaa-bbbb-cccc-dddddddddddd",
      target: "staging",
      startedAt: "2026-09-27T00:00:00.000Z",
      finishedAt: "2026-09-27T00:01:00.000Z",
      branch: "feat/640-staging-canary",
      commit: "0123456789abcdef",
      rows: [
        { host: "dev", agent: "claude", status: "passed", durationMs: 12_300, threadId: "10" },
        {
          host: "dev",
          agent: "grok",
          status: "failed",
          durationMs: 2_000,
          cause: "spawn /missing/grok ENOENT",
          providerNote: "xAI reports degraded_performance",
        },
        { host: "dev", agent: "agy", status: "skipped", durationMs: null, cause: "not ready" },
      ],
    };

    const layout = renderCanaryLayout(result);
    const text = layout.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.content)
      .join("\n");
    expect(layout.color).toBe(0xed4245);
    expect(text).toContain("Staging canary — RED");
    expect(text).toContain("feat/640-staging-canary");
    expect(text).toContain("0123456789ab");
    expect(text).toContain("✅ **dev@claude** · 12s");
    expect(text).toContain("❌ **dev@grok** · 2.0s");
    expect(text).toContain("spawn /missing/grok ENOENT");
    expect(text).toContain("Provider: xAI reports degraded_performance");
    expect(text).toContain("⏭️ **dev@agy** · —");
  });
});
