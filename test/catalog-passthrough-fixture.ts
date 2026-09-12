import { pino } from "pino";
import { catalogScopeFingerprint, type AgentProfile } from "@seam/adapters";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

export const passthroughCases = [
  { name: "cold-default", typed: "default", warm: false, allowed: true },
  { name: "cold-typed", typed: "My-Typed-Model", warm: false, allowed: true },
  { name: "warm-unlisted", typed: "My-Typed-Model", warm: true, allowed: true },
  { name: "retired", typed: "retired", warm: true, allowed: false },
  { name: "unavailable", typed: "unavailable", warm: true, allowed: false },
  { name: "available-alias", typed: "Known-Alias", warm: true, allowed: true },
] as const;

/** Real SQLite-backed catalog, no provider/network calls. Cold means genuinely
 * zero generation rows, not a mock that happens to return null. */
export async function passthroughCatalog(warm: boolean, location = "macbook-pro") {
  const binding = { agentId: "claude", location };
  const store = new ModelCatalogStore(":memory:");
  const models = fixtureModelCatalog([{ id: "claude", defaultModel: "known",
    staticModels: ["known", "retired", "unavailable"].map(modelId => ({ modelId, name: modelId })),
  } as unknown as AgentProfile]).models(binding).map(model => ({ ...model,
    ...(model.id === "known" ? { aliases: ["Known-Alias"] } : {}),
    ...(model.id === "retired" ? { lifecycle: "retired" as const } : {}),
    ...(model.id === "unavailable" ? { availability: "unavailable" as const } : {}),
  }));
  const catalog = new ModelCatalogService({ store, logger: pino({ level: "silent" }) as any,
    bindings: () => [binding], fetch: async () => ({ schemaVersion: 1,
      scope: { fingerprint: catalogScopeFingerprint({ provider: "fixture-366" }), provider: "fixture-366" },
      models, source: "fixture", sourceVersion: "1", adapterVersion: 1,
      fetchedAt: "2026-09-12T12:00:00.000Z",
    }),
  });
  if (warm) await catalog.refresh(binding);
  return { catalog, binding, close: () => store.close(),
    generationRows: () => (store as any).db.prepare("SELECT count(*) AS n FROM model_catalog_generations").get().n as number };
}
