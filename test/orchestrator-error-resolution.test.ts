import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyClaudeError, type AgentProfile } from "@seam/adapters";
import { RequestError } from "@agentclientprotocol/sdk";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("#441 real orchestrator consumer with fake ACP", () => {
  it.each(["retry", "changed-kind", "no-classifier", "output", "owned-output", "exhausted"] as const)("%s uses one structured prompt owner", async (mode) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-441-consumer-"));
    const store = new SessionStore(path.join(dir, "fixture.db"));
    const lines: string[] = [];
    const logger = pino({ level: "debug" }, { write(line: string) { lines.push(line); } });
    const profile = { id: "claude", defaultModel: "fixture-model",
      classifyError: mode === "no-classifier" ? undefined : classifyClaudeError,
      spawn() { throw new Error("provider spawn forbidden"); } } as unknown as AgentProfile;
    const runtime = new AgentRuntime({ profile, logger: logger as never });
    const first = new RequestError(-32603, "Internal error: Server is temporarily limiting requests · Rate limited", null);
    const second = mode === "changed-kind"
      ? new RequestError(-32603, "Rate limited", { errorKind: "quota_exhausted", agentId: "claude" })
      : new RequestError(-32603, "opaque provider failure", { errorKind: "rate_limit", agentId: "claude" });
    let calls = 0;
    const prompt = vi.fn(async (_request: unknown) => {
      calls++;
      if (mode.endsWith("output") && calls === 1) {
        await (runtime as any).handleSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial answer" } });
      }
      if (calls === 1 || mode === "exhausted") throw first;
      if (calls === 2) throw second;
      return { stopReason: "end_turn" };
    });
    Object.assign(runtime, { connection: { prompt }, sessionId: "fixture-acp", promptCapabilities: {},
      sessionInfo: { sessionId: "fixture-acp", availableModels: [], currentModelId: "fixture-model" } });
    const record = { id: "discord:fixture-thread", platform: "discord", channelRef: "fixture-thread",
      parentRef: null, agentId: "claude", acpSessionId: "fixture-acp", repoPath: dir, configJson: "{}",
      createdUtc: new Date().toISOString(), updatedUtc: new Date().toISOString() };
    store.upsert(record);
    if (mode === "owned-output") {
      store.admitInbound({ messageId: "owned-message", platform: "discord", channelRef: record.channelRef,
        parentRef: null, sessionRecordId: record.id, authorId: "fixture-user", authorName: "Fixture",
        text: "fixture", attachments: [], createdUtc: record.createdUtc });
      store.claimInbound("owned-message", 0, record.createdUtc);
    }
    const panels: unknown[] = [];
    const messages: string[] = [];
    const orch = new Orchestrator({ logger: logger as never, store, renderer: discordRenderer,
      modelCatalog: fixtureModelCatalog([profile]),
      config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60, REPO_EMOJIS: new Map(),
        DEFAULT_MODEL: "fixture-model", channelPresets: new Map(), threadPresets: new Map() } as never,
      router: { listProfiles: () => [profile], ensureSessionRecord: () => record, getProfile: () => profile,
        assertAgentAllowedForRecord() {}, getOrStartRuntime: async () => runtime,
        describeConfig: () => ({ agent: { value: "claude" }, location: { value: "local" },
          model: { value: "fixture-model" }, effort: { value: null }, cwd: { value: dir }, fastMode: { value: false } }),
      } as never,
      adapter: {
        async sendPanel(channel: unknown, panel: unknown) { panels.push(panel); return { channel, id: "panel" }; },
        async editPanel(_ref: unknown, panel: unknown) { panels.push(panel); },
        async sendMessage(channel: unknown, text: string) { messages.push(text); return { channel, id: "message" }; },
        async editMessage() {}, async sendFile() {},
      } as never,
    });
    // Shorten only existing backoff/idle guards, not the code deciding to retry.
    const originalTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      originalTimeout(fn, [2_000, 5_000, 10_000].includes(ms ?? 0) ? 0 : ms, ...args)) as typeof setTimeout);
    try {
      await (orch as unknown as { executeIncomingMessage(message: unknown): Promise<void> }).executeIncomingMessage({
        channel: { platform: "discord", id: record.channelRef }, authorId: "fixture-user", authorIsBot: false, text: "fixture",
        ...(mode === "owned-output" ? { messageId: "owned-message" } : {}),
      });
      expect(prompt, lines.join("\n")).toHaveBeenCalledTimes(mode === "changed-kind" ? 2 : mode === "exhausted" ? 4 : 3);
      expect(messages.some(text => text.startsWith("Recovery:"))).toBe(true);
      if (mode.endsWith("output")) {
        const continued = (prompt.mock.calls[1]![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
        expect(continued.startsWith("continue\n")).toBe(true);
        expect(continued).toContain("claude reported rate_limit.");
        expect(messages.some(text => text.includes("claude reported rate_limit."))).toBe(true);
        expect(messages.some(text => text.includes("continuing the existing conversation"))).toBe(true);
      }
      const resolution = lines.map((line) => JSON.parse(line)).find((line) => line.msg === "turn recovery resolved")?.resolution;
      expect(resolution).toMatchObject({ errorKind: mode === "no-classifier" ? "unclassified" : "rate_limit",
        startRung: 1, action: "recover", surface: true });
      const failures = lines.map((line) => JSON.parse(line)).filter((line) => line.msg === "turn failed");
      expect(failures).toHaveLength(mode === "changed-kind" || mode === "exhausted" ? 1 : 0);
      expect(panels.length).toBeGreaterThan(0); // not a classifier-only test.
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
