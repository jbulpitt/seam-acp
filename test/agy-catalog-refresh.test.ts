import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import {
  invokeAdapterRpc, makeAgyProfile, makeAgyUnpinnedRuntime,
  type AdapterCatalogCandidate, type AgentAdapter,
} from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { createOrdinaryAgyFixture } from "./helpers/agy-runtime-fixture.js";

const source = fileURLToPath(new URL("./fixtures/fake-agy-catalog-refresh.mjs", import.meta.url));
const logger = pino({ level: "silent" }) as unknown as Logger;
const baseRows = [["model-a", "Model A"], ["model-b", "Model B"]];
const updatedRows = [...baseRows, ["model-neon", "Model Neon"]];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-refresh-"));
  const state = path.join(root, "catalog.json");
  const log = path.join(root, "invocations.ndjson");
  const write = (rows = baseRows, fail = false) => fs.writeFileSync(state, JSON.stringify({ rows, fail }));
  write();
  const ordinary = createOrdinaryAgyFixture({
    source, cwd: root, credentialScope: "antigravity-oauth:refresh",
    environment: { FAKE_AGY_CATALOG_STATE: state, FAKE_AGY_CATALOG_LOG: log },
  });
  const profileFor = (runtime = ordinary.runtime) => makeAgyProfile({
    runtime, dataDir: root, defaultModel: "model-a",
    initialSettingsFile: path.join(root, "settings.json"), exposeGlobalStaging: false,
  });
  const profile = profileFor();
  const store = new ModelCatalogStore(path.join(root, "catalog.db"));
  const binding = { agentId: "agy", location: "fixture-host" };
  const rpc = async (adapter: AgentAdapter) => JSON.parse(JSON.stringify(await invokeAdapterRpc(
    "fetchModelCatalog", {}, { adapter, workspaceRoot: root },
  ))) as AdapterCatalogCandidate;
  const catalog = new ModelCatalogService({
    store, logger, bindings: () => [binding], scope: () => profile.catalog.scope(),
    fetch: () => rpc(profile),
  });
  return {
    root, ordinary, profile, profileFor, store, binding, catalog, write, rpc,
    calls: () => fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]),
    close() { store.close(); ordinary.cleanup(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

describe.sequential("AGY catalog refresh on a retained bridge", () => {
  it.each(["scheduled", "manual"] as const)("publishes newly advertised ids on %s refresh with the same runtime", async reason => {
    const f = fixture();
    try {
      const identity = f.ordinary.runtime.identityKey;
      const scope = f.profile.catalog.scope();
      expect(await f.catalog.refresh(f.binding, "startup")).toMatchObject({ result: "published", generation: 1 });
      expect(f.catalog.models(f.binding).map(row => row.id)).toEqual(["model-a", "model-b"]);
      f.write(updatedRows);

      expect(await f.catalog.refresh(f.binding, reason)).toMatchObject({ result: "published", generation: 2, added: 1 });
      expect(f.catalog.models(f.binding).map(row => row.id)).toEqual(["model-a", "model-b", "model-neon"]);
      expect(f.catalog.models(f.binding).filter(row => row.default).map(row => row.id)).toEqual(["model-a"]);
      expect(f.profile.catalog.scope()).toEqual(scope);
      expect(f.ordinary.runtime.identityKey).toBe(identity);
      expect(f.calls()).toEqual([["models"], ["models"]]);
    } finally { f.close(); }
  });

  it.each(["error", "empty"] as const)("retains published and warm session rows after an %s refresh, then discovers again", async failure => {
    const f = fixture();
    const runtime = new AgentRuntime({ logger, profile: f.profile, spawnFn: f.profile.spawn.bind(f.profile) });
    try {
      await f.catalog.refresh(f.binding);
      const prior = f.catalog.lookup(f.binding).snapshot;
      f.write([], failure === "error");
      const failed = await f.catalog.refresh(f.binding);
      expect(failed).toMatchObject({ result: "retained", generation: 1, ok: false });
      if (failure === "error") expect(failed.error).toContain("synthetic models failure");
      expect(f.catalog.lookup(f.binding).snapshot).toEqual(prior);
      expect(f.calls()).toEqual([["models"], ["models"]]);

      await runtime.start();
      const session = await runtime.newSession({ cwd: f.root, model: "model-a", strictModel: true });
      await runtime.loadSession({ cwd: f.root, sessionId: session.sessionId });
      expect(f.calls()).toEqual([["models"], ["models"]]);

      f.write(updatedRows);
      expect(await f.catalog.refresh(f.binding)).toMatchObject({ result: "published", generation: 2, added: 1 });
      expect(f.calls()).toEqual([["models"], ["models"], ["models"]]);
    } finally { await runtime.dispose(); f.close(); }
  });

  it("coalesces concurrent discoveries for one runtime, with credential scopes kept separate", async () => {
    const f = fixture();
    try {
      const alias = f.profileFor();
      const initial = await Promise.all([f.rpc(f.profile), f.rpc(alias)]);
      expect(initial.map(candidate => candidate.models.map(row => row.id))).toEqual([
        ["model-a", "model-b"], ["model-a", "model-b"],
      ]);
      expect(f.calls()).toHaveLength(1);
      f.write(updatedRows);
      const refreshed = await Promise.all([f.rpc(f.profile), f.rpc(alias)]);
      expect(refreshed.map(candidate => candidate.models.map(row => row.id))).toEqual([
        ["model-a", "model-b", "model-neon"], ["model-a", "model-b", "model-neon"],
      ]);
      expect(f.calls()).toHaveLength(2);

      const peerRuntime = makeAgyUnpinnedRuntime({
        credentialScope: "antigravity-oauth:peer", cwd: f.root,
        baseEnv: { ...process.env, PATH: `${path.dirname(f.ordinary.executable)}${path.delimiter}${process.env.PATH}` },
      });
      expect(peerRuntime.identityKey).not.toBe(f.ordinary.runtime.identityKey);
      const peer = f.profileFor(peerRuntime);
      f.write(baseRows);
      const peerCandidate = await f.rpc(peer);
      expect(peerCandidate.scope.fingerprint).not.toBe(initial[0]!.scope.fingerprint);
      expect(peerCandidate.models.map(row => row.id)).toEqual(["model-a", "model-b"]);
      expect(f.calls()).toHaveLength(3);
    } finally { f.close(); }
  });
});
