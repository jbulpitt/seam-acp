import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@agentclientprotocol/sdk";
import { AGY_ASSUMED_CONTEXT_WINDOW, makeAgyNativeRuntime, makeAgyProfile } from "@seam/adapters";
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
  pid?: number;
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

function makeRuntime(
  dataDir = mappingDir,
  options: {
    defaultModel?: string;
    initialSettingsFile?: string;
    approvedEnvironment?: Readonly<Record<string, string>>;
  } = {},
): AgentRuntime {
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
        ...options.approvedEnvironment,
      },
    }),
    dataDir,
    defaultModel: options.defaultModel ?? "Fixture Native Model",
    ...(options.initialSettingsFile
      ? { initialSettingsFile: options.initialSettingsFile }
      : {}),
    exposeGlobalStaging: false,
  });
  return new AgentRuntime({ profile, logger, mcpServers: [seamMcp] });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
      "session-model-isolation",
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
      { used: 128, size: AGY_ASSUMED_CONTEXT_WINDOW },
      { used: 160, size: AGY_ASSUMED_CONTEXT_WINDOW },
      { used: 200, size: AGY_ASSUMED_CONTEXT_WINDOW },
    ]);
    for (const captured of [full, simple]) {
      expect(captured.panel.status.contextUsedHighWater).toBe(200);
      // #260: the status card reports what the turn was actually sized
      // against. With prompt-free discovery that is the conservative
      // assumption, not a language-server window — and the card showing the
      // number we really used is the point.
      expect(captured.panel.status.contextWindowSize).toBe(AGY_ASSUMED_CONTEXT_WINDOW);
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
    expect(fullCard).toContain("🪟 0k / 128k (0%)");
    expect(simpleCard).toContain("🪟 0%");
    for (const card of [fullCard, simpleCard]) {
      expect(card).not.toMatch(/SANITIZED PRIVATE (READ|EDIT|COMMAND)/);
    }

    const firstInvocation = readInvocations().find((entry) => entry.scenario === "turn-one");
    expect(firstInvocation).toBeDefined();
    // R5: the production ACP response must wait for native process cleanup.
    expect(firstInvocation?.pid).toBeTypeOf("number");
    expect(() => process.kill(firstInvocation!.pid!, 0)).toThrow();
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

  it("keeps exact native model choices session-owned across concurrency, failure, and resume", async () => {
    const r3Root = fs.mkdtempSync(path.join(root, "model-isolation-"));
    const r3Mapping = path.join(r3Root, "mapping");
    const settingsFile = path.join(r3Root, "settings.json");
    fs.mkdirSync(r3Mapping);
    fs.writeFileSync(
      settingsFile,
      `${JSON.stringify({ model: "Fixture Native Model (Low)", retained: "unchanged" }, null, 2)}\n`,
    );
    // Test-owned hashing observes the external file bytes; production never
    // computes its own oracle for the unchanged-settings assertion.
    const settingsHash = () => createHash("sha256")
      .update(fs.readFileSync(settingsFile))
      .digest("hex");
    const initialSettingsHash = settingsHash();
    const first = makeRuntime(r3Mapping, { defaultModel: "", initialSettingsFile: settingsFile });
    const second = makeRuntime(r3Mapping, { defaultModel: "", initialSettingsFile: settingsFile });
    let firstSessionId = "";
    let secondSessionId = "";

    try {
      await Promise.all([first.start(), second.start()]);
      const [firstSession, secondSession] = await Promise.all([
        first.newSession({
          cwd: r3Root,
          model: "fixture-native-model",
          strictModel: true,
        }),
        second.newSession({
          cwd: r3Root,
          model: "fixture-native-model-low",
          strictModel: true,
        }),
      ]);
      firstSessionId = firstSession.sessionId;
      secondSessionId = secondSession.sessionId;

      await Promise.all([
        first.prompt("capability-model-a"),
        second.prompt("capability-model-b"),
      ]);
      await Promise.all([first.idle(), second.idle()]);

      const firstInvocation = readInvocations().find(
        (entry) => entry.prompt === "capability-model-a",
      );
      const secondInvocation = readInvocations().find(
        (entry) => entry.prompt === "capability-model-b",
      );
      const firstModelAt = firstInvocation?.args?.indexOf("--model") ?? -1;
      const secondModelAt = secondInvocation?.args?.indexOf("--model") ?? -1;
      expect(firstInvocation?.args?.slice(firstModelAt, firstModelAt + 2)).toEqual([
        "--model",
        "Fixture Native Model",
      ]);
      expect(secondInvocation?.args?.slice(secondModelAt, secondModelAt + 2)).toEqual([
        "--model",
        "Fixture Native Model (Low)",
      ]);

      const mappingFile = path.join(r3Mapping, "agy-sessions.json");
      const persisted = JSON.parse(fs.readFileSync(mappingFile, "utf8")) as Record<
        string,
        { modelId?: string }
      >;
      expect(persisted[firstSessionId]?.modelId).toBe("fixture-native-model");
      expect(persisted[secondSessionId]?.modelId).toBe("fixture-native-model-low");
      expect(settingsHash()).toBe(initialSettingsHash);

      const mappingBeforeInvalid = fs.readFileSync(mappingFile, "utf8");
      await expect(first.setModel("fixture-model-does-not-exist")).rejects.toThrow(
        "Invalid params",
      );
      expect(first.getSessionInfo()?.currentModelId).toBe("fixture-native-model");
      expect(fs.readFileSync(mappingFile, "utf8")).toBe(mappingBeforeInvalid);
      expect(settingsHash()).toBe(initialSettingsHash);

      const mappingDirMode = fs.statSync(r3Mapping).mode & 0o777;
      fs.chmodSync(r3Mapping, 0o500);
      try {
        await expect(first.setModel("fixture-native-model-low")).rejects.toThrow();
      } finally {
        fs.chmodSync(r3Mapping, mappingDirMode);
      }
      expect(first.getSessionInfo()?.currentModelId).toBe("fixture-native-model");
      expect(fs.readFileSync(mappingFile, "utf8")).toBe(mappingBeforeInvalid);
      expect(settingsHash()).toBe(initialSettingsHash);

      const mappingBeforeInterruptedRename = fs.readFileSync(mappingFile, "utf8");
      const rename = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(
        new Error("fixture interruption before atomic mapping rename"),
      );
      try {
        await expect(first.setModel("fixture-native-model-low")).rejects.toThrow(
          "Internal error",
        );
      } finally {
        rename.mockRestore();
      }
      const mappingAfterInterruptedRename = fs.readFileSync(mappingFile, "utf8");
      expect(mappingAfterInterruptedRename).toBe(mappingBeforeInterruptedRename);
      const intact = JSON.parse(mappingAfterInterruptedRename) as Record<
        string,
        { cascadeId?: string; modelId?: string }
      >;
      expect(intact[firstSessionId]).toMatchObject({
        cascadeId: expectedConversation,
        modelId: "fixture-native-model",
      });
      expect(intact[secondSessionId]).toMatchObject({
        cascadeId: expectedConversation,
        modelId: "fixture-native-model-low",
      });
      expect(first.getSessionInfo()?.currentModelId).toBe("fixture-native-model");
      expect(fs.readdirSync(r3Mapping).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(settingsHash()).toBe(initialSettingsHash);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }

    // Simulate an operator changing AGY's global default between processes.
    // Persisted sessions must continue to win, and resume must not rewrite it.
    fs.writeFileSync(
      settingsFile,
      `${JSON.stringify({ model: "Fixture Native Model", retained: "changed-default" }, null, 2)}\n`,
    );
    const changedSettingsHash = settingsHash();
    const resumedFirst = makeRuntime(r3Mapping, {
      defaultModel: "",
      initialSettingsFile: settingsFile,
    });
    const resumedSecond = makeRuntime(r3Mapping, {
      defaultModel: "",
      initialSettingsFile: settingsFile,
    });
    try {
      await Promise.all([resumedFirst.start(), resumedSecond.start()]);
      const [firstInfo, secondInfo] = await Promise.all([
        resumedFirst.loadSession({ sessionId: firstSessionId, cwd: r3Root }),
        resumedSecond.loadSession({ sessionId: secondSessionId, cwd: r3Root }),
      ]);
      expect(firstInfo.currentModelId).toBe("fixture-native-model");
      expect(secondInfo.currentModelId).toBe("fixture-native-model-low");
      await Promise.all([
        resumedFirst.prompt("capability-model-a-resume"),
        resumedSecond.prompt("capability-model-b-resume"),
      ]);
      await Promise.all([resumedFirst.idle(), resumedSecond.idle()]);

      const resumedA = readInvocations().find(
        (entry) => entry.prompt === "capability-model-a-resume",
      );
      const resumedB = readInvocations().find(
        (entry) => entry.prompt === "capability-model-b-resume",
      );
      const resumedAAt = resumedA?.args?.indexOf("--model") ?? -1;
      const resumedBAt = resumedB?.args?.indexOf("--model") ?? -1;
      expect(resumedA?.args?.slice(resumedAAt, resumedAAt + 2)).toEqual([
        "--model",
        "Fixture Native Model",
      ]);
      expect(resumedB?.args?.slice(resumedBAt, resumedBAt + 2)).toEqual([
        "--model",
        "Fixture Native Model (Low)",
      ]);
      expect(settingsHash()).toBe(changedSettingsHash);
    } finally {
      await Promise.all([resumedFirst.dispose(), resumedSecond.dispose()]);
    }

    const staleSessionId = "44444444-4444-4444-8444-444444444444";
    const mappingFile = path.join(r3Mapping, "agy-sessions.json");
    const staleMapping = JSON.parse(fs.readFileSync(mappingFile, "utf8")) as Record<
      string,
      unknown
    >;
    staleMapping[staleSessionId] = {
      cascadeId: expectedConversation,
      maxStepIndex: 5,
      cwd: r3Root,
      modelId: "fixture-model-no-longer-in-catalog",
    };
    fs.writeFileSync(mappingFile, `${JSON.stringify(staleMapping, null, 2)}\n`);
    const mappingBeforeStaleLoad = fs.readFileSync(mappingFile, "utf8");
    const staleRuntime = makeRuntime(r3Mapping, {
      defaultModel: "",
      initialSettingsFile: settingsFile,
    });
    try {
      await staleRuntime.start();
      await expect(staleRuntime.loadSession({
        sessionId: staleSessionId,
        cwd: r3Root,
      })).rejects.toThrow("Invalid params");
      expect(fs.readFileSync(mappingFile, "utf8")).toBe(mappingBeforeStaleLoad);
      expect(settingsHash()).toBe(changedSettingsHash);
    } finally {
      await staleRuntime.dispose();
    }

    fs.writeFileSync(
      settingsFile,
      `${JSON.stringify({ model: "Fixture Native Model (Low)", retained: "legacy-default" }, null, 2)}\n`,
    );
    const legacySettingsHash = settingsHash();
    const legacySessionId = "33333333-3333-4333-8333-333333333333";
    const legacyMapping = JSON.parse(fs.readFileSync(mappingFile, "utf8")) as Record<
      string,
      unknown
    >;
    legacyMapping[legacySessionId] = expectedConversation;
    fs.writeFileSync(mappingFile, `${JSON.stringify(legacyMapping, null, 2)}\n`);
    const legacyRuntime = makeRuntime(r3Mapping, {
      defaultModel: "",
      initialSettingsFile: settingsFile,
    });
    try {
      await legacyRuntime.start();
      const legacyInfo = await legacyRuntime.loadSession({
        sessionId: legacySessionId,
        cwd: r3Root,
      });
      expect(legacyInfo.currentModelId).toBe("fixture-native-model-low");
      const normalized = JSON.parse(fs.readFileSync(mappingFile, "utf8")) as Record<
        string,
        { cascadeId?: string; maxStepIndex?: number; modelId?: string }
      >;
      expect(normalized[legacySessionId]).toEqual({
        cascadeId: expectedConversation,
        maxStepIndex: -1,
        cwd: r3Root,
        modelId: "fixture-native-model-low",
      });
      expect(settingsHash()).toBe(legacySettingsHash);
    } finally {
      await legacyRuntime.dispose();
    }
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
        // #260: AGY has no observed context windows until #346 lands, so the
        // turn is sized by the conservative assumption rather than a real
        // number. The threshold is scaled to it so this still exercises the
        // same wiring — usage in, real predicate, real consumer — instead of
        // silently never compacting.
        AGY_AUTO_COMPACT_THRESHOLD: 0.001,
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
        // Not 4096: that came from a language-server row the removed `-p ok`
        // probe fetched. Prompt-free discovery knows ids, not windows, so the
        // turn is sized by the conservative assumption — under every window
        // AGY ships rather than over one of them.
        contextWindowSize: AGY_ASSUMED_CONTEXT_WINDOW,
      });
    } finally {
      compact.mockRestore();
      await runtime.dispose();
      store.close();
    }
  }, 30_000);

  it("reaps the native prompt child before releasing its test-owned temp state", async () => {
    const runtime = makeRuntime(
      fs.mkdtempSync(path.join(root, "mapping-owned-child-")),
      {
        approvedEnvironment: {
          SEAM_AGY_CAPABILITY_SIGTERM_DELAY_MS: "750",
        },
      },
    );
    let pid: number | undefined;
    try {
      await runtime.start();
      await runtime.newSession({
        cwd: root,
        model: "fixture-native-model",
        strictModel: true,
      });
      await runtime.prompt("capability-turn-one");
      pid = readInvocations()
        .filter((entry) => entry.scenario === "turn-one" && entry.pid !== undefined)
        .at(-1)?.pid;
      expect(pid).toBeTypeOf("number");

      await runtime.dispose();

      expect(processExists(pid!)).toBe(false);
      expect(readInvocations()).toContainEqual({
        scenario: "turn-one",
        signal: "SIGTERM",
      });
    } finally {
      await runtime.dispose();
      if (pid !== undefined && processExists(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
        await vi.waitFor(() => expect(processExists(pid!)).toBe(false));
      }
    }
  }, 20_000);

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
