/**
 * #236 — declared-VALUE policy and metadata provenance.
 *
 * Exact-key closure only says which keys may exist. These cover what their
 * VALUES may be, at both boundaries, and the metadata path that carries
 * per-model provenance onward. Everything is expressed against an alien fake
 * provider so no assertion can depend on a real provider's vocabulary.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogScopeFingerprint,
  invokeAdapterRpc,
  normalizeCatalogCandidate,
  type AdapterCatalogCandidate,
  type CatalogModel,
  type CatalogModelEvidence,
} from "@seam/adapters";
import { ModelCatalogService, validateCandidate } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = pino({ level: "silent" }) as unknown as Logger;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function db(): { file: string; store: ModelCatalogStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-236-values-"));
  dirs.push(dir);
  const file = path.join(dir, "seam.db");
  return { file, store: new ModelCatalogStore(file) };
}

const SCOPE = {
  fingerprint: catalogScopeFingerprint({ provider: "architectural-outlier", credentialProfile: "fixture" }),
  provider: "architectural-outlier",
  credentialProfile: "fixture",
};

function model(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  const choices = [{ id: "default" }, { id: "deliberate", raw: "THINK::9000" }];
  return {
    id,
    runtimeId: `vendor::${id}@2026`,
    displayName: `Odd ${id}`,
    aliases: [],
    default: false,
    context: { native: 777_777, maximum: 888_888, effective: 700_000 },
    modalities: { input: ["text"], output: ["text"] },
    visionMode: "none",
    availability: "available",
    lifecycle: "stable",
    serviceTiers: [],
    effort: {
      mechanism: "configOption",
      configId: "cognition.mode/v9",
      choices,
      selectionDefault: "default",
    },
    pricingCategory: null,
    compatibility: null,
    applicationMode: "live",
    bindings: choices.map((choice) => ({
      model: id,
      effort: choice.id,
      rawModel: `vendor::${id}@2026`,
      ...(choice.raw ? { rawEffort: choice.raw } : {}),
    })),
    ...over,
  };
}

function candidate(models: CatalogModel[]): AdapterCatalogCandidate {
  return {
    schemaVersion: 1,
    scope: { ...SCOPE },
    models,
    source: "fake-adapter-probe",
    adapterVersion: 1,
    fetchedAt: "2026-09-09T00:00:00.000Z",
  };
}

const evidence = (over: Partial<CatalogModelEvidence> = {}): CatalogModelEvidence => ({
  kind: "live-observation",
  source: "fake-adapter-probe",
  observedAt: "2026-09-09T00:00:00.000Z",
  runtimeVersion: "outlier-cli 9.9",
  adapterVersion: 1,
  scopeRef: SCOPE.fingerprint,
  ...over,
});

const BELL = String.fromCharCode(7);

describe("#236 declared-VALUE policy at both boundaries", () => {
  const mutate = (fn: (c: AdapterCatalogCandidate) => void): AdapterCatalogCandidate => {
    const built = JSON.parse(
      JSON.stringify(candidate([model("nebula", { default: true })]))
    ) as AdapterCatalogCandidate;
    fn(built);
    return built;
  };

  /** The exact independently reproduced attacks, plus one per declared family. */
  const ATTACKS: Array<[string, (c: AdapterCatalogCandidate) => void]> = [
    ["source credential", (c) => { c.source = "API_KEY=x1234"; }],
    ["object sourceVersion", (c) => {
      (c as unknown as Record<string, unknown>).sourceVersion = { payload: "QA_SECRET=x1234" };
    }],
    ["object effort.configId", (c) => {
      (c.models[0]!.effort as unknown as Record<string, unknown>).configId = { payload: "QA_SECRET=x1234" };
    }],
    ["fractional context", (c) => { c.models[0]!.context.native = 1.5; }],
    ["5,000 aliases", (c) => {
      c.models[0]!.aliases = Array.from({ length: 5_000 }, (_, i) => `alias-${i}`);
    }],
    ["NaN context", (c) => { c.models[0]!.context.effective = Number.NaN; }],
    ["infinite context", (c) => { c.models[0]!.context.maximum = Number.POSITIVE_INFINITY; }],
    ["negative context", (c) => { c.models[0]!.context.native = -1; }],
    ["absurd context", (c) => { c.models[0]!.context.maximum = 5_000_000_000; }],
    ["array cliVersion", (c) => {
      (c as unknown as Record<string, unknown>).cliVersion = ["x"];
    }],
    ["array displayName", (c) => {
      (c.models[0] as unknown as Record<string, unknown>).displayName = ["x"];
    }],
    ["path in displayName", (c) => { c.models[0]!.displayName = "see /home/ubuntu/.claude"; }],
    ["path in runtimeId", (c) => { c.models[0]!.runtimeId = "/home/ubuntu/.codex/model"; }],
    ["control characters in id", (c) => { c.models[0]!.id = `neb${BELL}ula`; }],
    ["duplicate aliases", (c) => { c.models[0]!.aliases = ["dup", "dup"]; }],
    ["bad enum visionMode", (c) => {
      (c.models[0] as unknown as Record<string, unknown>).visionMode = "telepathy";
    }],
    ["bad enum lifecycle", (c) => {
      (c.models[0] as unknown as Record<string, unknown>).lifecycle = "immortal";
    }],
    ["empty modalities", (c) => { c.models[0]!.modalities.input = []; }],
    ["excessive modalities", (c) => {
      c.models[0]!.modalities.output = Array.from({ length: 40 }, (_, i) => `m${i}`);
    }],
    ["excessive service tiers", (c) => {
      c.models[0]!.serviceTiers = Array.from({ length: 40 }, (_, i) => `t${i}`);
    }],
    ["excessive effort choices", (c) => {
      c.models[0]!.effort.choices = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}` }));
    }],
    ["duplicate effort choice ids", (c) => {
      c.models[0]!.effort.choices = [{ id: "same" }, { id: "same" }];
      c.models[0]!.effort.selectionDefault = "same";
    }],
    ["effort default not a choice", (c) => { c.models[0]!.effort.selectionDefault = "nope"; }],
    ["configOption without configId", (c) => {
      delete (c.models[0]!.effort as unknown as Record<string, unknown>).configId;
    }],
    ["object binding rawModel", (c) => {
      (c.models[0]!.bindings[0] as unknown as Record<string, unknown>).rawModel = { a: 1 };
    }],
    ["non-boolean default", (c) => {
      (c.models[0] as unknown as Record<string, unknown>).default = "yes";
    }],
    ["array scope", (c) => {
      (c as unknown as Record<string, unknown>).scope = ["not", "an", "object"];
    }],
    ["bad fetchedAt", (c) => { c.fetchedAt = "whenever"; }],
    ["zero adapterVersion", (c) => { c.adapterVersion = 0; }],
    ["too many models", (c) => {
      c.models = Array.from({ length: 600 }, (_, i) => model(`m${i}`, { default: i === 0 }));
    }],
  ];

  it.each(ATTACKS)("core boundary rejects %s", (_name, fn) => {
    expect(() => validateCandidate(mutate(fn))).toThrow();
  });

  it.each(ATTACKS)("bridge boundary rejects %s", async (_name, fn) => {
    const built = mutate(fn);
    const adapter = {
      catalog: { scope: () => SCOPE, fetch: async () => built },
    } as unknown as Parameters<typeof invokeAdapterRpc>[2]["adapter"];
    await expect(
      invokeAdapterRpc("fetchModelCatalog", {}, { adapter, workspaceRoot: "/tmp" })
    ).rejects.toThrow();
  });

  /**
   * Scope identity fields are the one family that is SANITIZED rather than
   * rejected, because production legitimately puts a credential config
   * directory in them. The contract is therefore "the unsafe value cannot
   * cross", not "the fetch fails".
   */
  const SCOPE_ATTACKS: Array<[string, string, (c: AdapterCatalogCandidate) => void]> = [
    ["scope PII", "jesse@example.com", (c) => { c.scope.credentialProfile = "jesse@example.com"; }],
    ["scope secret path", "/home/ubuntu/.ssh/id_rsa", (c) => { c.scope.project = "/home/ubuntu/.ssh/id_rsa"; }],
  ];

  it.each(SCOPE_ATTACKS)("bridge boundary neutralizes %s before transport", async (_name, secret, fn) => {
    const built = mutate(fn);
    const adapter = {
      catalog: { scope: () => SCOPE, fetch: async () => built },
    } as unknown as Parameters<typeof invokeAdapterRpc>[2]["adapter"];
    const transported = await invokeAdapterRpc(
      "fetchModelCatalog", {}, { adapter, workspaceRoot: "/tmp" }
    ) as AdapterCatalogCandidate;
    expect(JSON.stringify(transported)).not.toContain(secret);
    expect(() => validateCandidate(transported)).not.toThrow();
  });

  it.each(SCOPE_ATTACKS)("core boundary refuses a RAW %s that bypassed normalization", (_name, _secret, fn) => {
    // Strict on the way in: anything reaching validation has been normalized,
    // so a surviving raw value means the boundary was skipped.
    expect(() => validateCandidate(mutate(fn))).toThrow();
  });

  it.each(SCOPE_ATTACKS)("a persisted generation never contains %s", async (_name, secret, fn) => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE,
      fetch: async () => mutate(fn),
    });
    expect((await service.refresh(binding)).result).toBe("published");
    expect(JSON.stringify(service.lookup(binding).snapshot!.candidate)).not.toContain(secret);
    store.close();
  });

  it("sanitizes legitimate host-shaped scope values instead of failing the refresh", () => {
    // Production genuinely puts a credential config directory here (Codex uses
    // ~/.codex), so rejecting would take every real catalog cold. It is
    // replaced with a stable non-reversible reference; distinctness is kept.
    const raw = candidate([model("nebula", { default: true })]);
    raw.scope = { ...raw.scope, credentialProfile: "/home/ubuntu/.codex" };
    const normalized = normalizeCatalogCandidate(raw);
    expect(normalized.scope.credentialProfile).toMatch(/^ref:[a-f0-9]{16}$/);
    expect(JSON.stringify(normalized)).not.toContain("/home/ubuntu");
    expect(() => validateCandidate(normalized)).not.toThrow();

    const other = { ...raw, scope: { ...raw.scope, credentialProfile: "/home/ubuntu/.claude" } };
    expect(normalizeCatalogCandidate(other).scope.credentialProfile)
      .not.toBe(normalized.scope.credentialProfile);
    // And it never mutates the caller's object — adapters memoize their scope,
    // and the service deep-freezes what it publishes.
    expect(raw.scope.credentialProfile).toBe("/home/ubuntu/.codex");
    expect(Object.isFrozen(raw.scope)).toBe(false);
  });

  it("normalization survives a frozen input candidate", () => {
    // `asRemoteCatalogAdapter` returns the SAME candidate object every fetch,
    // and the service deep-freezes published snapshots — so a second refresh
    // would hit a frozen object if normalization mutated in place.
    const raw = candidate([model("nebula", { default: true })]);
    raw.scope = { ...raw.scope, credentialProfile: "/home/ubuntu/.codex" };
    const frozen = Object.freeze({ ...raw, scope: Object.freeze({ ...raw.scope }) });
    expect(() => normalizeCatalogCandidate(frozen)).not.toThrow();
    expect(normalizeCatalogCandidate(frozen).scope.credentialProfile).toMatch(/^ref:/);
  });

  it("rejection is atomic and the previous generation is retained", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    const healthy = () => candidate([model("nebula", { default: true }), model("quasar")]);
    let next: () => AdapterCatalogCandidate = healthy;
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => next(),
    });
    expect((await service.refresh(binding)).generation).toBe(1);
    const before = service.models(binding).map((m) => m.id);

    for (const [name, fn] of ATTACKS) {
      next = () => {
        const poisoned = JSON.parse(JSON.stringify(healthy())) as AdapterCatalogCandidate;
        fn(poisoned);
        return poisoned;
      };
      const result = await service.refresh(binding);
      expect(result.result, `${name} must be refused wholesale`).toBe("retained");
      expect(result.generation).toBe(1);
      // Nothing partial was published; the LKG is intact.
      expect(service.models(binding).map((m) => m.id)).toEqual(before);
      next = healthy;
    }
    store.close();
  });
});

describe("#236 metadata enrichment carries evidence, not just description", () => {
  it("the REAL production join returns both, with no mutation or provider work", async () => {
    const { buildModelMetadataSnapshot } = await import("../packages/core/src/core/model-metadata/catalog.js");
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    const row = model("nebula", {
      default: true,
      description: "The outlier flagship.",
      evidence: [evidence({
        kind: "verified-record",
        source: "operator-verification",
        resolvedModel: "vendor::nebula@2026",
        note: "proven out of band",
      })],
    });
    let fetches = 0;
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE,
      fetch: async () => { fetches += 1; return candidate([row]); },
    });
    await service.refresh(binding);
    const publishedBefore = JSON.stringify(service.lookup(binding).snapshot!.candidate);

    // The exact production projection from packages/core/src/index.ts.
    const catalogRows = service.availableModels().map(({ binding: b, model: m }) => ({
      agentId: b.agentId,
      modelId: m.id,
      name: m.displayName,
      contextWindow: m.context.effective,
      vision: m.modalities.input.includes("image"),
      ...(m.description ? { description: m.description } : {}),
      ...(m.evidence?.length ? { evidence: m.evidence } : {}),
    }));
    const snapshot = buildModelMetadataSnapshot({
      catalog: catalogRows,
      sourceModels: [],
      source: "test",
      fetchedAt: "2026-09-09T00:00:00.000Z",
    });

    const metadata = snapshot.rows[0]!;
    expect(metadata.description).toBe("The outlier flagship.");
    expect(metadata.evidence).toHaveLength(1);
    expect(metadata.evidence[0]).toMatchObject({
      kind: "verified-record",
      source: "operator-verification",
      resolvedModel: "vendor::nebula@2026",
    });
    // No provider or network work, and the operational snapshot is untouched.
    expect(fetches).toBe(1);
    expect(JSON.stringify(service.lookup(binding).snapshot!.candidate)).toBe(publishedBefore);
    store.close();
  });

  it("survives the real metadata SQLite cache round trip", async () => {
    const { ModelMetadataStore } = await import("../packages/core/src/core/model-metadata/store.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-236-meta-"));
    dirs.push(dir);
    const metaStore = new ModelMetadataStore(path.join(dir, "meta.db"));
    const record = evidence({ kind: "enrichment", source: "external-index" });
    metaStore.replaceSnapshot([{
      id: "nebula", name: "Odd nebula", aliases: ["nebula"], slug: null,
      source_id: null, source_name: null, provider: null, creator: null,
      agents: ["fake"], agent_models: [{ agent: "fake", id: "nebula", name: "Odd nebula" }],
      context_window: 700_000, intelligence_index: null, benchmarks: {}, pricing: null,
      released_at: null, description: "The outlier flagship.", evidence: [record],
      source: "test", fetched_at: "2026-09-09T00:00:00.000Z",
    }]);
    const loaded = metaStore.get("nebula").model;
    expect(loaded?.description).toBe("The outlier flagship.");
    expect(loaded?.evidence).toEqual([record]);
    metaStore.close();
  });

  it("dedupes identical evidence advertised by several agents and stays bounded", async () => {
    const { buildModelMetadataSnapshot } = await import("../packages/core/src/core/model-metadata/catalog.js");
    const shared = evidence({ source: "shared-probe" });
    const snapshot = buildModelMetadataSnapshot({
      catalog: [
        { agentId: "a", modelId: "nebula", name: "N", contextWindow: 1, vision: false, evidence: [shared] },
        { agentId: "b", modelId: "nebula", name: "N", contextWindow: 1, vision: false, evidence: [shared] },
      ],
      sourceModels: [], source: "test", fetchedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(snapshot.rows[0]!.evidence).toHaveLength(1);
  });
});
