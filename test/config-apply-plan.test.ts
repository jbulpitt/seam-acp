import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import type { Config } from "../packages/core/src/config.js";
import { createConfigFacades } from "../packages/core/src/core/config-apply-plan.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const logger = pino({ level: "silent" }) as Logger;
const actor = { id: "operator", name: "Operator" };
const profiles = ["claude", "codex", "ollama-cloud"].map(id => ({
  id, defaultModel: "old", staticModels: ["old", "new"].map(modelId => ({ modelId, name: modelId })),
  effort: { mechanism: "meta", levels: ["low", "high"] },
})) as unknown as AgentProfile[];
let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-apply-plan-"));
  store = new SessionStore(path.join(dir, "seam.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(agentId = "claude") {
  const modelCatalog = fixtureModelCatalog(profiles);
  const router = new SessionRouter({
    store, logger, profiles, modelCatalog, defaultAgentId: agentId,
    defaultModel: "old", defaultPermissionMode: "ask",
  });
  const record = router.ensureSessionRecord({ platform: "discord", channelRef: "thread", parentRef: "channel", cwd: dir });
  store.upsert({ ...record, acpSessionId: "existing-context", configJson: JSON.stringify({ model: "old", reasoningEffort: "low" }) }, { source: "fixture", cause: "set provider binding for test" });
  const mutation = new ConfigMutationService({
    store, logger, modelCatalog, describeConfig: record => router.describeConfig(record),
    isAgentAvailable: id => Boolean(router.getProfile(id)), ollamaCloudEnabled: true,
  });
  const { plan } = createConfigFacades({
    store, router, mutation, modelCatalog, logger,
    config: { REPOS_ROOT: dir, channelPresets: new Map(), threadPresets: new Map() } as Config,
    identityCommitted: async () => {}, persistConfig: () => {}, repoDisplay: repo => repo ?? "",
    unregisteredAgentMessage: (_id, fallback) => fallback, parkedSelectMessage: () => null,
  });
  return { plan, record: store.get(record.id)! };
}

describe("configuration apply boundary", () => {
  it("prepares without writes, then preserves the confirming actor and correlation in the real audit row", () => {
    const { plan, record } = fixture();
    const before = store.get(record.id);
    const built = plan.prepare(record, { session: { permission: "always" } }, actor);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.error);
    expect(built.plan.target).toEqual({ kind: "session", id: "thread" });
    expect(built.plan.diff).toEqual(built.plan.proposal.fields);
    expect(built.plan.consequence).toBe("live-apply");
    expect(store.get(record.id)).toEqual(before);
    expect(store.listConfigMutations()).toHaveLength(0);
    const applied = plan.apply(built.plan);
    expect(applied.ok).toBe(true);
    expect(store.readConfig(store.get(record.id)!).permissionPolicy).toBe("always");
    expect(store.get(record.id)!.acpSessionId).toBe("existing-context");
    expect(store.listConfigMutations()).toEqual([expect.objectContaining({
      id: applied.auditId, actorId: actor.id, actorName: actor.name,
      scope: "thread", correlationId: built.plan.audit.correlationId, tier: "session",
    })]);
  });

  it.each(["claude", "codex", "ollama-cloud"])("describes %s model and effort consequences without replacing context", agent => {
    const { plan, record } = fixture(agent);
    const model = plan.prepare(record, { session: { model: "new" } }, actor);
    const effort = plan.prepare(record, { session: { effort: "high" } }, actor);
    expect(model.ok && model.plan.consequence).toBe(agent === "claude" ? "live-apply" : "reset");
    expect(effort.ok && effort.plan.consequence).toBe("live-apply");
    expect(store.get(record.id)!.acpSessionId).toBe("existing-context");
    expect(store.listConfigMutations()).toHaveLength(0);
  });

  it("describes agent replacement, naming-only writes, and requested reconstruction", () => {
    const { plan, record } = fixture();
    const agent = plan.prepare(record, { session: { agent: "codex" } }, actor);
    const role = plan.prepare(record, { session: { role: "worker" } }, actor);
    const rebuild = plan.prepare(record, { session: { role: "worker" } }, actor, { rebuild: true });
    expect(agent.ok && agent.plan.consequence).toBe("reset");
    expect(role.ok && role.plan.consequence).toBe("none");
    expect(rebuild.ok && rebuild.plan.consequence).toBe("rebuild");
    expect(store.listConfigMutations()).toHaveLength(0);
  });
});
