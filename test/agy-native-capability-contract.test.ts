import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@agentclientprotocol/sdk";
import { makeAgyNativeRuntime, makeAgyProfile } from "@seam/adapters";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AgentRuntime,
  type AgentEvent,
} from "../packages/core/src/agents/agent-runtime.js";
import { DispatchStatusPanel } from "../packages/core/src/core/dispatch-status-panel.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { TurnStatus } from "../packages/core/src/core/status-panel.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { MessageAttachment } from "../packages/core/src/platforms/chat-adapter.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { serializePanelText } from "../packages/core/src/platforms/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { createManagedAgyFixture, type ManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "fixtures", "agy-native-capabilities");
const fakeCli = path.join(fixtureDir, "fake-native-agy.mjs");
const logger = pino({ level: "silent" }) as unknown as Logger;
const expectedConversation = "11111111-1111-4111-8111-111111111111";
const expectedThinking = "Inspect fixture 🧭\nPlan safely\n";

interface Invocation {
  scenario: string;
  prompt?: string;
  conversationId?: string;
  resumedConversation?: string | null;
  home?: string | null;
  mcpConfig?: {
    mcpServers?: Record<string, {
      serverUrl?: string;
      headers?: Record<string, string>;
    }>;
  } | null;
  jsonSchema?: Record<string, unknown> | null;
  args?: string[];
  cwd?: string;
  signal?: string;
}

interface Provenance {
  schemaVersion: number;
  sanitized: boolean;
  runtime: {
    cliVersion: string;
    adapter: string;
    modelId: string;
    modelEvidence: string;
  };
  capabilities: Array<{
    id: string;
    evidence: string[];
    liveVerified: boolean;
  }>;
}

const seamMcp: McpServer = {
  type: "http",
  name: "seam-mcp",
  url: "http://127.0.0.1:3000/mcp",
  headers: [{ name: "X-Seam-Session", value: "synthetic-session-token" }],
};

let root: string;
let invocationLog: string;
let mappingDir: string;
let managedCli: ManagedAgyFixture;
const sessionHomes = new Set<string>();

function readInvocations(): Invocation[] {
  if (!fs.existsSync(invocationLog)) return [];
  return fs.readFileSync(invocationLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}

async function waitForInvocation(
  predicate: (entry: Invocation) => boolean,
  timeoutMs = 2_000,
): Promise<Invocation | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const found = readInvocations().find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  return undefined;
}

function makeRuntime(dataDir = mappingDir): AgentRuntime {
  const profile = makeAgyProfile({
    runtime: makeAgyNativeRuntime({
      executable: managedCli.executable,
      runtimeRoot: managedCli.runtimeRoot,
      version: "agy fixture 1.1.28",
      sha256: managedCli.sha256,
      credentialScope: "antigravity-oauth:test",
      cwd: os.tmpdir(),
      baseEnv: process.env,
      approvedEnvironment: {
        SEAM_AGY_CAPABILITY_FIXTURE_DIR: process.env.SEAM_AGY_CAPABILITY_FIXTURE_DIR!,
        SEAM_AGY_CAPABILITY_INVOCATIONS: invocationLog,
      },
    }),
    dataDir,
    defaultModel: "Fixture Native Model",
    persistModelSelection: false,
    exposeGlobalStaging: false,
  });
  return new AgentRuntime({ profile, logger, mcpServers: [seamMcp] });
}

function capturePanels(style: "full" | "simple") {
  const rendered: StructuredPanel[] = [];
  const status = new TurnStatus({
    model: "fixture-native-model",
    repoDisplay: "sanitized-repo",
    style,
  });
  const panel = new DispatchStatusPanel(
    discordRenderer,
    status,
    {
      post: async (value) => {
        rendered.push(value);
        return `${style}-panel`;
      },
      edit: async (_ref, value) => { rendered.push(value); },
    },
    { debounceMs: 0, heartbeatMs: 1_000_000 },
  );
  return { panel, rendered };
}

function attachment(over: Partial<MessageAttachment>): MessageAttachment {
  return {
    url: "data:application/octet-stream;base64,AAEC",
    filename: "payload.bin",
    contentType: "application/octet-stream",
    size: 3,
    ...over,
  };
}

function nativeThought(events: readonly AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { kind: "agent-thought" }> =>
      event.kind === "agent-thought")
    .map((event) => event.text)
    .join("");
}

function usageSequence(events: readonly AgentEvent[]): Array<{ used: number; size: number }> {
  return events
    .filter((event): event is Extract<AgentEvent, { kind: "usage-update" }> =>
      event.kind === "usage-update")
    .map(({ used, size }) => ({ used, size }));
}

function fullCardThoughtLines(panel: StructuredPanel): string[] {
  return (panel.footer ?? "")
    .split("\n")
    .filter((line) => line.startsWith("💡 "));
}

function simpleCardThoughtObservations(panels: readonly StructuredPanel[]): string[] {
  const observations = panels
    .map((panel) => /💡 ([^•]+)/u.exec(panel.footer ?? "")?.[1]?.trim())
    .filter((value): value is string => value !== undefined);
  return observations.filter((value, index) => value !== observations[index - 1]);
}

async function renderEvents(
  events: readonly AgentEvent[],
  style: "full" | "simple",
): Promise<string> {
  const captured = capturePanels(style);
  await captured.panel.start();
  for (const event of events) captured.panel.handleEvent(event);
  await captured.panel.finalize("Done", "Completed");
  return captured.rendered.map(serializePanelText).join("\n");
}

async function runNegativeTrace(
  mutate: (trace: Record<string, unknown>) => void,
): Promise<AgentEvent[]> {
  const changedFixtures = fs.mkdtempSync(path.join(root, "negative-"));
  for (const filename of [
    "turn-one.json",
    "turn-two-resume.json",
    "structured-turn.json",
    "interrupted-turn.json",
  ]) {
    fs.copyFileSync(path.join(fixtureDir, filename), path.join(changedFixtures, filename));
  }
  const tracePath = path.join(changedFixtures, "turn-one.json");
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8")) as Record<string, unknown>;
  mutate(trace);
  fs.writeFileSync(tracePath, `${JSON.stringify(trace)}\n`);

  const prior = process.env.SEAM_AGY_CAPABILITY_FIXTURE_DIR;
  process.env.SEAM_AGY_CAPABILITY_FIXTURE_DIR = changedFixtures;
  const runtime = makeRuntime(fs.mkdtempSync(path.join(root, "mapping-negative-")));
  const events: AgentEvent[] = [];
  runtime.onEvent((event) => { events.push(event); });
  try {
    await runtime.start();
    await runtime.newSession({
      cwd: root,
      model: "fixture-native-model",
      strictModel: true,
    });
    await runtime.prompt("capability-turn-one");
    await runtime.idle();
    return events;
  } finally {
    await runtime.dispose();
    process.env.SEAM_AGY_CAPABILITY_FIXTURE_DIR = prior;
  }
}

describe.sequential("native AGY R1 capability contract", () => {
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r1-"));
    invocationLog = path.join(root, "invocations.ndjson");
    mappingDir = path.join(root, "mapping");
    fs.mkdirSync(mappingDir);
    process.env.SEAM_AGY_CAPABILITY_FIXTURE_DIR = fixtureDir;
    process.env.SEAM_AGY_CAPABILITY_INVOCATIONS = invocationLog;
    managedCli = createManagedAgyFixture({
      source: fakeCli,
      version: "agy fixture 1.1.28",
      cwd: root,
      approvedEnvironment: {
        SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtureDir,
        SEAM_AGY_CAPABILITY_INVOCATIONS: invocationLog,
      },
    });
  });

  afterAll(() => {
    delete process.env.SEAM_AGY_CAPABILITY_FIXTURE_DIR;
    delete process.env.SEAM_AGY_CAPABILITY_INVOCATIONS;
    for (const home of sessionHomes) fs.rmSync(home, { recursive: true, force: true });
    managedCli.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("records explicit, non-live provenance for every frozen capability", () => {
    const provenance = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, "provenance.json"), "utf8"),
    ) as Provenance;
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      sanitized: true,
      runtime: {
        cliVersion: "1.1.28",
        adapter: "Seam native agy",
        modelId: "fixture-native-model",
      },
    });
    expect(provenance.runtime.modelEvidence).toMatch(/not a model self-report/i);
    expect(provenance.capabilities.map((entry) => entry.id)).toEqual([
      "thinking",
      "message-deltas-finalization",
      "read-edit-execute-tools",
      "tool-error-status",
      "usage-context-input",
      "interruption",
      "resume-high-water",
      "embedded-text-binary-attachments",
      "session-scoped-mcp",
      "structured-result",
    ]);
    for (const entry of provenance.capabilities) {
      expect(entry.evidence).toContain("source-confirmed");
      expect(entry.evidence).toContain("offline-reproduced");
      expect(entry.liveVerified).toBe(false);
    }
  });

  it("binds the native behavior gate to the R2 virtual-runtime descriptor", () => {
    const profile = makeAgyProfile({
      runtime: makeAgyNativeRuntime({
        executable: managedCli.executable,
        runtimeRoot: managedCli.runtimeRoot,
        version: "agy fixture 1.1.28",
        sha256: managedCli.sha256,
        credentialScope: "antigravity-oauth:test",
        cwd: root,
        approvedEnvironment: {
          SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtureDir,
          SEAM_AGY_CAPABILITY_INVOCATIONS: invocationLog,
        },
      }),
      defaultModel: "Fixture Native Model",
    });
    expect(profile.describe().runtime).toMatchObject({
      identity: expect.stringMatching(/^[a-f0-9]{64}$/),
      executable: "managed-artifact",
      argv: [],
      cwd: "session-workspace",
      environment: {},
      topology: "virtual-acp-native-cli",
      cwdPolicy: "session",
      provenance: {
        source: "google:antigravity-native-cli",
        version: "agy fixture 1.1.28",
        sha256: managedCli.sha256,
      },
    });
  });

  it("replays native thinking, message, tool, usage, resume, attachment, schema, and interruption behavior end to end", async () => {
    const runtime = makeRuntime();
    const events: AgentEvent[] = [];
    const full = capturePanels("full");
    const simple = capturePanels("simple");
    await full.panel.start();
    await simple.panel.start();
    runtime.onEvent((event) => {
      events.push(event);
      full.panel.handleEvent(event);
      simple.panel.handleEvent(event);
    });

    await runtime.start();
    expect(runtime.getPromptCapabilities()).toEqual({ embeddedContext: true });
    const session = await runtime.newSession({
      cwd: root,
      model: "fixture-native-model",
      strictModel: true,
    });
    expect(session.currentModelId).toBe("fixture-native-model");

    const first = await runtime.prompt(
      "capability-turn-one",
      [
        attachment({
          url: "data:text/plain,embedded%20fixture%20text",
          filename: "notes.txt",
          contentType: "text/plain",
          size: 21,
        }),
        attachment({}),
      ],
    );
    await runtime.idle();
    expect(first).toMatchObject({ stopReason: "end_turn", cancelled: false });
    expect(nativeThought(events)).toBe(expectedThinking);
    expect(events
      .filter((event): event is Extract<AgentEvent, { kind: "agent-text" }> =>
        event.kind === "agent-text")
      .map((event) => event.text)
      .join(""))
      .toBe("Result one.");

    const starts = events.filter(
      (event): event is Extract<AgentEvent, { kind: "tool-start" }> => event.kind === "tool-start",
    );
    expect(starts.map((event) => [event.toolCallId, event.title])).toEqual([
      ["agy-step-2", "view file"],
      ["agy-step-3", "edit file"],
      ["agy-step-4", "run command"],
    ]);
    expect(events.filter((event) => event.kind === "tool-update")).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCallId: "agy-step-2", status: "completed" }),
      expect.objectContaining({ toolCallId: "agy-step-3", status: "completed" }),
      expect.objectContaining({ toolCallId: "agy-step-4", status: "failed" }),
    ]));
    expect(usageSequence(events)).toEqual([
      { used: 128, size: 4096 },
      { used: 160, size: 4096 },
      { used: 200, size: 4096 },
    ]);
    for (const captured of [full, simple]) {
      expect(captured.panel.status.contextUsedHighWater).toBe(200);
      expect(captured.panel.status.contextWindowSize).toBe(4096);
    }
    expect(JSON.stringify(events)).not.toMatch(/SANITIZED PRIVATE (READ|EDIT|COMMAND)/);

    await full.panel.finalize("Done", "Completed");
    await simple.panel.finalize("Done", "Completed");
    const fullCard = serializePanelText(full.rendered.at(-1)!);
    const simpleCard = serializePanelText(simple.rendered.at(-1)!);
    expect(fullCardThoughtLines(full.rendered.at(-1)!)).toEqual([
      "💡 Inspect fixture 🧭",
      "💡 Plan safely",
    ]);
    expect(simpleCardThoughtObservations(simple.rendered)).toEqual([
      "Inspect fixture 🧭",
      "Plan",
      "Plan safely",
    ]);
    expect(fullCard).toContain("🪟 0k / 4k (5%)");
    expect(simpleCard).toContain("🪟 5%");
    for (const card of [fullCard, simpleCard]) {
      expect(card).not.toMatch(/SANITIZED PRIVATE (READ|EDIT|COMMAND)/);
    }

    const firstInvocation = readInvocations().find((entry) => entry.scenario === "turn-one");
    expect(firstInvocation).toBeDefined();
    expect(firstInvocation?.cwd).toBe(root);
    expect(firstInvocation?.cwd).not.toBe(os.tmpdir());
    expect(firstInvocation?.prompt).toContain("[Attached file: notes.txt]\nembedded fixture text");
    expect(firstInvocation?.prompt).toContain("[Attached file: payload.bin — binary content not inlined]");
    expect(firstInvocation?.prompt).not.toContain("AAEC");
    expect(firstInvocation?.mcpConfig?.mcpServers?.["seam-mcp"]).toEqual({
      disabled: false,
      serverUrl: "http://127.0.0.1:3000/mcp",
      headers: { "X-Seam-Session": "synthetic-session-token" },
    });
    expect(firstInvocation?.home).toMatch(/seam-agy-homes/);
    if (firstInvocation?.home) {
      sessionHomes.add(firstInvocation.home);
      expect(fs.statSync(firstInvocation.home).mode & 0o077).toBe(0);
      expect(fs.statSync(path.join(firstInvocation.home, ".gemini", "config", "mcp_config.json")).mode & 0o077).toBe(0);
    }

    const sessionId = session.sessionId;
    await runtime.dispose();

    const resumed = makeRuntime();
    const resumedEvents: AgentEvent[] = [];
    resumed.onEvent((event) => { resumedEvents.push(event); });
    await resumed.start();
    await resumed.loadSession({
      sessionId,
      cwd: root,
      model: "fixture-native-model",
      strictModel: true,
    });
    const second = await resumed.prompt("capability-turn-two");
    await resumed.idle();
    expect(second).toMatchObject({ stopReason: "end_turn", cancelled: false });
    expect(nativeThought(resumedEvents)).toBe("Resume 🚀\nKept context\n");
    expect(JSON.stringify(resumedEvents)).not.toContain("STALE REPLAY");
    expect(resumedEvents
      .filter((event): event is Extract<AgentEvent, { kind: "agent-text" }> =>
        event.kind === "agent-text")
      .map((event) => event.text)
      .join(""))
      .toBe("Second result.");
    const resumeInvocation = readInvocations().find(
      (entry) => entry.scenario === "turn-two-resume",
    );
    expect(resumeInvocation).toMatchObject({
      conversationId: expectedConversation,
      resumedConversation: expectedConversation,
    });

    const structuredStart = resumedEvents.length;
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["summary", "count"],
      properties: {
        summary: { type: "string" },
        count: { type: "number" },
      },
    };
    const structured = await resumed.prompt("capability-structured", undefined, {
      jsonSchema: schema,
    });
    await resumed.idle();
    expect(structured).toMatchObject({ stopReason: "end_turn", cancelled: false });
    const structuredEvents = resumedEvents.slice(structuredStart);
    expect(structuredEvents
      .filter((event): event is Extract<AgentEvent, { kind: "agent-text" }> =>
        event.kind === "agent-text")
      .map((event) => event.text))
      .toEqual([JSON.stringify({ summary: "structured fixture", count: 2 })]);
    expect(JSON.stringify(structuredEvents)).not.toContain("PROGRESS TEXT MUST NOT");
    const structuredInvocation = readInvocations().find(
      (entry) => entry.scenario === "structured-turn",
    );
    expect(structuredInvocation?.jsonSchema).toEqual(schema);
    const schemaPath = structuredInvocation?.args?.[
      (structuredInvocation.args?.indexOf("--json-schema") ?? -2) + 1
    ];
    expect(schemaPath).toBeTruthy();
    expect(fs.existsSync(schemaPath!)).toBe(false);

    let interruptObserved!: () => void;
    const sawInterrupt = new Promise<void>((resolve) => { interruptObserved = resolve; });
    resumed.onEvent((event) => {
      resumedEvents.push(event);
      if (event.kind === "agent-thought" && event.text.includes("Interruptible")) {
        interruptObserved();
      }
    });
    const interruptedPromise = resumed.prompt("capability-interrupt");
    await Promise.race([
      sawInterrupt,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("interruption fixture did not start")), 5_000)),
    ]);
    await resumed.cancel();
    const interrupted = await Promise.race([
      interruptedPromise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("interrupted native turn did not settle")), 5_000)),
    ]);
    expect(interrupted).toMatchObject({ stopReason: "cancelled", cancelled: true });
    expect(await waitForInvocation((entry) =>
      entry.scenario === "interrupted-turn" && entry.signal === "SIGTERM"))
      .toMatchObject({ scenario: "interrupted-turn", signal: "SIGTERM" });
    const persisted = JSON.parse(
      fs.readFileSync(path.join(mappingDir, "agy-sessions.json"), "utf8"),
    ) as Record<string, { cascadeId: string; maxStepIndex: number }>;
    expect(persisted[sessionId]).toMatchObject({
      cascadeId: expectedConversation,
      maxStepIndex: 6,
    });
    await resumed.dispose();
  }, 30_000);

  it("feeds native usage through the real AGY auto-compaction predicate and consumer", async () => {
    const dataDir = fs.mkdtempSync(path.join(root, "orchestrator-data-"));
    const turnMappingDir = fs.mkdtempSync(path.join(root, "orchestrator-mapping-"));
    const store = new SessionStore(path.join(dataDir, "seam.db"));
    const profile = makeAgyProfile({
      runtime: makeAgyNativeRuntime({
        executable: managedCli.executable,
        runtimeRoot: managedCli.runtimeRoot,
        version: "agy fixture 1.1.28",
        sha256: managedCli.sha256,
        credentialScope: "antigravity-oauth:test",
        cwd: root,
        baseEnv: process.env,
        approvedEnvironment: {
          SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtureDir,
          SEAM_AGY_CAPABILITY_INVOCATIONS: invocationLog,
        },
      }),
      dataDir: turnMappingDir,
      defaultModel: "Fixture Native Model",
      persistModelSelection: false,
      exposeGlobalStaging: false,
    });
    const runtime = new AgentRuntime({ profile, logger, mcpServers: [seamMcp] });
    await runtime.start();
    const session = await runtime.newSession({
      cwd: root,
      model: "fixture-native-model",
      strictModel: true,
    });
    const record = {
      id: "discord:agy-r1-compaction",
      platform: "discord",
      channelRef: "agy-r1-compaction",
      parentRef: null,
      agentId: "agy",
      acpSessionId: session.sessionId,
      repoPath: root,
      configJson: JSON.stringify({ model: "fixture-native-model" }),
      createdUtc: "2026-09-10T00:00:00.000Z",
      updatedUtc: "2026-09-10T00:00:00.000Z",
    } as const;
    store.upsert(record);

    const described = {
      agent: { value: "agy" },
      location: { value: "local" },
      model: { value: "fixture-native-model" },
      effort: { value: "default" },
      cwd: { value: root },
      statusCardStyle: { value: "full" },
      simpleCardGif: { value: false },
      fastMode: { value: false },
    };
    const profileWithoutCompactionManager = { ...profile, sessionManager: undefined };
    const router = {
      ensureSessionRecord: () => record,
      describeConfig: () => described,
      getProfile: () => profileWithoutCompactionManager,
      getOrStartRuntime: async () => runtime,
      hasRuntime: () => true,
      invalidate: async () => {},
      listProfiles: () => [profileWithoutCompactionManager],
    };
    const channel = { platform: "discord", id: record.channelRef } as const;
    const adapter = {
      sendPanel: async () => ({ channel, id: "status" }),
      editPanel: async () => {},
      sendMessage: async () => ({ channel, id: "message" }),
      editMessage: async () => {},
      sendTyping: async () => {},
    };
    const catalog = fixtureModelCatalog([profileWithoutCompactionManager]);
    const orchestrator = new Orchestrator({
      logger,
      config: {
        DATA_DIR: dataDir,
        REPOS_ROOT: root,
        TURN_TIMEOUT_SECONDS: 10,
        DEFAULT_AGENT: "agy",
        DEFAULT_MODEL: "fixture-native-model",
        AGY_AUTO_COMPACT_THRESHOLD: 0.04,
        CHANNEL_PRESETS_FILE: undefined,
        SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
        channelPresets: new Map(),
        threadPresets: new Map(),
        bridgePresets: new Map(),
      } as any,
      adapter: adapter as any,
      router: router as any,
      store,
      renderer: discordRenderer,
      modelCatalog: catalog,
    });
    const compact = vi.spyOn(orchestrator as any, "runAgyAutoCompact");

    try {
      await (orchestrator as any).executeIncomingMessage({
        channel,
        authorId: "fixture-user",
        authorIsBot: false,
        text: "capability-turn-one",
      });
      expect(compact).toHaveBeenCalledTimes(1);
      expect(compact.mock.calls[0]?.[4]).toBe(200);
      expect(compact.mock.calls[0]?.[2]).toMatchObject({
        contextUsedHighWater: 200,
        contextWindowSize: 4096,
      });
    } finally {
      compact.mockRestore();
      await runtime.dispose();
      store.close();
    }
  }, 30_000);

  it("negative control: removing plannerResponse.thinking breaks the thinking assertion", async () => {
    const events = await runNegativeTrace((trace) => {
      const updates = trace.updates as Array<Record<string, unknown>>;
      for (const update of updates) {
        const main = update.mainTrajectoryUpdate as Record<string, unknown> | undefined;
        const stepsUpdate = main?.stepsUpdate as { steps?: Array<Record<string, unknown>> } | undefined;
        for (const step of stepsUpdate?.steps ?? []) {
          const planner = step.plannerResponse as Record<string, unknown> | undefined;
          if (planner) delete planner.thinking;
        }
      }
    });
    expect(nativeThought(events)).not.toBe(expectedThinking);
    expect(nativeThought(events)).toBe("");
    for (const style of ["full", "simple"] as const) {
      const cardHistory = await renderEvents(events, style);
      expect(cardHistory).not.toContain("Inspect fixture 🧭");
      expect(cardHistory).not.toContain("Plan safely");
    }
  }, 20_000);

  it("negative control: removing mainTrajectoryUpdate.stepsUpdate breaks all output assertions", async () => {
    const events = await runNegativeTrace((trace) => {
      const updates = trace.updates as Array<Record<string, unknown>>;
      for (const update of updates) {
        const main = update.mainTrajectoryUpdate as Record<string, unknown> | undefined;
        if (main) delete main.stepsUpdate;
      }
    });
    expect(nativeThought(events)).not.toBe(expectedThinking);
    expect(events.some((event) => event.kind === "agent-text")).toBe(false);
    expect(events.some((event) => event.kind === "tool-start")).toBe(false);
    expect(events.some((event) => event.kind === "usage-update")).toBe(false);
  }, 20_000);
});
