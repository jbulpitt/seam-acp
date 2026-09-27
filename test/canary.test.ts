import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  observeCanaryMessages,
  observeDurabilityOutput,
  renderCanaryLayout,
  StagingCanaryRunner,
  type CanaryRunResult,
} from "../packages/core/src/core/canary.js";
import type { TesterMessage } from "../packages/core/src/core/tester-bot.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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

  it("does not mistake a completed tool chip for a terminal status card", () => {
    const observed = observeCanaryMessages([
      message({
        embeds: [
          "Working\n`✅ mcp__artificial-analysis__startup`  `▶️ Terminal`\nAction: Running tool",
        ],
      }),
    ], "unused");
    expect(observed).toEqual({
      state: "working",
      nonceSeen: false,
      toolSeen: true,
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

describe("staging durability canary", () => {
  it("waits through each restart when a completed tool chip appears before the turn is Done", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "seam-canary-restart-"));
    tempDirs.push(dataDir);
    await fs.writeFile(path.join(dataDir, "canary-staging-threads.json"), JSON.stringify({
      version: 1,
      threads: {
        "local@codex": {
          threadId: "thread",
          threadName: "canary-local-codex",
          createdAt: "2026-09-27T00:00:00.000Z",
        },
      },
    }));

    let controller = 1;
    let bridge = 1;
    let activeNonce = "";
    let restarted = false;
    const restarts: string[] = [];
    const inventory = () => ({
      controllerInstanceId: `controller-${controller}`,
      branch: "fix/682-bridge-restart",
      commit: "abcdef0123456789",
      bridges: [{
        host: "local",
        instanceId: `bridge-${bridge}`,
        ready: true,
        agents: [{ id: "codex", installed: true, ready: true }],
      }],
    });
    const runner = new StagingCanaryRunner({
      dataDir,
      stagingChannelId: "parent",
      timeoutMs: 100,
      pollMs: 1,
      nonce: (() => {
        let ordinal = 0;
        return () => `nonce${++ordinal}`;
      })(),
      sleep: async () => {},
      testerBot: {
        findThread: async () => "thread",
        post: async ({ text }) => {
          activeNonce = text.match(/echo ([a-z0-9]+)-\$i/i)?.[1] ?? "missing";
          restarted = false;
          return { threadId: "thread", messageId: `prompt-${activeNonce}` };
        },
        read: async () => restarted
          ? [
              message({
                id: "card",
                embeds: ["Done\n`✅ startup`  `⚙️ Terminal`\nAction: end_turn"],
              }),
              message({
                id: "reply",
                content: [1, 2, 3, 4, 5, 6].map((i) => `${activeNonce}-${i}`).join("\n"),
              }),
            ]
          : [message({
              id: "card",
              embeds: ["Working\n`✅ startup`  `▶️ Terminal`\nAction: Running tool"],
            })],
      },
      testDriver: {
        interact: async () => ({ transcript: [], replied: true, deferred: false }),
        inventory: async () => inventory(),
        health: async () => {},
        restart: async (action) => {
          restarts.push(action);
          if (action === "controller" || action === "controller_bridge") controller += 1;
          if (action !== "controller") bridge += 1;
          restarted = true;
          return { accepted: true, action };
        },
      },
    });

    const result = await runner.run("staging", { durability: true });

    expect(restarts).toEqual(["controller", "bridge", "controller_bridge", "sessiond"]);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.every((row) => row.status === "passed")).toBe(true);
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
