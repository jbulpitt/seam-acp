import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import {
  AGENT_QUOTA_BUMP_AFTER_MS,
  AgentQuotaCard,
  renderAgentQuotaLayout,
} from "../packages/core/src/core/quota/agent-quota-card.js";
import { mapUnlimitedQuota } from "../packages/core/src/core/quota/agent-quota.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type {
  ChannelRef,
  ChatAdapter,
  MessageRef,
} from "../packages/core/src/platforms/chat-adapter.js";
import type { StructuredLayout } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

describe("agent quota card", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-quota-card-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("renders one row per configured agent with both windows", () => {
    const layout = renderAgentQuotaLayout([
      {
        ...mapUnlimitedQuota({ agentId: "claude", displayName: "Claude" }, 10),
        plan: "max",
        credits: { balance: "12", unlimited: false },
        rolling: { usedPercent: 25, resetsAt: 2_000_000_000, label: "rolling" },
        weekly: { usedPercent: 75, resetsAt: 2_000_100_000, label: "weekly" },
      },
    ], 2_000_000_000_000);
    const text = layout.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.kind === "text" ? block.content : "")
      .join("\n");
    expect(text).toContain("Claude");
    expect(text).toContain("rolling");
    expect(text).toContain("weekly");
    expect(text).toContain("25%");
    expect(text).toContain("75%");
    expect(text).toContain("plan max · credits 12");
  });

  it("edits the pinned card and silently self-bumps only after 20 hours", async () => {
    const now = 2_000_000_000_000;
    fs.writeFileSync(
      path.join(dir, "agent-quota-card.json"),
      JSON.stringify({
        threadId: "123",
        messageId: "existing",
        lastBumpAt: now - AGENT_QUOTA_BUMP_AFTER_MS - 1,
      })
    );
    const calls = { edits: 0, pins: 0, bumps: 0 };
    const adapter = {
      platform: "discord",
      async start() {},
      async stop() {},
      async sendMessage(channel: ChannelRef): Promise<MessageRef> {
        return { channel, id: "message" };
      },
      async editMessage() {},
      async sendLayout(channel: ChannelRef, _layout: StructuredLayout): Promise<MessageRef> {
        return { channel, id: "new" };
      },
      async editLayout() { calls.edits += 1; },
      async pinMessage() { calls.pins += 1; },
      async bumpThread() { calls.bumps += 1; },
    } as ChatAdapter;
    const card = new AgentQuotaCard({
      logger: silent,
      adapter,
      threadId: "123",
      dataDir: dir,
      collect: () => [mapUnlimitedQuota({ agentId: "local", displayName: "Local" })],
      now: () => now,
    });
    await card.start();
    expect(calls).toEqual({ edits: 1, pins: 1, bumps: 1 });
    await card.tick();
    expect(calls).toEqual({ edits: 2, pins: 1, bumps: 1 });
    card.stop();
  });
});
