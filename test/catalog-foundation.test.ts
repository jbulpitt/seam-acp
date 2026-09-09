/**
 * #236 — provider-neutral catalog foundation.
 *
 * Everything here is deliberately expressed against an ALIEN fake provider:
 * unusual raw ids, a nonstandard config-option id, and effort names no core
 * switch could guess. If any assertion could only pass for Codex/Copilot/Grok/
 * Claude/AGY, the foundation has leaked provider knowledge into core.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessCatalogReduction,
  catalogContentChecksum,
  catalogModelFingerprint,
  catalogReductionFingerprint,
  catalogScopeFingerprint,
  invokeAdapterRpc,
  manifestCatalogSource,
  upgradeCatalogCandidate,
  CATALOG_EVIDENCE_MAX_RECORDS,
  CATALOG_EVIDENCE_TEXT_MAX,
  MODEL_CATALOG_MIN_SUPPORTED_SCHEMA_VERSION,
  MODEL_CATALOG_SCHEMA_VERSION,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-236-"));
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

function candidate(models: CatalogModel[], over: Partial<AdapterCatalogCandidate> = {}): AdapterCatalogCandidate {
  return {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    scope: SCOPE,
    models,
    source: "fake-adapter-probe",
    adapterVersion: 1,
    fetchedAt: "2026-09-09T00:00:00.000Z",
    ...over,
  };
}

const evidence = (over: Partial<CatalogModelEvidence> = {}): CatalogModelEvidence => ({
  kind: "live-observation",
  source: "fake-adapter-probe",
  observedAt: "2026-09-09T00:00:00.000Z",
  runtimeVersion: "outlier-cli 9.9",
  adapterVersion: 1,
  scopeRef: SCOPE.fingerprint,
  context: { native: 777_777, method: "provider-reported" },
  effort: { choices: ["default", "deliberate"], selectionDefault: "default", method: "provider-reported" },
  ...over,
});

// --- 1. per-model description and evidence ----------------------------------

describe("#236 per-model description and structured evidence", () => {
  it("accepts a row carrying a description and mixed evidence records", () => {
    const rows = [
      model("nebula", {
        default: true,
        description: "The outlier flagship.",
        evidence: [
          evidence(),
          evidence({
            kind: "verified-record",
            source: "operator-verification",
            resolvedModel: "vendor::nebula@2026",
            note: "proven out of band",
          }),
        ],
      }),
      model("quasar", { description: "A second row with no evidence at all." }),
    ];
    expect(() => validateCandidate(candidate(rows))).not.toThrow();
  });

  it("rejects malformed known evidence fields, so a bad record retains the LKG", () => {
    const bad = (over: Partial<Record<string, unknown>>) =>
      () => validateCandidate(candidate([model("nebula", {
        default: true,
        evidence: [{ ...evidence(), ...over } as CatalogModelEvidence],
      })]));
    expect(bad({ kind: "invented-kind" })).toThrow(/unknown evidence kind/);
    expect(bad({ source: "" })).toThrow(/must not be empty/);
    expect(bad({ observedAt: "not-a-time" })).toThrow(/observedAt: must be an ISO-8601 timestamp/);
    expect(bad({ adapterVersion: 0 })).toThrow(/adapterVersion/);
    expect(bad({ context: { native: -5 } })).toThrow(/context.native/);
    expect(bad({ effort: { choices: ["a", "a"] } })).toThrow(/effort.choices/);
    expect(bad({ note: "x".repeat(CATALOG_EVIDENCE_TEXT_MAX + 1) })).toThrow(/exceeds \d+ characters/);
    expect(() => validateCandidate(candidate([model("nebula", {
      default: true,
      evidence: Array.from({ length: CATALOG_EVIDENCE_MAX_RECORDS + 1 }, () => evidence()),
    })]))).toThrow(/exceeds 8 records/);
  });

  it("bounds every text field, so no record can carry an environment dump", () => {
    // The field set is CLOSED and each text field is length-bounded. That is
    // the structural reason a credential, token, raw env, or PII cannot be
    // smuggled into a durable snapshot that is then shipped over the bridge.
    const payload = "SECRET=".repeat(200);
    expect(payload.length).toBeGreaterThan(CATALOG_EVIDENCE_TEXT_MAX);
    for (const field of ["source", "runtimeVersion", "scopeRef", "resolvedModel", "note"]) {
      expect(() => validateCandidate(candidate([model("nebula", {
        default: true,
        evidence: [{ ...evidence(), [field]: payload } as CatalogModelEvidence],
      })]))).toThrow();
    }
  });

  it("REJECTS unknown and nested-unknown evidence keys (exact-key closure)", () => {
    // Tolerating unknown keys defeated the closed shape: a 50KB payload rode
    // through validation inside a key nobody declared.
    const withUnknown = (evidenceOver: Record<string, unknown>) =>
      () => validateCandidate(candidate([model("nebula", {
        default: true,
        evidence: [{ ...evidence(), ...evidenceOver } as unknown as CatalogModelEvidence],
      })]));
    expect(withUnknown({ somethingNewInV2: { nested: true } })).toThrow(/unknown key/);
    expect(withUnknown({ payload: "QA_SECRET=secret-value".repeat(2000) })).toThrow(/unknown key/);
    expect(withUnknown({ context: { native: 10, sneaky: "x" } })).toThrow(/context.sneaky: unknown key/);
    expect(withUnknown({ effort: { choices: ["a"], sneaky: "x" } })).toThrow(/effort.sneaky: unknown key/);
  });

  it("rejects secrets, PII, and secret-bearing paths regardless of length", () => {
    // Length is not sanitization: a short token fits every bound.
    const withNote = (note: string) =>
      () => validateCandidate(candidate([model("nebula", {
        default: true,
        evidence: [{ ...evidence(), note } as CatalogModelEvidence],
      })]));
    expect(withNote("QA_SECRET=hunter2000")).toThrow(/rejected content/);
    expect(withNote("token is sk-live_abcdefghijklmnop")).toThrow(/rejected content/);
    expect(withNote("contact jesse@example.com")).toThrow(/rejected content/);
    expect(withNote("see /home/ubuntu/.claude/.credentials.json")).toThrow(/rejected content/);
    expect(withNote("bearer abcdefghijklmno")).toThrow(/rejected content/);
    expect(withNote("read the api_key from settings")).toThrow(/rejected content/);
    // A legitimate operational note still passes.
    expect(withNote("verified against the runbook probe")).not.toThrow();
  });

  it("bounds list sizes and item sizes inside evidence", () => {
    const withEffort = (effortValue: unknown) =>
      () => validateCandidate(candidate([model("nebula", {
        default: true,
        evidence: [{ ...evidence(), effort: effortValue } as CatalogModelEvidence],
      })]));
    expect(withEffort({ choices: Array.from({ length: 25 }, (_, i) => `e${i}`) })).toThrow(/exceeds 24 entries/);
    expect(withEffort({ choices: ["x".repeat(65)] })).toThrow(/exceeds 64 characters/);
    expect(withEffort({ choices: ["low"], selectionDefault: "high" }))
      .toThrow(/selectionDefault is not among choices/);
  });

  it("rejects semantically inconsistent context evidence", () => {
    const withContext = (context: unknown) =>
      () => validateCandidate(candidate([model("nebula", {
        default: true,
        evidence: [{ ...evidence(), context } as CatalogModelEvidence],
      })]));
    expect(withContext({ native: 2_000_000, maximum: 1_000_000 })).toThrow(/native exceeds maximum/);
    expect(withContext({ effective: 2_000_000, maximum: 1_000_000 })).toThrow(/effective exceeds maximum/);
    expect(withContext({ native: 1_000_000, maximum: 1_000_000 })).not.toThrow();
  });

  it("requires scopeRef to be a fingerprint or a bounded sanitized identifier", () => {
    const withScope = (scopeRef: string) =>
      () => validateCandidate(candidate([model("nebula", {
        default: true,
        evidence: [{ ...evidence(), scopeRef } as CatalogModelEvidence],
      })]));
    expect(withScope(SCOPE.fingerprint)).not.toThrow();
    expect(withScope("work-account")).not.toThrow();
    expect(withScope("/home/ubuntu/.claude")).toThrow(/scope fingerprint or a bounded sanitized identifier/);
    expect(withScope("x".repeat(65))).toThrow(/scope fingerprint or a bounded sanitized identifier/);
  });

  it("is order-insensitive: reordering keys or evidence is not a change", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    const a = evidence({ kind: "live-observation", source: "probe-a" });
    const b = evidence({ kind: "verified-record", source: "probe-b" });
    let rows = [model("nebula", { default: true, description: "d", evidence: [a, b] })];
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(rows),
    });
    expect((await service.refresh(binding)).generation).toBe(1);
    // Same content, different evidence order and different key insertion order.
    rows = [model("nebula", { evidence: [b, a], description: "d", default: true })];
    const second = await service.refresh(binding);
    expect(second.result).toBe("unchanged");
    expect(second.generation).toBe(1);
    store.close();
  });

  it("includes description and evidence in checksum and diff detection", () => {
    const { file, store } = db();
    const binding = { agentId: "fake", location: "local" };
    let rows = [model("nebula", { default: true, description: "one" })];
    const service = new ModelCatalogService({
      store, logger,
      bindings: () => [binding],
      scope: () => SCOPE,
      fetch: async () => candidate(rows),
    });
    return (async () => {
      expect((await service.refresh(binding)).result).toBe("published");
      // Description-only edit: a NEW generation, because per-model fields are
      // part of the canonical checksum.
      rows = [model("nebula", { default: true, description: "two" })];
      const second = await service.refresh(binding);
      expect(second.result).toBe("published");
      expect(second.changed).toBe(1);
      // Evidence-only edit: likewise.
      rows = [model("nebula", { default: true, description: "two", evidence: [evidence()] })];
      const third = await service.refresh(binding);
      expect(third.result).toBe("published");
      expect(third.changed).toBe(1);
      expect(third.generation).toBe(3);
      store.close();
      expect(fs.existsSync(file)).toBe(true);
    })();
  });

  it("survives SQLite serialization and reload byte for byte", async () => {
    const { file, store } = db();
    const binding = { agentId: "fake", location: "local" };
    const rows = [model("nebula", {
      default: true,
      description: "The outlier flagship.",
      evidence: [evidence(), evidence({ kind: "enrichment", source: "external-index" })],
    })];
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(rows),
    });
    await service.refresh(binding);
    store.close();

    const reopened = new ModelCatalogStore(file);
    const reloaded = new ModelCatalogService({
      store: reopened, logger, bindings: () => [binding], scope: () => SCOPE,
      fetch: async () => { throw new Error("must not fetch on load"); },
    });
    const loaded = reloaded.lookup(binding).snapshot!.candidate.models[0]!;
    expect(loaded.description).toBe("The outlier flagship.");
    expect(loaded.evidence).toEqual(rows[0]!.evidence);
    reopened.close();
  });
});

describe("#236 evidence survives every transport a snapshot crosses", () => {
  const rows = () => [model("nebula", {
    default: true,
    description: "The outlier flagship.",
    evidence: [evidence(), evidence({ kind: "verified-record", source: "operator-verification" })],
  })];

  it("round-trips through the bridge RPC unchanged", async () => {
    const built = candidate(rows());
    const adapter = {
      catalog: { scope: () => SCOPE, fetch: async () => built },
    } as unknown as Parameters<typeof invokeAdapterRpc>[2]["adapter"];
    const returned = await invokeAdapterRpc("fetchModelCatalog", {}, { adapter, workspaceRoot: "/tmp" });
    // The bridge is a JSON channel, so fidelity means surviving serialization.
    const transported = JSON.parse(JSON.stringify(returned)) as AdapterCatalogCandidate;
    expect(transported.models[0]!.description).toBe("The outlier flagship.");
    expect(transported.models[0]!.evidence).toEqual(built.models[0]!.evidence);
    expect(() => validateCandidate(transported)).not.toThrow();
  });

  it("is visible to, and unharmed by, the metadata/value enrichment join", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(rows()),
    });
    await service.refresh(binding);
    // The production join projects a narrow shape out of availableModels().
    // It READS the catalog and writes a separate metadata store, so it can
    // never strip evidence off the published generation.
    const available = service.availableModels();
    expect(available).toHaveLength(1);
    expect(available[0]!.model.evidence).toEqual(rows()[0]!.evidence);
    const projected = available.map(({ binding: b, model: m }) => ({
      agentId: b.agentId, modelId: m.id, name: m.displayName,
      contextWindow: m.context.effective, vision: m.modalities.input.includes("image"),
    }));
    expect(projected[0]).toMatchObject({ agentId: "fake", modelId: "nebula" });
    expect(service.lookup(binding).snapshot!.candidate.models[0]!.evidence)
      .toEqual(rows()[0]!.evidence);
    store.close();
  });
});

// --- 2. backward-compatible durable snapshots -------------------------------

describe("#236 durable snapshots survive an upgrade", () => {
  it("loads a pre-change #229 snapshot that has no description or evidence", () => {
    const { file, store } = db();
    const binding = { agentId: "fake", location: "local" };
    // Exactly what merged #229 wrote: no per-model description/evidence keys.
    const legacy = candidate([model("nebula", { default: true })]);
    expect(JSON.stringify(legacy)).not.toContain("evidence");
    store.publish({
      scopeKey: `scope:${SCOPE.fingerprint}`,
      checksum: "legacy-checksum",
      candidate: legacy,
      publishedAt: "2026-09-01T00:00:00.000Z",
      observation: {
        bindingKey: "fake@local", agentId: "fake", location: "local",
        scopeKey: `scope:${SCOPE.fingerprint}`, checksum: "legacy-checksum",
        adapterVersion: 1, schemaVersion: 1, cliVersion: null, sourceVersion: null,
        source: "fake-adapter-probe", fetchedAt: "2026-09-01T00:00:00.000Z", drift: null,
      },
    });
    store.close();

    const reopened = new ModelCatalogStore(file);
    const service = new ModelCatalogService({
      store: reopened, logger, bindings: () => [binding], scope: () => SCOPE,
      fetch: async () => { throw new Error("a deploy must not need a refresh to serve LKG"); },
    });
    // The whole point: an upgraded build serves the old snapshot immediately.
    expect(service.lookup(binding).state).toBe("ready");
    expect(service.models(binding).map((m) => m.id)).toEqual(["nebula"]);
    reopened.close();
  });

  it("accepts a supported schema RANGE rather than one exact version", () => {
    expect(MODEL_CATALOG_MIN_SUPPORTED_SCHEMA_VERSION).toBeLessThanOrEqual(MODEL_CATALOG_SCHEMA_VERSION);
    expect(() => validateCandidate(candidate([model("nebula", { default: true })]))).not.toThrow();
    // Too new to understand, and too old to understand, both fail closed.
    expect(() => validateCandidate(candidate([model("nebula", { default: true })], {
      schemaVersion: MODEL_CATALOG_SCHEMA_VERSION + 1,
    }))).toThrow(/unsupported model catalog schema/);
    expect(() => validateCandidate(candidate([model("nebula", { default: true })], {
      schemaVersion: MODEL_CATALOG_MIN_SUPPORTED_SCHEMA_VERSION - 1,
    }))).toThrow(/unsupported model catalog schema/);
  });

  it("upgradeCatalogCandidate normalizes in range and refuses out of range", () => {
    const row = candidate([model("nebula", { default: true })]);
    expect(upgradeCatalogCandidate(row)).toEqual(row);
    expect(upgradeCatalogCandidate({ ...row, schemaVersion: MODEL_CATALOG_SCHEMA_VERSION + 1 })).toBeNull();
    expect(upgradeCatalogCandidate({ ...row, schemaVersion: 0 })).toBeNull();
    expect(upgradeCatalogCandidate({ ...row, schemaVersion: "1" as unknown as number })).toBeNull();
  });

  it("a malformed stored row is ignored, never deleted, and the rest still load", () => {
    const { file, store } = db();
    const binding = { agentId: "fake", location: "local" };
    store.publish({
      scopeKey: `scope:${SCOPE.fingerprint}`,
      checksum: "c1",
      candidate: candidate([model("nebula", { default: true })]),
      publishedAt: "2026-09-01T00:00:00.000Z",
      observation: {
        bindingKey: "fake@local", agentId: "fake", location: "local",
        scopeKey: `scope:${SCOPE.fingerprint}`, checksum: "c1", adapterVersion: 1, schemaVersion: 1,
        cliVersion: null, sourceVersion: null, source: "fake-adapter-probe",
        fetchedAt: "2026-09-01T00:00:00.000Z", drift: null,
      },
    });
    store.close();
    // Corrupt the stored evidence in place.
    const raw = new Database(file);
    const stored = raw.prepare("SELECT generation, snapshot_json FROM model_catalog_generations").get() as {
      generation: number; snapshot_json: string;
    };
    const parsed = JSON.parse(stored.snapshot_json) as AdapterCatalogCandidate;
    (parsed.models[0] as CatalogModel).evidence = [{ kind: "nonsense" } as unknown as CatalogModelEvidence];
    raw.prepare("UPDATE model_catalog_generations SET snapshot_json = ? WHERE generation = ?")
      .run(JSON.stringify(parsed), stored.generation);
    raw.close();

    const reopened = new ModelCatalogStore(file);
    const service = new ModelCatalogService({
      store: reopened, logger, bindings: () => [binding], scope: () => SCOPE,
      fetch: async () => { throw new Error("no fetch on load"); },
    });
    // Fails closed for that scope rather than serving a malformed catalog…
    expect(service.lookup(binding).state).toBe("warming");
    // …and the durable row is still on disk for an operator to inspect.
    const after = new Database(file);
    expect((after.prepare("SELECT COUNT(*) AS n FROM model_catalog_generations").get() as { n: number }).n).toBe(1);
    after.close();
    reopened.close();
  });
});

// --- 3. honest default semantics --------------------------------------------

describe("#236 honest default semantics", () => {
  const source = (models: Array<{ modelId: string; name: string }>, defaultModel: string) =>
    manifestCatalogSource({
      provider: "architectural-outlier",
      defaultModel,
      models: () => models,
      adapterVersion: 1,
    });

  it("fails candidate construction instead of silently promoting row zero", async () => {
    await expect(
      source([{ modelId: "quasar", name: "Quasar" }, { modelId: "pulsar", name: "Pulsar" }], "default").fetch()
    ).rejects.toThrow(/does not resolve to a published model row/);
    // The old behavior: `default` unresolved => first row silently became the
    // default. A thread would then start on whichever model sorted first.
    await expect(
      source([{ modelId: "quasar", name: "Quasar" }], "nonexistent").fetch()
    ).rejects.toThrow(/does not resolve/);
  });

  it("publishes a literal unresolved default alias row when the adapter declares one", async () => {
    const built = await manifestCatalogSource({
      provider: "architectural-outlier",
      defaultModel: "default",
      models: () => [
        { modelId: "default", name: "Recommended" },
        { modelId: "quasar", name: "Quasar" },
      ],
      adapterVersion: 1,
    }).fetch();
    validateCandidate(built);
    const alias = built.models.find((m) => m.id === "default")!;
    expect(alias.default).toBe(true);
    expect(alias.runtimeId).toBe("default");
  });

  it("lets an unresolved alias and its verified canonical row coexist without collision", () => {
    // The alias keeps its own raw binding; the verified resolution lives ONLY
    // in evidence, so it can never rewrite identity or collide with the
    // canonical row it names.
    const alias = model("default", {
      default: true,
      runtimeId: "default",
      evidence: [evidence({
        kind: "verified-record",
        source: "operator-verification",
        resolvedModel: "vendor::nebula@2026",
        note: "alias resolves here, proven out of band",
      })],
      bindings: [
        { model: "default", effort: "default", rawModel: "default" },
        { model: "default", effort: "deliberate", rawModel: "default", rawEffort: "THINK::9000" },
      ],
    });
    const canonical = model("nebula");
    expect(() => validateCandidate(candidate([alias, canonical]))).not.toThrow();
    // Distinct raw bindings — the reverse codec stays unambiguous.
    expect(alias.bindings[0]!.rawModel).not.toBe(canonical.bindings[0]!.rawModel);
  });

  it("still refuses a candidate with no default, or with two", () => {
    expect(() => validateCandidate(candidate([model("nebula"), model("quasar")])))
      .toThrow(/exactly one default model \(found 0\)/);
    expect(() => validateCandidate(candidate([
      model("nebula", { default: true }), model("quasar", { default: true }),
    ]))).toThrow(/exactly one default model \(found 2\)/);
  });

  it("refuses an alias row that collides with a canonical row's raw binding", () => {
    // Rewriting the alias's raw binding to the resolved model is exactly what
    // section 3 forbids; generic validation catches it as an ambiguous codec.
    const alias = model("default", {
      default: true,
      runtimeId: "vendor::nebula@2026",
      bindings: [
        { model: "default", effort: "default", rawModel: "vendor::nebula@2026" },
        { model: "default", effort: "deliberate", rawModel: "vendor::nebula@2026", rawEffort: "THINK::9000" },
      ],
    });
    expect(() => validateCandidate(candidate([alias, model("nebula")])))
      .toThrow(/ambiguous reverse binding/);
  });
});

// --- 4. small-catalog reduction protection ----------------------------------

describe("#236 small-catalog reduction policy", () => {
  const ids = (list: string[]) => list.map((id) => ({ id }));

  it("flags the named failure modes and leaves growth alone", () => {
    expect(assessCatalogReduction(ids(["a", "b"]), ids(["a"]))?.rule).toBe("small-catalog");
    expect(assessCatalogReduction(ids(["a", "b", "c"]), ids(["a"]))?.rule).toBe("small-catalog");
    expect(assessCatalogReduction(ids(["a", "b", "c"]), ids(["a", "b"]))?.rule).toBe("small-catalog");
    // Additions, no-ops, and metadata-only changes never trip it.
    expect(assessCatalogReduction(ids(["a"]), ids(["a", "b"]))).toBeNull();
    expect(assessCatalogReduction(ids(["a", "b"]), ids(["a", "b"]))).toBeNull();
    expect(assessCatalogReduction([], ids(["a"]))).toBeNull();
    // A same-size replacement in a SMALL catalog is still a removal, and is
    // indistinguishable from a partial fetch that substituted a placeholder.
    expect(assessCatalogReduction(ids(["a", "b"]), ids(["a", "c"]))?.rule).toBe("small-catalog");
    expect(assessCatalogReduction(ids(["a", "b"]), ids(["a", "c"]))?.removed).toEqual(["b"]);
    expect(assessCatalogReduction(ids(["a", "b", "c"]), ids(["a", "b", "d"]))?.rule).toBe("small-catalog");
    // Above the small-catalog threshold the proportional rule governs, so a
    // same-size swap in a large catalog still publishes.
    expect(assessCatalogReduction(ids(["a", "b", "c", "d"]), ids(["a", "b", "c", "e"]))).toBeNull();
    // Large catalogs keep the proportional rule.
    expect(assessCatalogReduction(ids(["a", "b", "c", "d"]), ids(["a"]))?.rule).toBe("collapse");
    expect(assessCatalogReduction(ids(["a", "b", "c", "d"]), ids(["a", "b", "c"]))).toBeNull();
  });

  it("is configurable without any agent-id branch", () => {
    const policy = { smallCatalogMaxModels: 5, collapseMinModels: 6 };
    expect(assessCatalogReduction(ids(["a", "b", "c", "d"]), ids(["a", "b", "c"]), policy)?.rule)
      .toBe("small-catalog");
  });

  it("quarantines a 2→1 reduction until an identical refresh confirms it", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    let rows = [model("nebula", { default: true }), model("quasar")];
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(rows),
    });
    expect((await service.refresh(binding)).generation).toBe(1);

    rows = [model("nebula", { default: true })];
    const held = await service.refresh(binding);
    expect(held.result).toBe("quarantined");
    expect(held.ok).toBe(false);
    expect(held.generation).toBe(1);
    expect(held.reduction).toMatchObject({ rule: "small-catalog", removed: ["quasar"], confirmationRequired: true });
    expect(held.error).toMatch(/repeat an identical refresh to confirm/);
    // The LKG still serves both models while the candidate is held.
    expect(service.models(binding).map((m) => m.id)).toEqual(["nebula", "quasar"]);

    const confirmed = await service.refresh(binding);
    expect(confirmed.result).toBe("published");
    expect(confirmed.generation).toBe(2);
    expect(service.models(binding).map((m) => m.id)).toEqual(["nebula"]);
    store.close();
  });

  it("resets confirmation when the second observation differs", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    let rows = [model("nebula", { default: true }), model("quasar"), model("pulsar")];
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(rows),
    });
    await service.refresh(binding);

    rows = [model("nebula", { default: true })];
    expect((await service.refresh(binding)).result).toBe("quarantined");
    // A DIFFERENT reduced candidate is not a confirmation of the first one.
    rows = [model("quasar", { default: true })];
    expect((await service.refresh(binding)).result).toBe("quarantined");
    // …and the original candidate must now be seen twice again.
    rows = [model("nebula", { default: true })];
    expect((await service.refresh(binding)).result).toBe("quarantined");
    expect((await service.refresh(binding)).result).toBe("published");
    store.close();
  });

  it("resets confirmation when the second observation FAILS", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    let rows = [model("nebula", { default: true }), model("quasar")];
    let boom = false;
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE,
      fetch: async () => {
        if (boom) throw new Error("provider unavailable");
        return candidate(rows);
      },
    });
    await service.refresh(binding);
    rows = [model("nebula", { default: true })];
    expect((await service.refresh(binding)).result).toBe("quarantined");

    boom = true;
    expect((await service.refresh(binding)).result).toBe("retained");
    boom = false;
    // A failure in between means the reduction needs two fresh sightings again.
    expect((await service.refresh(binding)).result).toBe("quarantined");
    expect((await service.refresh(binding)).result).toBe("published");
    store.close();
  });

  it("publishes immediately under bounded operator acceptance", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    let rows = [model("nebula", { default: true }), model("quasar")];
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(rows),
    });
    await service.refresh(binding);
    rows = [model("nebula", { default: true })];
    const accepted = await service.refresh(binding, "manual", { acceptReduction: true });
    expect(accepted.result).toBe("published");
    expect(accepted.generation).toBe(2);
    expect(service.models(binding).map((m) => m.id)).toEqual(["nebula"]);
    store.close();
  });

  it("does not let acceptance persist beyond the one refresh it was given to", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    let rows = [model("nebula", { default: true }), model("quasar"), model("pulsar")];
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(rows),
    });
    await service.refresh(binding);
    rows = [model("nebula", { default: true }), model("quasar")];
    expect((await service.refresh(binding, "manual", { acceptReduction: true })).result).toBe("published");
    // A LATER reduction is quarantined again — acceptance was not a setting.
    rows = [model("nebula", { default: true })];
    expect((await service.refresh(binding)).result).toBe("quarantined");
    store.close();
  });

  it("never blocks an addition to a small catalog", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    let rows = [model("nebula", { default: true })];
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(rows),
    });
    await service.refresh(binding);
    rows = [model("nebula", { default: true }), model("quasar")];
    const grown = await service.refresh(binding);
    expect(grown.result).toBe("published");
    expect(grown.added).toBe(1);
    expect(grown.removed).toBe(0);
    store.close();
  });
});

describe("#236 confirmation is consecutive-safe across every attempt kind", () => {
  const reduced = () => [model("nebula", { default: true })];
  const full = () => [model("nebula", { default: true }), model("quasar")];

  it("quarantine -> offline -> identical candidate quarantines AGAIN, never publishes", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    let rows = full();
    let online = true;
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE,
      isOnline: () => online,
      fetch: async () => candidate(rows),
    });
    await service.refresh(binding);
    rows = reduced();
    const sequence: string[] = [];
    sequence.push((await service.refresh(binding)).result);
    online = false;
    sequence.push((await service.refresh(binding)).result);
    online = true;
    sequence.push((await service.refresh(binding)).result);
    // The exact reproduction that failed before: an intervening unavailable
    // observation must NOT count as the independent confirmation.
    expect(sequence).toEqual(["quarantined", "unavailable", "quarantined"]);
    expect((await service.refresh(binding)).result).toBe("published");
    store.close();
  });

  it("does not accept a stored refresh checksum that was never a reduction quarantine", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    let rows = full();
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(rows),
    });
    await service.refresh(binding);
    // A plain successful attempt records a candidate checksum; it must not be
    // mistakable for a reduction confirmation.
    expect(store.getReductionQuarantine("fake@local")).toBeNull();
    rows = reduced();
    expect((await service.refresh(binding)).result).toBe("quarantined");
    const stored = store.getReductionQuarantine("fake@local");
    expect(stored).toMatchObject({ rule: "small-catalog", removed: ["quasar"], priorGeneration: 1 });
    store.close();
  });

  it("survives a restart: the confirmation is durable, typed, and generation-tied", async () => {
    const { file, store } = db();
    const binding = { agentId: "fake", location: "local" };
    let rows = full();
    const first = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(rows),
    });
    await first.refresh(binding);
    rows = reduced();
    expect((await first.refresh(binding)).result).toBe("quarantined");
    store.close();

    const reopened = new ModelCatalogStore(file);
    const second = new ModelCatalogService({
      store: reopened, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(reduced()),
    });
    expect((await second.refresh(binding)).result).toBe("published");
    reopened.close();
  });

  it("uses a substantive fingerprint, so a new observedAt still confirms", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    let stamp = "2026-09-09T00:00:00.000Z";
    let rows = full();
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE,
      fetch: async () => candidate(
        rows.map((row) => ({ ...row, evidence: [evidence({ observedAt: stamp })] })),
        { fetchedAt: stamp }
      ),
    });
    await service.refresh(binding);
    rows = reduced();
    stamp = "2026-09-09T01:00:00.000Z";
    expect((await service.refresh(binding)).result).toBe("quarantined");
    // A NEW observation of the same reduced catalog: only the timestamps moved.
    stamp = "2026-09-09T02:00:00.000Z";
    expect((await service.refresh(binding)).result).toBe("published");
    store.close();
  });
});

describe("#236 portable validation runs before bridge transport", () => {
  const hostile = (over: Record<string, unknown>) => candidate([model("nebula", {
    default: true,
    evidence: [{ kind: "live-observation", source: "probe", ...over } as unknown as CatalogModelEvidence],
  })]);

  const adapterFor = (built: AdapterCatalogCandidate) => ({
    catalog: { scope: () => SCOPE, fetch: async () => built },
  } as unknown as Parameters<typeof invokeAdapterRpc>[2]["adapter"]);

  it("refuses to TRANSPORT unknown keys, secrets, or oversized evidence", async () => {
    for (const bad of [
      { unknownKey: "x".repeat(50_000) },
      { note: "QA_SECRET=secret-value" },
      { note: "reach me at jesse@example.com" },
      { scopeRef: "/home/ubuntu/.claude/.credentials.json" },
      { effort: { choices: Array.from({ length: 40 }, (_, i) => `e${i}`) } },
      { context: { native: 9, maximum: 5 } },
    ]) {
      await expect(
        invokeAdapterRpc("fetchModelCatalog", {}, { adapter: adapterFor(hostile(bad)), workspaceRoot: "/tmp" })
      ).rejects.toThrow(/evidence /);
    }
  });

  it("normalizes evidence order before it crosses the bridge", async () => {
    const a = evidence({ kind: "verified-record", source: "zeta" });
    const b = evidence({ kind: "live-observation", source: "alpha" });
    const built = candidate([model("nebula", { default: true, evidence: [a, b] })]);
    const returned = await invokeAdapterRpc(
      "fetchModelCatalog", {}, { adapter: adapterFor(built), workspaceRoot: "/tmp" }
    ) as AdapterCatalogCandidate;
    // Semantic order, so array order can never become an identity authority.
    expect(returned.models[0]!.evidence!.map((r) => r.kind)).toEqual(["live-observation", "verified-record"]);
  });
});

describe("#236 configured defaults resolve by id or declared alias, collision-safely", () => {
  const build = (models: Array<{ modelId: string; name: string; aliases?: string[] }>, defaultModel: string) =>
    manifestCatalogSource({
      provider: "architectural-outlier",
      defaultModel,
      models: () => models,
      adapterVersion: 1,
    }).fetch();

  it("resolves a default that names a row's DECLARED alias", async () => {
    const built = await build(
      [{ modelId: "canonical", name: "Canonical", aliases: ["recommended"] }, { modelId: "other", name: "Other" }],
      "recommended"
    );
    validateCandidate(built);
    expect(built.models.filter((m) => m.default).map((m) => m.id)).toEqual(["canonical"]);
  });

  it("refuses an ambiguous alias claimed by two rows", async () => {
    await expect(build(
      [
        { modelId: "one", name: "One", aliases: ["shared"] },
        { modelId: "two", name: "Two", aliases: ["shared"] },
      ],
      "shared"
    )).rejects.toThrow(/ambiguous/);
  });

  it("prefers an exact id over another row's alias of the same name", async () => {
    const built = await build(
      [
        { modelId: "recommended", name: "Literal" },
        { modelId: "canonical", name: "Canonical", aliases: ["recommended"] },
      ],
      "recommended"
    );
    // An exact id is unambiguous even when a peer declares it as an alias, so
    // this must not be reported as a collision.
    expect(built.models.filter((m) => m.default).map((m) => m.id)).toEqual(["recommended"]);
  });

  it("removes the remote row-zero fallback entirely", async () => {
    const { asRemoteCatalogAdapter } = await import("@seam/adapters");
    const noDefault = candidate([model("nebula"), model("quasar")]);
    expect(() => asRemoteCatalogAdapter("remote-agent", noDefault))
      .toThrow(/exactly one default model \(found 0 of 2\)/);
    const twoDefaults = candidate([model("nebula", { default: true }), model("quasar", { default: true })]);
    expect(() => asRemoteCatalogAdapter("remote-agent", twoDefaults))
      .toThrow(/exactly one default model \(found 2 of 2\)/);
    // A well-formed remote catalog still builds.
    expect(asRemoteCatalogAdapter("remote-agent", candidate([model("nebula", { default: true })])).id)
      .toBe("remote-agent");
  });
});

describe("#236 description/evidence reach real production output paths", () => {
  const described = () => model("nebula", {
    default: true,
    description: "The outlier flagship.",
    evidence: [evidence({
      kind: "verified-record",
      source: "operator-verification",
      resolvedModel: "vendor::nebula@2026",
      note: "proven out of band",
    })],
  });

  /** A real service over real SQLite with a real published generation. */
  async function publishedService(binding: { agentId: string; location: string }) {
    const { store } = db();
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE,
      fetch: async () => candidate([described()]),
    });
    await service.refresh(binding);
    return { store, service };
  }

  it("SessionRouter.describeConfig exposes the selected model's provenance", async () => {
    // NOTE: describeConfig is the shared INPUT the surfaces read; it is NOT
    // coverage for status or audit. Those have their own tests below that
    // exercise real production construction and serialization.
    const { SessionRouter } = await import("../packages/core/src/core/session-router.js");
    const binding = { agentId: "fake", location: "local" };
    const { store, service } = await publishedService(binding);
    const router = new SessionRouter({
      logger,
      store: { readConfig: () => ({ model: "nebula", agentId: "fake" }) } as never,
      profiles: [{ id: "fake", defaultModel: "nebula", effort: { mechanism: "none", levels: [] } }] as never,
      config: { REPOS_ROOT: "/repo", channelPresets: {}, threadPresets: {} } as never,
      modelCatalog: service as never,
    } as never);
    const d = router.describeConfig({
      id: "discord:t1", platform: "discord", channelRef: "t1", parentRef: "c1",
      agentId: "fake", acpSessionId: "", repoPath: "/repo",
      configJson: JSON.stringify({ model: "nebula" }),
      createdUtc: "2026-09-09T00:00:00Z", updatedUtc: "2026-09-09T00:00:00Z",
    } as never);
    expect(d.catalog.model).toMatchObject({ id: "nebula", description: "The outlier flagship." });
    expect(d.catalog.model?.evidence?.[0]).toMatchObject({ kind: "verified-record" });
    store.close();
  });

  it("MCP config_describe RENDERS the provenance (production output, not a projection)", async () => {
    const { SeamMcpServer } = await import("../packages/core/src/core/mcp/seam-mcp-server.js");
    const record = {
      id: "discord:t1", platform: "discord", channelRef: "t1", parentRef: "c1",
      agentId: "fake", acpSessionId: "", repoPath: "/repo", configJson: "{}",
      createdUtc: "2026-09-09T00:00:00Z", updatedUtc: "2026-09-09T00:00:00Z",
    };
    const server = new SeamMcpServer({
      logger,
      resolveSession: (token: string) => (token === "tok" ? record : undefined),
      enqueueDispatch: async () => {},
      describeConfig: () => ({
        sessionId: "discord:t1", channelRef: "t1", parentRef: "c1",
        agent: { value: "fake", source: "default" },
        model: { value: "nebula", source: "default" },
        effort: { value: "default", source: "default" },
        cwd: { value: "/repo", source: "default" },
        permission: { value: "ask", source: "default" },
        locked: false,
        detached: { value: false, source: "default" },
        tts: { value: false, source: "default" },
        ttsVoice: { value: null, source: "default" },
        ttsPace: { value: "natural", source: "default" },
        ttsStyle: { value: "neutral", source: "default" },
        location: { value: "local", source: "default" },
        catalog: {
          state: "ready", generation: 1, source: "fake-adapter-probe",
          fetchedAt: "2026-09-09T00:00:00.000Z",
          model: {
            id: "nebula",
            description: "The outlier flagship.",
            evidence: described().evidence!,
          },
        },
      }),
    } as never);
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seam-session": "tok" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "config_describe", arguments: {} },
      }),
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    const text = body.result.content[0]!.text;
    expect(text).toContain("model info: nebula — The outlier flagship.");
    expect(text).toContain("verified-record via operator-verification");
    expect(text).toContain("resolved vendor::nebula@2026");
    expect(text).toContain("proven out of band");
    await server.stop();
  });

  it("the metadata join carries the catalog description into real snapshot rows", async () => {
    const { buildModelMetadataSnapshot } = await import("../packages/core/src/core/model-metadata/catalog.js");
    const binding = { agentId: "fake", location: "local" };
    const { store, service } = await publishedService(binding);
    // The exact production projection from packages/core/src/index.ts.
    const catalogRows = service.availableModels().map(({ binding: b, model: m }) => ({
      agentId: b.agentId,
      modelId: m.id,
      name: m.displayName,
      contextWindow: m.context.effective,
      vision: m.modalities.input.includes("image"),
      ...(m.description ? { description: m.description } : {}),
    }));
    const snapshot = buildModelMetadataSnapshot({
      catalog: catalogRows,
      sourceModels: [],
      source: "test",
      fetchedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(snapshot.rows[0]).toMatchObject({ id: "nebula", description: "The outlier flagship." });
    store.close();
  });

  it("keeps those reads cache-only — no fetch is triggered by inspection", async () => {
    const binding = { agentId: "fake", location: "local" };
    const { store } = db();
    let fetches = 0;
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE,
      fetch: async () => { fetches += 1; return candidate([described()]); },
    });
    await service.refresh(binding);
    expect(fetches).toBe(1);
    for (let i = 0; i < 5; i++) {
      service.lookup(binding);
      service.models(binding);
      service.model(binding, "nebula");
      service.availableModels();
    }
    expect(fetches).toBe(1);
    store.close();
  });
});

describe("#236 exact-key closure covers the WHOLE candidate graph", () => {
  const base = () => candidate([model("nebula", { default: true })]);

  /** Inject an undeclared key at one path in the normalized graph. */
  const inject = (mutate: (c: AdapterCatalogCandidate) => void): AdapterCatalogCandidate => {
    const built = JSON.parse(JSON.stringify(base())) as AdapterCatalogCandidate;
    mutate(built);
    return built;
  };

  const INJECTIONS: Array<[string, (c: AdapterCatalogCandidate) => void]> = [
    ["candidate", (c) => { (c as unknown as Record<string, unknown>).sneaky = "x"; }],
    ["scope", (c) => { (c.scope as unknown as Record<string, unknown>).sneaky = "x"; }],
    ["model", (c) => { (c.models[0] as unknown as Record<string, unknown>).sneaky = "x"; }],
    ["model.context", (c) => { (c.models[0]!.context as unknown as Record<string, unknown>).sneaky = "x"; }],
    ["model.modalities", (c) => { (c.models[0]!.modalities as unknown as Record<string, unknown>).sneaky = "x"; }],
    ["model.effort", (c) => { (c.models[0]!.effort as unknown as Record<string, unknown>).sneaky = "x"; }],
    ["model.effort.choices[0]", (c) => { (c.models[0]!.effort.choices[0] as unknown as Record<string, unknown>).sneaky = "x"; }],
    ["model.bindings[0]", (c) => { (c.models[0]!.bindings[0] as unknown as Record<string, unknown>).sneaky = "x"; }],
    ["model (large payload)", (c) => {
      (c.models[0] as unknown as Record<string, unknown>).payload = "QA_SECRET=secret-value".repeat(2000);
    }],
  ];

  it.each(INJECTIONS)("core boundary rejects an unknown key at %s", (_name, mutate) => {
    expect(() => validateCandidate(inject(mutate))).toThrow(/unknown key/);
  });

  it.each(INJECTIONS)("bridge boundary rejects an unknown key at %s", async (_name, mutate) => {
    const adapter = {
      catalog: { scope: () => SCOPE, fetch: async () => inject(mutate) },
    } as unknown as Parameters<typeof invokeAdapterRpc>[2]["adapter"];
    await expect(
      invokeAdapterRpc("fetchModelCatalog", {}, { adapter, workspaceRoot: "/tmp" })
    ).rejects.toThrow(/unknown key/);
  });

  it("still accepts the complete declared shape at both boundaries", async () => {
    const full = candidate([model("nebula", {
      default: true,
      description: "ok",
      evidence: [evidence()],
      aliases: ["neb"],
      pricingCategory: "purple",
      compatibility: "fake-v9",
      serviceTiers: ["strange"],
    })], { sourceVersion: "v1", cliVersion: "cli 1" });
    expect(() => validateCandidate(full)).not.toThrow();
    const adapter = {
      catalog: { scope: () => SCOPE, fetch: async () => full },
    } as unknown as Parameters<typeof invokeAdapterRpc>[2]["adapter"];
    await expect(
      invokeAdapterRpc("fetchModelCatalog", {}, { adapter, workspaceRoot: "/tmp" })
    ).resolves.toBeTruthy();
  });

  it("keeps schema-1 LKG loadable under the closed shape", async () => {
    const { file, store } = db();
    const binding = { agentId: "fake", location: "local" };
    const legacy = candidate([model("nebula", { default: true })]);
    store.publish({
      scopeKey: `scope:${SCOPE.fingerprint}`, checksum: "legacy",
      candidate: legacy, publishedAt: "2026-09-01T00:00:00.000Z",
      observation: {
        bindingKey: "fake@local", agentId: "fake", location: "local",
        scopeKey: `scope:${SCOPE.fingerprint}`, checksum: "legacy",
        adapterVersion: 1, schemaVersion: 1, cliVersion: null, sourceVersion: null,
        source: "fake-adapter-probe", fetchedAt: "2026-09-01T00:00:00.000Z", drift: null,
      },
    });
    store.close();
    const reopened = new ModelCatalogStore(file);
    const service = new ModelCatalogService({
      store: reopened, logger, bindings: () => [binding], scope: () => SCOPE,
      fetch: async () => { throw new Error("no fetch on load"); },
    });
    expect(service.lookup(binding).state).toBe("ready");
    reopened.close();
  });
});

describe("#236 evidence ordering is a TOTAL canonical order", () => {
  /** Two valid records agreeing on kind/source/observedAt but differing after. */
  const tied = (note: string) => evidence({
    kind: "live-observation", source: "same-source",
    observedAt: "2026-09-09T00:00:00.000Z", note,
  });

  it("checksums identically when tied records arrive in either order", () => {
    const a = tied("alpha note");
    const b = tied("beta note");
    const forward = candidate([model("nebula", { default: true, evidence: [a, b] })]);
    const reverse = candidate([model("nebula", { default: true, evidence: [b, a] })]);
    validateCandidate(forward);
    validateCandidate(reverse);
    // The previous comparator stopped at the three primary keys, so these two
    // retained input order and produced different content checksums — making
    // transport order a generation/diff and reduction-confirmation authority.
    expect(catalogContentChecksum(forward)).toBe(catalogContentChecksum(reverse));
    expect(catalogReductionFingerprint(forward)).toBe(catalogReductionFingerprint(reverse));
    expect(catalogModelFingerprint(forward.models[0]!)).toBe(catalogModelFingerprint(reverse.models[0]!));
  });

  it("is stable across every permutation of an equivalent evidence set", () => {
    const records = [
      tied("alpha"), tied("beta"), tied("gamma"),
      evidence({ kind: "verified-record", source: "same-source", observedAt: "2026-09-09T00:00:00.000Z" }),
    ];
    const permute = <T,>(items: T[]): T[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, index) =>
            permute([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])
          );
    const checksums = new Set(
      permute(records).map((order) => {
        const built = candidate([model("nebula", { default: true, evidence: order })]);
        validateCandidate(built);
        return catalogContentChecksum(built);
      })
    );
    expect(permute(records)).toHaveLength(24);
    expect(checksums.size).toBe(1);
  });

  it("does NOT reorder arrays whose order is provider-meaningful", () => {
    // Models are a preference order and effort choices are a display order;
    // reordering them IS a real change and must surface as one.
    const a = candidate([model("nebula", { default: true }), model("quasar")]);
    const b = candidate([model("quasar"), model("nebula", { default: true })]);
    validateCandidate(a);
    validateCandidate(b);
    expect(catalogContentChecksum(a)).not.toBe(catalogContentChecksum(b));
  });

  it("a tied-record reordering cannot fake a reduction confirmation", async () => {
    const { store } = db();
    const binding = { agentId: "fake", location: "local" };
    const a = tied("alpha");
    const b = tied("beta");
    let order = [a, b];
    let rows = () => [
      model("nebula", { default: true, evidence: order }),
      model("quasar", { evidence: order }),
    ];
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], scope: () => SCOPE, fetch: async () => candidate(rows()),
    });
    await service.refresh(binding);
    rows = () => [model("nebula", { default: true, evidence: order })];
    expect((await service.refresh(binding)).result).toBe("quarantined");
    // Same reduction, evidence delivered in the opposite order: still the SAME
    // observation, so it confirms rather than resetting the gate.
    order = [b, a];
    expect((await service.refresh(binding)).result).toBe("published");
    store.close();
  });
});

describe("#236 provenance reaches the REAL status and audit outputs", () => {
  const described = () => model("nebula", {
    default: true,
    description: "The outlier flagship.",
    evidence: [evidence({
      kind: "verified-record",
      source: "operator-verification",
      resolvedModel: "vendor::nebula@2026",
      note: "proven out of band",
    })],
  });

  const configDescription = () => ({
    sessionId: "discord:t1", channelRef: "t1", parentRef: "c1",
    agent: { value: "fake", source: "default" as const },
    model: { value: "nebula", source: "default" as const },
    effort: { value: "default", source: "default" as const },
    cwd: { value: "/repo", source: "default" as const },
    permission: { value: "ask", source: "default" as const },
    locked: false,
    detached: { value: false, source: "default" as const },
    tts: { value: false, source: "default" as const },
    ttsVoice: { value: null, source: "default" as const },
    ttsPace: { value: "natural" as const, source: "default" as const },
    ttsStyle: { value: "neutral" as const, source: "default" as const },
    location: { value: "local", source: "default" as const },
    catalog: {
      state: "ready" as const, generation: 7, source: "fake-adapter-probe",
      fetchedAt: "2026-09-09T00:00:00.000Z",
      model: {
        id: "nebula",
        description: "The outlier flagship.",
        evidence: described().evidence!,
      },
    },
  });

  it("the REAL status DTO carries it, and the REAL renderer displays it", async () => {
    const { TurnStatus, renderStatusPanel } = await import("../packages/core/src/core/status-panel.js");
    const { discordRenderer } = await import("../packages/core/src/platforms/discord/renderer.js");
    const { renderCatalogEvidenceLines } = await import("../packages/core/src/core/catalog-evidence-render.js");
    const d = configDescription();

    // Exactly what the orchestrator constructs for a turn.
    const status = new TurnStatus({
      model: d.model.value,
      repoDisplay: "repo",
      ...(d.catalog.model.description ? { modelDescription: d.catalog.model.description } : {}),
      ...(d.catalog.model.evidence.length
        ? { modelEvidence: renderCatalogEvidenceLines(d.catalog.model.evidence) }
        : {}),
    });
    const input = status.toInput();
    expect(input.modelDescription).toBe("The outlier flagship.");
    expect(input.modelEvidence?.[0]).toContain("verified-record via operator-verification");

    // …and the real renderer turns that DTO into a real panel.
    const panel = renderStatusPanel(discordRenderer, { ...input, action: "Working" }, Date.now());
    const rendered = JSON.stringify(panel);
    expect(rendered).toContain("Model info");
    expect(rendered).toContain("The outlier flagship.");
    expect(rendered).toContain("resolved vendor::nebula@2026");
  });

  it("the REAL config-audit snapshot serializes it", async () => {
    const { ConfigMutationService } = await import("../packages/core/src/core/config-mutation.js");
    const snapshot = (
      ConfigMutationService.prototype as unknown as {
        effectiveSnapshot(this: unknown, d: unknown): Record<string, unknown>;
      }
    ).effectiveSnapshot.call({}, configDescription());
    // The audit row must say which generation a configuration was decided
    // against, and why the model row says what it says.
    const catalog = snapshot.catalog as Record<string, unknown>;
    expect(catalog).toMatchObject({ state: "ready", generation: 7, source: "fake-adapter-probe" });
    const auditModel = catalog.model as Record<string, unknown>;
    expect(auditModel).toMatchObject({ id: "nebula", description: "The outlier flagship." });
    expect((auditModel.evidence as string[])[0]).toContain("verified-record via operator-verification");
    // It must survive the JSON serialization the audit trail actually persists.
    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    expect(JSON.stringify(roundTripped.catalog)).toContain("proven out of band");
  });

  it("status and audit rendering stay bounded and secret-safe", async () => {
    const { renderCatalogEvidenceLines, CATALOG_EVIDENCE_RENDER_MAX_LINES, CATALOG_EVIDENCE_RENDER_MAX_CHARS } =
      await import("../packages/core/src/core/catalog-evidence-render.js");
    const many = Array.from({ length: 8 }, (_, i) =>
      evidence({ source: `probe-${i}`, note: "a".repeat(180) })
    );
    const lines = renderCatalogEvidenceLines(many);
    expect(lines.length).toBeLessThanOrEqual(CATALOG_EVIDENCE_RENDER_MAX_LINES);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(CATALOG_EVIDENCE_RENDER_MAX_CHARS);
    // Everything rendered already passed the portable screen, so nothing
    // secret-shaped can be present to render in the first place.
    expect(() => validateCandidate(candidate([model("nebula", {
      default: true,
      evidence: [evidence({ note: "QA_SECRET=hunter2000" })],
    })]))).toThrow(/rejected content/);
  });
});
