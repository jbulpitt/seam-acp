import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeCatalogCandidate } from "../packages/adapters/src/catalog-evidence.js";
import { readErrorClassification } from "../packages/adapters/src/error-classification.js";
import { makeAgyAcpProfile, AGY_ACP_ARGS } from "../packages/adapters/src/profiles/agy-acp.js";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import { negotiateReauth } from "../packages/core/src/core/reauth-negotiation.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const fixture = fileURLToPath(new URL("./fixtures/agy-acp-server.mjs", import.meta.url));
const dirs: string[] = [];
const logger = { child() { return this; }, debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(newSessionError?: { code: number; message: string; data: Record<string, unknown> }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "seam-agy-acp-test-")); dirs.push(dir);
  const requests = path.join(dir, "requests.jsonl");
  const profile = makeAgyAcpProfile({
    defaultModel: "fixture-deep", cliPath: process.execPath, acpArgs: [fixture], cwd: dir,
    environment: { ...process.env, AGY_ACP_TEST_REQUESTS: requests,
      ...(newSessionError ? { AGY_ACP_TEST_NEW_ERROR: JSON.stringify(newSessionError) } : {}) },
  });
  return { dir, requests, profile };
}

describe("native AGY ACP integration", () => {
  it("defaults to process-per-session arguments and a separate catalog backend", () => {
    expect(AGY_ACP_ARGS).toEqual(["acp", "--process-per-session"]);
    expect(makeAgyAcpProfile({ defaultModel: "configured-model" }).catalog.scope().backend).toBe("agy-acp-stdio-v1");
  });

  it.each([
    { code: -32000, message: "Authentication required", data: { fixture: "auth" }, kind: "auth_required", action: "park" },
    { code: -32603, message: "Fixture upstream unavailable", data: { status: 503, fixture: "server" }, kind: "overloaded", action: "inconclusive" },
    { code: -32603, message: "The Antigravity process serving this session exited unexpectedly", data: { fixture: "worker" }, kind: "unclassified", action: "inconclusive" },
  ])("routes $kind from a bare ACP error through core without losing its cause", async ({ kind, action, ...wireError }) => {
    const { profile, dir } = await setup(wireError);
    const runtime = new AgentRuntime({ profile, logger, spawnFn: () => profile.spawn() });
    try {
      await runtime.start();
      const error = await runtime.newSession({ cwd: dir }).then(
        () => { throw new Error("Fixture should reject session/new"); },
        error => error,
      );
      expect(error).toMatchObject({ code: wireError.code, message: wireError.message, data: wireError.data });
      expect(readErrorClassification(error)).toMatchObject({ agentId: "agy", errorKind: kind });
      expect(negotiateReauth({ ...readErrorClassification(error), message: error.message }).action).toBe(action);
    } finally { await runtime.dispose(); }
  });

  it("retains an existing classification and the original error object and cause", () => {
    const profile = makeAgyAcpProfile({ defaultModel: "fixture-flash" });
    const cause = new Error("Fixture cause");
    const error = Object.assign(new Error("Authentication required", { cause }), {
      data: { agentId: "agy", errorKind: "rate_limit", fixture: "preserved" },
    });
    expect(profile.classifyError!(error)).toMatchObject({ agentId: "agy", errorKind: "rate_limit" });
    expect(error.cause).toBe(cause);
    expect(error.data).toMatchObject({ agentId: "agy", errorKind: "rate_limit", fixture: "preserved" });
  });

  it("discovers model-specific effort over real ACP, retaining unknown context instead of token estimates", async () => {
    const { profile, requests } = await setup();
    const catalog = normalizeCatalogCandidate(await profile.catalog.fetch());
    expect(catalog.models.map(row => [row.id, row.default, row.effort.choices.map(c => c.id)])).toEqual([
      ["fixture-flash", false, ["low", "medium", "high"]],
      ["fixture-deep", true, ["high", "extra", "max"]],
      ["fixture-fixed", false, ["default"]],
    ]);
    expect(catalog.models.every(row => row.context.effective === null && row.visionMode === "native")).toBe(true);
    expect(catalog.models.every(row => row.applicationMode === "live")).toBe(true);
    const calls = (await readFile(requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls[0].params.clientInfo.name).toBe("seam-acp");
    expect(calls.filter(row => row.method === "session/new")).toHaveLength(3);
    expect(calls.filter(row => row.method === "session/close")).toHaveLength(3);
    expect(calls.some(row => row.method === "session/prompt")).toBe(false);
  });

  it("uses existing core load/reapply and forwards exact thought/context events independently of token totals", async () => {
    const { profile, requests, dir } = await setup();
    const catalog = await profile.catalog.fetch();
    const effort = catalog.models.find(row => row.id === "fixture-deep")!.effort;
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({ profile, logger, effortDescriptor: effort, spawnFn: () => profile.spawn() });
    runtime.onEvent(event => { events.push(event); });
    try {
      await runtime.start();
      await runtime.loadSession({ cwd: dir, sessionId: "own-fixture-session", model: "fixture-deep", effort: "max", strictModel: true });
      expect(runtime.getConfigCurrentValue("model")).toBe("fixture-deep");
      expect(runtime.getConfigCurrentValue("thought_level")).toBe("max");
      expect((await runtime.prompt("fixture turn")).stopReason).toBe("end_turn");
      expect(events.filter(event => event.kind === "agent-thought")).toEqual([
        expect.objectContaining({ kind: "agent-thought", text: "Fixture reasoning α" }),
      ]);
      expect(events.filter(event => event.kind === "usage-update")).toEqual([
        { kind: "usage-update", used: 1234, size: 32768 },
      ]);
      await expect(runtime.setModel("not-advertised", { allowFallback: false })).rejects.toThrow("Unknown fixture model");
      await runtime.request("session/close", { sessionId: "own-fixture-session" });
    } finally { await runtime.dispose(); }
    const calls = (await readFile(requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const loaded = calls.findIndex(row => row.method === "session/load");
    expect(calls.slice(loaded + 1, loaded + 3).map(row => row.params)).toEqual([
      { sessionId: "own-fixture-session", configId: "model", value: "fixture-deep" },
      { sessionId: "own-fixture-session", configId: "thought_level", value: "max" },
    ]);
  });
});
