import { testSessionRouter } from "./helpers/session-fixture.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestError, type SessionUpdate } from "@agentclientprotocol/sdk";
import { classifyCopilotError, type AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { fastProviderRetryClock } from "./helpers/provider-retry-clock.js";

const RETRY_MARKER = "— 🔁 retried — output above may repeat —";
type Feed = (update: SessionUpdate) => Promise<void>;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(fastProviderRetryClock);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function text(messageId: string, value: string): SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: value } };
}

/** Fake ACP notifications flow through AgentRuntime and the production turn handler. */
function fixture(program: (feed: Feed, attempt: number) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-retry-notices-"));
  const store = new SessionStore(path.join(dir, "fixture.db"));
  const logger = pino({ level: "silent" });
  const profile = { id: "copilot", defaultModel: "fixture-model", classifyError: classifyCopilotError,
    spawn() { throw new Error("provider spawn forbidden"); } } as unknown as AgentProfile;
  const runtime = new AgentRuntime({ profile, logger: logger as never,
    spawnFn: () => { throw new Error("provider spawn forbidden"); } });
  cleanups.push(async () => {
    await runtime.detach();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const feed: Feed = update => (runtime as unknown as {
    handleSessionUpdate(update: SessionUpdate): Promise<void>;
  }).handleSessionUpdate(update);
  let attempt = 0;
  const prompt = vi.fn(async (_request: { prompt: Array<{ type: string; text?: string }> }) => {
    // The existing post-turn usage query is not a work submission or retry.
    if (_request.prompt[0]?.text === "/context") {
      await feed(text("context", "1k / 64k tokens"));
      return { stopReason: "end_turn" };
    }
    await program(feed, ++attempt);
    return { stopReason: "end_turn" };
  });
  Object.assign(runtime, { connection: { prompt }, sessionId: "fixture-acp", promptCapabilities: {},
    sessionInfo: { sessionId: "fixture-acp", availableModels: [], currentModelId: "fixture-model" } });
  const record = { id: "discord:fixture-thread", platform: "discord", channelRef: "fixture-thread",
    parentRef: null, agentId: "copilot", acpSessionId: "fixture-acp", repoPath: dir, configJson: "{}",
    createdUtc: new Date().toISOString(), updatedUtc: new Date().toISOString() };
  store.upsert(record);
  const messages: string[] = [];
  const orch = new Orchestrator({ logger: logger as never, store, renderer: discordRenderer,
    modelCatalog: fixtureModelCatalog([profile]),
    config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60, REPO_EMOJIS: new Map(),
      DEFAULT_MODEL: "fixture-model", channelPresets: new Map(), threadPresets: new Map() } as never,
    router: testSessionRouter({ listProfiles: () => [profile], ensureSessionRecord: () => record,
      getProfile: () => profile, assertAgentAllowedForRecord() {}, getOrStartRuntime: async () => runtime,
      describeConfig: () => ({ agent: { value: "copilot" }, location: { value: "local" },
        model: { value: "fixture-model" }, effort: { value: null }, cwd: { value: dir }, fastMode: { value: false } }),
    }) as never,
    adapter: {
      async sendPanel(channel: unknown) { return { channel, id: "panel" }; },
      async editPanel() {},
      async sendMessage(channel: unknown, value: string) {
        messages.push(value);
        return { channel, id: `message-${messages.length}` };
      },
      async editMessage() {}, async sendFile() {},
    } as never,
  });
  return { messages, workRequests: () => prompt.mock.calls.map(([request]) => request)
    .filter(request => request.prompt[0]?.text !== "/context"), run: () => (orch as unknown as {
    executeIncomingMessage(message: unknown): Promise<void>;
  }).executeIncomingMessage({ channel: { platform: "discord", id: record.channelRef },
    authorId: "fixture-user", authorIsBot: false, text: "Synthetic fixture request." }) };
}

describe("retry notices through the production turn handler", () => {
  it("streams normal Copilot messages across tools and final text without retry notices or resubmission", async () => {
    const paragraphs = ["Checking the fixture.", "The first check completed.", "Checking the next item.",
      "The remaining check completed.", "All fixture checks are complete."];
    const deliveriesBeforeContinuation: string[][] = [];
    const h = fixture(async feed => {
      for (const [i, paragraph] of paragraphs.entries()) {
        await feed(text(`ordinary-${i}`, paragraph.slice(0, 8)));
        await feed(text(`ordinary-${i}`, paragraph.slice(8) + "\n\n"));
        if (i < paragraphs.length - 1) {
          await feed({ sessionUpdate: "tool_call", toolCallId: `tool-${i}`, title: "Synthetic check", status: "in_progress" });
          deliveriesBeforeContinuation.push([...h.messages]);
          await feed({ sessionUpdate: "tool_call_update", toolCallId: `tool-${i}`, status: "completed" });
        }
      }
    });

    await h.run();

    expect(h.messages.filter(value => value === RETRY_MARKER)).toEqual([]);
    expect(h.messages).toEqual(paragraphs);
    expect(deliveriesBeforeContinuation).toEqual(paragraphs.slice(0, -1).map((_, i) => paragraphs.slice(0, i + 1)));
    expect(h.workRequests()).toHaveLength(1);
  });

  it("keeps explicit interruption/retrying sentinels visible without notices at later normal boundaries", async () => {
    const sentinel = "The response was interrupted. Retrying...\n\n";
    const h = fixture(async feed => {
      await feed(text("attempt-1", "Partial first answer.\n\n"));
      await feed(text("retry-1", sentinel));
      await feed(text("attempt-2", "Another partial answer.\n\n"));
      await feed(text("retry-2", sentinel));
      await feed(text("final", "Completed answer."));
    });

    await h.run();

    const markerIndexes = h.messages.flatMap((value, i) => value === RETRY_MARKER ? [i] : []);
    expect(markerIndexes).toHaveLength(2);
    expect(h.messages.slice(0, markerIndexes[0]).join("")).toContain("Partial first answer.");
    expect(h.messages.slice(markerIndexes[0]! + 1, markerIndexes[1]).join(""))
      .toContain("Another partial answer.");
    expect(h.messages.slice(markerIndexes[1]! + 1).join("")).toContain("Completed answer.");
    expect(h.messages.join("")).toContain(sentinel.trim());
    expect(h.workRequests()).toHaveLength(1);
  });

  it("renders a real classified retry's normalized recovery event and original cause", async () => {
    const cause = new RequestError(-32603, "Synthetic provider throttle", { agentId: "copilot", errorKind: "rate_limit" });
    const h = fixture(async (feed, attempt) => {
      if (attempt === 1) {
        await feed(text("before-recovery", "Partial answer.\n\n"));
        await feed({ sessionUpdate: "tool_call", toolCallId: "fixture-tool", title: "Synthetic check", status: "in_progress" });
        await feed({ sessionUpdate: "tool_call_update", toolCallId: "fixture-tool", status: "completed" });
        throw cause;
      }
      await feed(text("after-recovery", "Recovered answer."));
    });

    await h.run();

    expect(h.workRequests()).toHaveLength(2);
    expect(h.workRequests()[1]!.prompt[0]!.text).toMatch(/^continue\n/);
    const recoveryIndex = h.messages.findIndex(value => value.startsWith("Recovery:"));
    expect(recoveryIndex).toBeGreaterThan(h.messages.indexOf("Partial answer."));
    expect(h.messages[recoveryIndex]).toContain("copilot reported rate_limit.");
    expect(h.messages[recoveryIndex]).toContain(cause.message);
    expect(h.messages.indexOf("Recovered answer.")).toBeGreaterThan(recoveryIndex);
    expect(h.messages.filter(value => value === RETRY_MARKER)).toEqual([]);
  });
});
