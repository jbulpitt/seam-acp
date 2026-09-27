import { describe, expect, it } from "vitest";
import {
  observeCanaryMessages,
  observeDurabilityOutput,
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
    ], nonce)).toEqual({ state: "done", nonceSeen: true, toolSeen: false });

    expect(observeCanaryMessages([
      message({ content: nonce }),
      message({ components: ["Done", "Tool: Execute echo"] }),
    ], nonce)).toEqual({ state: "done", nonceSeen: true, toolSeen: true });

    expect(observeCanaryMessages([
      message({ content: nonce }),
      message({ embeds: ["Done\n`▶️ Terminal`  `⚙️ echo canary-nonce`\nAction: end_turn"] }),
    ], nonce)).toEqual({ state: "done", nonceSeen: true, toolSeen: true });
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
      toolSeen: false,
      cause: "remote agent supervisor exited before initialize on host 'local'",
    });
  });

  it("names missing, duplicated, out-of-order, and duplicate reply evidence", () => {
    const expected = ["nonce-1", "nonce-2", "nonce-3"];
    const observed = observeDurabilityOutput([
      message({ id: "1", content: "nonce-2\nnonce-1" }),
      message({ id: "2", content: "nonce-2" }),
    ], expected);
    expect(observed).toEqual({
      missing: ["nonce-3"],
      duplicated: [{ line: "nonce-2", count: 2 }],
      observed: ["nonce-2", "nonce-1", "nonce-2"],
      inOrder: false,
      replyCount: 2,
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

  it("renders one labeled row per durability check", () => {
    const result: CanaryRunResult = {
      id: "12345678-aaaa-bbbb-cccc-dddddddddddd",
      target: "staging",
      startedAt: "2026-09-27T00:00:00.000Z",
      finishedAt: "2026-09-27T00:01:00.000Z",
      branch: "feat/640-staging-durability",
      commit: "0123456789abcdef",
      durability: true,
      rows: [
        {
          host: "dev",
          agent: "codex",
          check: "sessiond restart",
          status: "failed",
          durationMs: 42_000,
          cause: "missing: nonce-4, nonce-5",
        },
      ],
    };
    const layout = renderCanaryLayout(result);
    const text = layout.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.content)
      .join("\n");
    expect(text).toContain("Staging durability — RED");
    expect(text).toContain("**dev@codex** · sessiond restart · 42s");
    expect(text).toContain("missing: nonce-4, nonce-5");
  });
});
