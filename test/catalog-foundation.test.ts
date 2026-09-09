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
    expect(bad({ source: "" })).toThrow(/source must be bounded/);
    expect(bad({ observedAt: "not-a-time" })).toThrow(/observedAt must be a timestamp/);
    expect(bad({ adapterVersion: 0 })).toThrow(/adapterVersion/);
    expect(bad({ context: { native: -5 } })).toThrow(/context.native/);
    expect(bad({ effort: { choices: ["a", "a"] } })).toThrow(/effort.choices/);
    expect(bad({ note: "x".repeat(CATALOG_EVIDENCE_TEXT_MAX + 1) })).toThrow(/note must be bounded/);
    expect(() => validateCandidate(candidate([model("nebula", {
      default: true,
      evidence: Array.from({ length: CATALOG_EVIDENCE_MAX_RECORDS + 1 }, () => evidence()),
    })]))).toThrow(/more than/);
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

  it("tolerates unknown future evidence fields without corrupting the row", () => {
    const forward = model("nebula", {
      default: true,
      evidence: [{ ...evidence(), somethingNewInV2: { nested: true } } as unknown as CatalogModelEvidence],
    });
    expect(() => validateCandidate(candidate([forward]))).not.toThrow();
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
    // A same-size swap keeps coverage and is not the shape of a partial fetch.
    expect(assessCatalogReduction(ids(["a", "b"]), ids(["a", "c"]))).toBeNull();
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
