import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeCatalogCandidate } from "../packages/adapters/src/catalog-evidence.js";
import { makeAgyAcpProfile, AGY_ACP_ARGS } from "../packages/adapters/src/profiles/agy-acp.js";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const fixture = fileURLToPath(new URL("./fixtures/agy-acp-server.mjs", import.meta.url));
const dirs: string[] = [];
const logger = { child() { return this; }, debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "seam-agy-acp-test-")); dirs.push(dir);
  const requests = path.join(dir, "requests.jsonl");
  const profile = makeAgyAcpProfile({
    defaultModel: "fixture-deep", cliPath: process.execPath, acpArgs: [fixture], cwd: dir,
    environment: { ...process.env, AGY_ACP_TEST_REQUESTS: requests },
  });
  return { dir, requests, profile };
}

describe("native AGY ACP integration", () => {
  it("uses the documented HTTP-MCP-capable launch without changing the active AGY factory", () => {
    expect(AGY_ACP_ARGS).toEqual(["acp", "--process-per-session"]);
    expect(makeAgyAcpProfile({ defaultModel: "configured-model" }).catalog.scope().backend).toBe("agy-acp-stdio-v1");
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
