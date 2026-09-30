import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { catalogScopeFingerprint, type AgentProfile, type AdapterCatalogCandidate } from "@seam/adapters";
import { ModelHideList, modelPatternMatches } from "../packages/core/src/core/model-catalog/hide-list.js";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import { visibleModelRankings, visibleModelValueRows } from "../packages/core/src/core/model-catalog/listings.js";
import { renderModelValueRankingsLayout } from "../packages/core/src/core/model-value/rankings-card.js";
import { ModelValueStore } from "../packages/core/src/core/model-value/store.js";
import { buildModelValueSnapshot } from "../packages/core/src/core/model-value/ranking.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { AutocompleteRegistry } from "../packages/core/src/platforms/discord/autocomplete.js";
import { buildSlashRegistrationBody } from "../packages/core/src/platforms/discord/commands.js";
import { SyntheticInteraction, validateSlashSpec } from "../packages/core/src/platforms/discord/synthetic-interaction.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = pino({ level: "silent" }) as unknown as Logger;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const starting = ["claude-opus-4*", "claude-fable-5", "gpt-5.*", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"];

function hideList() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-model-hide-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ModelHideList(path.join(dir, "model-hide.json"), logger);
}

async function catalog(ids: string[], list = hideList()) {
  const binding = { agentId: "copilot", location: "local" };
  const fixture = fixtureModelCatalog([{ id: binding.agentId, defaultModel: ids[0],
    staticModels: ids.map((modelId) => ({ modelId, name: modelId })),
  } as unknown as AgentProfile]);
  const candidate: AdapterCatalogCandidate = {
    schemaVersion: 1, scope: { fingerprint: catalogScopeFingerprint({ provider: "test" }), provider: "test" },
    models: [...fixture.models(binding)], source: "test", adapterVersion: 1, fetchedAt: new Date().toISOString(),
  };
  const store = new ModelCatalogStore(path.join(path.dirname(list.file), "seam.db"));
  cleanups.push(() => store.close());
  const service = new ModelCatalogService({ store, hideList: list, logger, bindings: () => [binding], fetch: async () => candidate });
  expect((await service.refresh(binding)).ok).toBe(true);
  return { service, binding, list };
}

describe("model hiding", () => {
  it.each([
    ["claude-opus-4*", "claude", "mac", "claude-opus-4-8", true],
    ["claude-opus-4*", "copilot", "local", "claude-opus-4.8-fast", true],
    ["claude-fable-5", "claude", "local", "claude-fable-5.1", false],
    ["gpt-5.*", "codex", "remote", "gpt-5.6-sol", true],
    ["gpt-5.*", "codex", "remote", "gpt-5-mini", false],
    ["copilot:gpt-*", "copilot", "mac", "gpt-6.1-sol", true],
    ["copilot:gpt-*", "codex", "mac", "gpt-6.1-sol", false],
    ["codex@mac:gpt-5.*", "codex", "mac", "gpt-5.6-sol", true],
    ["codex@mac:gpt-5.*", "codex", "local", "gpt-5.6-sol", false],
    ["gpt-5.*", "codex", "mac", "gpt-5X6-sol", false],
    ["*6.1*", "codex", "mac", "gpt-6.1-sol", true],
    ["gpt-5.[x]", "codex", "mac", "gpt-5.x", false],
  ])("matches %s literally for %s@%s / %s", (pattern, agentId, location, model, expected) => {
    expect(modelPatternMatches(pattern, { agentId, location }, model)).toBe(expected);
  });

  it("reloads file replacements and retains the last valid list after a bad edit", () => {
    const list = hideList();
    expect(list.list()).toEqual([]);
    fs.writeFileSync(list.file, JSON.stringify(starting));
    expect(list.list()).toEqual(starting);
    fs.writeFileSync(`${list.file}.edit`, '["codex:gpt-5.*"]');
    fs.renameSync(`${list.file}.edit`, list.file);
    expect(list.list()).toEqual(["codex:gpt-5.*"]);
    fs.writeFileSync(list.file, "invalid JSON");
    expect(list.list()).toEqual(["codex:gpt-5.*"]);
  });

  it("keeps exact selection, defaults, decode and current visibility while removing other hidden choices", async () => {
    const { service, binding, list } = await catalog(["gpt-5.6-sol", "gpt-5.5", "gpt-6.1-sol"]);
    list.change("hide", "gpt-5.*");
    expect(service.models(binding).map((model) => model.id)).toEqual(["gpt-6.1-sol"]);
    expect(service.models(binding, { current: "gpt-5.6-sol" }).map((model) => model.displayName)).toEqual(["gpt-5.6-sol (hidden)", "gpt-6.1-sol"]);
    expect(service.resolve(binding, { model: "gpt-5.6-sol" }).raw.model).toBe("gpt-5.6-sol");
    expect(service.resolve(binding, { model: "default" }).raw.model).toBe("gpt-5.6-sol");
    expect(service.decode(binding, { model: "gpt-5.6-sol" })?.model).toBe("gpt-5.6-sol");
    list.change("unhide", "gpt-5.*");
    expect(service.models(binding)).toHaveLength(3);
  });

  it("puts the new models within empty-query autocomplete and marks a pinned hidden choice", async () => {
    const ids = [...Array.from({ length: 14 }, (_, i) => `gpt-5.${i}`), ...Array.from({ length: 16 }, (_, i) => `visible-${i}`), "gpt-6.1-sol", "claude-sonnet-5.5"];
    const { service, list } = await catalog(ids);
    for (const pattern of starting) list.change("hide", pattern);
    const autocomplete = new AutocompleteRegistry();
    const self = Object.create(Orchestrator.prototype);
    Object.assign(self, { modelCatalog: service, autocomplete, config: {}, store: { get: () => null } });
    self.wireSlashAutocomplete();
    const responder = autocomplete.get("config", "set", "model")!;
    const choices = await responder({ group: "config", subcommand: "set", optionName: "model", focusedValue: "", channelId: "123", agentId: "copilot", optionValues: { agent: "copilot" } });
    expect(choices).toHaveLength(18);
    expect(choices.map((choice) => choice.value)).toContain("gpt-6.1-sol");
    expect(choices.map((choice) => choice.value)).toContain("claude-sonnet-5.5");
    expect(choices.some((choice) => String(choice.value).startsWith("gpt-5."))).toBe(false);
  });

  it("filters stored rankings by binding, retaining a hidden current model with its marker", async () => {
    const { service, list, binding } = await catalog(["gpt-5.6-sol", "gpt-6.1-sol"]);
    const store = new ModelValueStore(path.join(path.dirname(list.file), "seam.db"), { inputTokens: 1, outputTokens: 1 });
    cleanups.push(() => store.close());
    const rows = buildModelValueSnapshot({ copilotModels: ["gpt-5.6-sol", "gpt-6.1-sol"].map((modelId) => ({ modelId, displayName: modelId, validEffortTiers: [], priceCategory: null })), aaModels: [], pricing: [], inputTokens: 1, outputTokens: 1, fetchedAt: new Date().toISOString() }).rows;
    store.saveSnapshot(rows);
    list.change("hide", "gpt-5.*");
    expect(visibleModelRankings(service, store.getRankings()).rankings.map((row) => row.model)).toEqual(["gpt-6.1-sol"]);
    const layout = renderModelValueRankingsLayout(visibleModelValueRows(service, store.getLatestRows()));
    const cardText = JSON.stringify(layout);
    expect(cardText).toContain("gpt-6.1-sol");
    expect(cardText).not.toContain("gpt-5.6-sol");
    expect(visibleModelRankings(service, store.getRankings(), { ...binding, model: "gpt-5.6-sol" }).rankings.find((row) => row.model === "gpt-5.6-sol")?.display_name).toBe("gpt-5.6-sol (hidden)");
    const scoped = { ...store.getRankings(), rankings: store.getRankings().rankings.map((row) => ({ ...row, bindings: ["mac", "local"].map((location) => ({ agent: "copilot", location, scope: "test", generation: 1, state: "ready" as const })) })) };
    list.change("unhide", "gpt-5.*");
    list.change("hide", "copilot@mac:gpt-5.*");
    expect(visibleModelRankings(service, scoped).rankings.find((row) => row.model === "gpt-5.6-sol")?.bindings?.map((row) => row.location)).toEqual(["local"]);
  });

  it("proposes without writing, then applies and audits the exact hide-list change", () => {
    const list = hideList();
    const store = new SessionStore(path.join(path.dirname(list.file), "seam.db"));
    cleanups.push(() => store.close());
    const mutation = new ConfigMutationService({ store, modelCatalog: {} as ModelCatalogService, modelHideList: list, describeConfig: () => { throw new Error("unused"); }, presetsFile: undefined, tierCEnabled: false, reloadPresets: () => ({ ok: true }), reschedule: () => {}, defaultTimezone: "UTC", logger });
    const built = mutation.buildModelHideProposal({ action: "hide", pattern: "gpt-5.*" });
    expect(list.list()).toEqual([]);
    if (!built.ok) throw new Error(built.error);
    built.proposal.apply({ id: "admin", name: "Admin" });
    expect(list.list()).toEqual(["gpt-5.*"]);
    expect(store.listConfigMutations(1)[0]).toMatchObject({ tier: "model-hide", actorId: "admin", beforeJson: "[]", afterJson: '["gpt-5.*"]' });
  });

  it("injects a real autocomplete-shaped interaction and records returned choices", async () => {
    const spec = { kind: "autocomplete" as const, channelId: "123", command: "seam", subcommandGroup: "config", subcommand: "set", focused: "model", options: { model: "" } };
    const types = validateSlashSpec(spec, buildSlashRegistrationBody());
    const interaction = new SyntheticInteraction(spec, { client: {} as never, channel: { id: "123" } as never, user: {} as never, member: null }, types);
    expect(interaction.isAutocomplete()).toBe(true);
    expect(interaction.options?.getFocused(true)).toMatchObject({ name: "model", value: "" });
    await interaction.respond([{ name: "gpt-6.1-sol", value: "gpt-6.1-sol" }]);
    expect(interaction.transcript[0].choices).toEqual([{ name: "gpt-6.1-sol", value: "gpt-6.1-sol" }]);
    await expect(interaction.respond([])).rejects.toMatchObject({ code: 40060 });
  });
});
