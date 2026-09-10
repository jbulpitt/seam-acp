import type { AgentProfile, CatalogEffort, CatalogModel } from "@seam/adapters";
import type { CatalogBinding, ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";

/** Small cache-only catalog fake for integration tests that do not open SQLite. */
export function fixtureModelCatalog(profiles: ReadonlyArray<AgentProfile>): ModelCatalogService {
  const byAgent = new Map(profiles.map((profile) => [profile.id, profile]));
  const rows = (binding: CatalogBinding): CatalogModel[] => {
    const profile = byAgent.get(binding.agentId) as (AgentProfile & {
      staticModels?: ReadonlyArray<{ modelId: string; name: string; contextLimit?: number }>;
    }) | undefined;
    if (!profile) return [];
    const declared = profile.staticModels?.length
      ? profile.staticModels
      : [{ modelId: profile.defaultModel ?? "default", name: profile.defaultModel ?? "default" }];
    return declared.map((entry) => {
      const levels = profile.effort?.levels ?? [];
      const mechanism = profile.effort?.mechanism ?? "none";
      const choices = levels.length ? [...levels] : ["default"];
      const selectionDefault = "default";
      if (!choices.includes(selectionDefault)) choices.unshift(selectionDefault);
      const effort: CatalogEffort = {
        mechanism,
        ...(profile.effort?.configId ? { configId: profile.effort.configId } : {}),
        choices: choices.map((id) => ({ id, ...(id === "default" ? {} : { raw: id }) })),
        selectionDefault,
      };
      return {
        id: entry.modelId,
        runtimeId: entry.modelId,
        displayName: entry.name,
        aliases: [],
        default: entry.modelId === profile.defaultModel,
        context: {
          native: entry.contextLimit ?? null,
          maximum: entry.contextLimit ?? null,
          effective: entry.contextLimit ?? null,
        },
        modalities: { input: ["text"], output: ["text"] },
        visionMode: "none",
        availability: "available",
        lifecycle: "stable",
        serviceTiers: [],
        effort,
        pricingCategory: null,
        compatibility: null,
        applicationMode: profile.id === "codex" || profile.id === "ollama-cloud"
          ? "freshSession"
          : mechanism === "meta" || mechanism === "spawnArgs"
            ? "reload"
            : "live",
        bindings: choices.map((choice) => ({
          model: entry.modelId,
          effort: choice,
          rawModel: entry.modelId,
          ...(choice === "default" ? {} : { rawEffort: choice }),
        })),
      };
    });
  };
  const model = (binding: CatalogBinding, id: string) => {
    const all = rows(binding);
    const exact = id === "default"
      ? all.find((entry) => entry.default) ?? null
      : all.find((entry) => entry.id === id || entry.aliases.includes(id)) ?? null;
    if (exact) return exact;
    const profile = byAgent.get(binding.agentId) as (AgentProfile & { staticModels?: unknown[] }) | undefined;
    if (!profile || profile.staticModels?.length) return null;
    const seed = all[0];
    if (!seed) return null;
    return {
      ...seed,
      id,
      runtimeId: id,
      displayName: id,
      default: id === (profile.defaultModel ?? "default"),
      bindings: seed.bindings.map((entry) => ({ ...entry, model: id, rawModel: id })),
    };
  };
  return {
    models: rows,
    model,
    effortChoices: (binding: CatalogBinding, id: string) => model(binding, id)?.effort.choices.map((choice) => choice.id) ?? [],
    lookup: (binding: CatalogBinding) => {
      const all = rows(binding);
      return {
        state: all.length ? "ready" : "warming",
        snapshot: all.length ? {
          scopeKey: `fixture:${binding.agentId}@${binding.location}`,
          generation: 1,
          checksum: "fixture",
          publishedAt: "2026-09-01T00:00:00.000Z",
          candidate: {
            schemaVersion: 1,
            scope: { fingerprint: "f".repeat(64), provider: binding.agentId },
            models: all,
            source: "test-fixture",
            adapterVersion: 1,
            fetchedAt: "2026-09-01T00:00:00.000Z",
          },
        } : null,
        observation: null,
      };
    },
    resolve: (binding: CatalogBinding, selection: { model: string; effort?: string }) => {
      const found = model(binding, selection.model);
      if (!found) throw new Error(`fixture model unavailable: ${selection.model}`);
      const effort = selection.effort ?? found.effort.selectionDefault;
      const raw = found.bindings.find((entry) => entry.effort === effort);
      if (!raw) throw new Error(`fixture effort unavailable: ${effort}`);
      return {
        normalized: { model: found.id, effort },
        raw: { model: raw.rawModel, ...(raw.rawEffort ? { effort: raw.rawEffort } : {}) },
        model: found,
        generation: 1,
      };
    },
  } as unknown as ModelCatalogService;
}
