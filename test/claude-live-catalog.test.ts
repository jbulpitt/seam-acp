/**
 * #232 — live-first direct-Anthropic Claude catalog with verified overlays.
 *
 * The measured shape this defends (zero-token probe, 2026-09-08, wrapper
 * 0.73.0): `claude-agent-acp` advertises exactly
 * `default, opus[1m], claude-fable-5-1[1m], sonnet, haiku`, while five reachable
 * JSONL-verified canonical models are ABSENT from that list. So neither a
 * live-only nor a static-only catalog is correct — hence live base + verified
 * overlay, merged by canonical identity.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_VERIFIED_OVERLAY,
  canonicalClaudeModelId,
  makeClaudeProfile,
  manifestCatalogSource,
  mergeClaudeCatalogModels,
  probeClaudeCatalog,
  resolveClaudeDefaultModel,
  type ClaudeCatalogProbe,
  type ClaudeProbedModel,
  claudeCredentialScope,
  overlayForCredentialScope,
  lookupClaudeNativeContextWindow,
} from "@seam/adapters";
import { validateCandidate } from "../packages/core/src/core/model-catalog/service.js";

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-claude-agent-acp.mjs", import.meta.url));

/** The real advertised list, measured on this subscription. */
const LIVE_ADVERTISED: ReadonlyArray<{ value: string; name: string }> = [
  { value: "default", name: "Default (recommended)" },
  { value: "opus[1m]", name: "Opus (1M context)" },
  { value: "claude-fable-5-1[1m]", name: "Fable" },
  { value: "sonnet", name: "Sonnet" },
  { value: "haiku", name: "Haiku" },
];

const FULL_EFFORT = ["default", "low", "medium", "high", "xhigh", "max"];

const probed = (over: Partial<ClaudeProbedModel> & { advertisedId: string }): ClaudeProbedModel => ({
  advertisedName: over.advertisedId,
  // The wrapper echoes an alias back unresolved; that is the measured default.
  resolvedValue: over.advertisedId,
  effortChoices: FULL_EFFORT,
  effortCurrent: "default",
  configIds: ["mode", "model", "effort"],
  ...over,
});

/** The measured live probe: every advertised model except haiku offers effort. */
function liveProbe(): ClaudeCatalogProbe {
  return {
    wrapperCurrentValue: "sonnet",
    models: LIVE_ADVERTISED.map((entry) =>
      probed({
        advertisedId: entry.value,
        advertisedName: entry.name,
        ...(entry.value === "haiku"
          ? { effortChoices: [], effortCurrent: null, configIds: ["mode", "model"] }
          : {}),
      })
    ),
  };
}

function directProfile(probe: () => Promise<ClaudeCatalogProbe>, over: Record<string, unknown> = {}) {
  return makeClaudeProfile({
    cliPath: "false",
    directAnthropic: true,
    defaultModel: "default",
    staticModels: [
      { modelId: "default", name: "Opus latest ⭐" },
      { modelId: "claude-fable-5-1", name: "Fable 5.1" },
      { modelId: "claude-opus-5", name: "Opus 5" },
      { modelId: "claude-opus-4-8", name: "Opus 4.8" },
      { modelId: "claude-opus-4-7", name: "Opus 4.7" },
      { modelId: "claude-fable-5", name: "Fable 5" },
      { modelId: "claude-sonnet-5", name: "Sonnet 5" },
    ],
    catalogProbe: probe,
    ...over,
  });
}

describe("#232 canonical identity", () => {
  it("folds a [1m] window variant of a canonical id onto the canonical id", () => {
    expect(canonicalClaudeModelId("claude-fable-5-1[1m]")).toBe("claude-fable-5-1");
    expect(canonicalClaudeModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
  });

  it("never mints the trap alias `opus` out of `opus[1m]`", () => {
    // The runbook records bare `opus` as fuzzy-resolving to a DIFFERENT family.
    // Stripping the suffix off an alias would invent an id nothing verified.
    expect(canonicalClaudeModelId("opus[1m]")).toBe("opus[1m]");
    expect(canonicalClaudeModelId("sonnet")).toBe("sonnet");
    expect(canonicalClaudeModelId("haiku")).toBe("haiku");
    expect(canonicalClaudeModelId("default")).toBe("default");
  });
});

describe("#232 direct Claude publishes the live list plus verified overlays", () => {
  it("publishes every advertised model with its own effort choices", async () => {
    const candidate = await directProfile(async () => liveProbe()).catalog.fetch();
    validateCandidate(candidate);
    expect(candidate.source).toBe("claude-acp-live+verified-overlay");

    const live = candidate.models.filter((model) =>
      model.evidence?.some((record) => record.kind === "live-observation"));
    expect(live.map((model) => model.id)).toEqual([
      "default",
      "opus[1m]",
      "claude-fable-5-1",
      "sonnet",
      "haiku",
    ]);
    // Per-model effort, measured in that model's own session — haiku advertises
    // none, so the picker must not offer it a level it will not honor.
    expect(candidate.models.find((m) => m.id === "sonnet")?.effort).toMatchObject({
      mechanism: "meta",
      selectionDefault: "default",
    });
    expect(candidate.models.find((m) => m.id === "sonnet")?.effort.choices.map((c) => c.id)).toEqual(FULL_EFFORT);
    expect(candidate.models.find((m) => m.id === "haiku")?.effort).toMatchObject({
      mechanism: "none",
      selectionDefault: "default",
    });
    expect(candidate.models.find((m) => m.id === "haiku")?.effort.choices.map((c) => c.id)).toEqual(["default"]);
  });

  it("keeps JSONL-verified models that ACP does not advertise, with explicit provenance", async () => {
    const candidate = await directProfile(async () => liveProbe()).catalog.fetch();
    const overlayIds = candidate.models
      .filter((model) =>
        model.evidence?.every((record) => record.kind === "verified-record") === true)
      .map((model) => model.id);
    expect(overlayIds).toEqual([
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-fable-5",
      "claude-sonnet-5",
    ]);
    const opus5 = candidate.models.find((model) => model.id === "claude-opus-5")!;
    const record = opus5.evidence![0]!;
    expect(record).toMatchObject({
      kind: "verified-record",
      source: "operator JSONL verification",
      runtimeVersion: "claude-agent-acp 0.73.0",
      resolvedModel: "claude-opus-5",
    });
    expect(record.observedAt).toContain("2026-09-02");
    expect(record.context).toMatchObject({ native: 1_000_000 });
    expect(record.effort?.choices).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(record.note).toContain("credential scope default");
    // Existing verified models keep their proven native window.
    expect(opus5.context).toEqual({ native: 1_000_000, maximum: 1_000_000, effective: 1_000_000 });
    expect(candidate.sourceVersion).toBe("overlay-v1");
  });

  it("merges by canonical identity without duplicating the [1m] variant", async () => {
    const candidate = await directProfile(async () => liveProbe()).catalog.fetch();
    const fable = candidate.models.filter((model) => model.id.startsWith("claude-fable-5-1"));
    expect(fable).toHaveLength(1);
    // Live wins for a model ACP does advertise; the raw advertised id survives
    // as an alias so a live reading still resolves.
    expect(fable[0]!.evidence?.[0]?.kind).toBe("live-observation");
    expect(fable[0]!.aliases).toEqual(["claude-fable-5-1[1m]"]);
    expect(fable[0]!.runtimeId).toBe("claude-fable-5-1");
    // …and its window still comes from the verified table, not the `[1m]` label.
    expect(fable[0]!.context.native).toBe(1_000_000);
    expect(new Set(candidate.models.map((m) => m.id)).size).toBe(candidate.models.length);
  });

  it("never invents a context window for a live model nothing verified", async () => {
    const candidate = await directProfile(async () => liveProbe()).catalog.fetch();
    for (const id of ["opus[1m]", "sonnet", "haiku"]) {
      expect(candidate.models.find((model) => model.id === id)?.context).toEqual({
        native: null,
        maximum: null,
        effective: null,
      });
    }
  });

  it("quotes the verified resolution for an alias ACP leaves unresolved", async () => {
    const candidate = await directProfile(async () => liveProbe()).catalog.fetch();
    const fallback = candidate.models.find((model) => model.id === "default")!;
    // Measured: the wrapper echoes `default` back at us. That is not a
    // resolution, so the LIVE record must not claim one — the separately
    // verified resolution stays its own second record instead of being
    // flattened into the live one.
    const live = fallback.evidence!.find((r) => r.kind === "live-observation")!;
    const verified = fallback.evidence!.find((r) => r.kind === "verified-record")!;
    expect(live.resolvedModel).toBeUndefined();
    expect(verified.resolvedModel).toBe("claude-opus-5");
    expect(verified.observedAt).toContain("2026-09-02");
    expect(fallback.context.native).toBe(1_000_000);
  });

  it("reports an unresolved alias plainly when no verified resolution exists", () => {
    const merged = mergeClaudeCatalogModels({
      probe: { wrapperCurrentValue: null, models: [probed({ advertisedId: "mystery" })] },
      overlay: [],
      nativeContextWindow: () => undefined,
      effortMechanism: "meta",
      credentialScope: "default",
    });
    expect(merged[0]!.evidence).toHaveLength(1);
    expect(merged[0]!.evidence![0]).toMatchObject({ kind: "live-observation" });
    expect(merged[0]!.evidence![0]!.resolvedModel).toBeUndefined();
    expect(merged[0]!.context).toEqual({ native: null, maximum: null, effective: null });
  });

  it("records a genuine live resolution when the wrapper reports one", () => {
    const merged = mergeClaudeCatalogModels({
      probe: {
        wrapperCurrentValue: null,
        models: [probed({ advertisedId: "default", resolvedValue: "claude-opus-6" })],
      },
      overlay: [],
      nativeContextWindow: () => undefined,
      effortMechanism: "meta",
      credentialScope: "default",
    });
    expect(merged[0]!.evidence![0]).toMatchObject({
      kind: "live-observation", resolvedModel: "claude-opus-6",
    });
  });
});

describe("#232 default and effort defaults are never borrowed from another session", () => {
  it("keeps the operator's configured default over the wrapper's current value", async () => {
    // The bare wrapper session came up on `sonnet`; adopting that would move
    // every new thread off the configured Opus default.
    const candidate = await directProfile(async () => liveProbe()).catalog.fetch();
    const defaults = candidate.models.filter((model) => model.default);
    expect(defaults.map((model) => model.id)).toEqual(["default"]);
  });

  it("honours a configured default that only the overlay supplies", async () => {
    const candidate = await directProfile(async () => liveProbe(), {
      defaultModel: "claude-opus-4-8",
    }).catalog.fetch();
    validateCandidate(candidate);
    expect(candidate.models.filter((model) => model.default).map((model) => model.id)).toEqual([
      "claude-opus-4-8",
    ]);
  });

  it("REFUSES to mint a default from list order", () => {
    const models = mergeClaudeCatalogModels({
      probe: liveProbe(),
      overlay: [],
      nativeContextWindow: () => undefined,
      effortMechanism: "meta",
      credentialScope: "default",
    });
    // An unresolved configured default fails candidate construction, so the
    // service retains the previous generation. Selecting whichever model the
    // wrapper happened to advertise first is exactly the silent mis-selection
    // this replaced.
    expect(() => resolveClaudeDefaultModel(models, "claude-not-real"))
      .toThrow(/is not published by this catalog/);
    expect(() => resolveClaudeDefaultModel(models.filter((m) => m.modelId !== "default"), "nope"))
      .toThrow(/is not published by this catalog/);
    // A configured id that IS published resolves, and so does a declared alias.
    expect(resolveClaudeDefaultModel(models, "default")).toBe("default");
    expect(resolveClaudeDefaultModel(
      [{ modelId: "canonical", name: "C", aliases: ["recommended"] }],
      "recommended"
    )).toBe("canonical");
    expect(() => resolveClaudeDefaultModel(
      [
        { modelId: "one", name: "One", aliases: ["shared"] },
        { modelId: "two", name: "Two", aliases: ["shared"] },
      ],
      "shared"
    )).toThrow(/ambiguous/);
  });

  it("takes each model's effort default from its OWN session", () => {
    const merged = mergeClaudeCatalogModels({
      probe: {
        wrapperCurrentValue: "a",
        models: [
          probed({ advertisedId: "a", effortChoices: FULL_EFFORT, effortCurrent: "max" }),
          probed({ advertisedId: "b", effortChoices: ["default", "low"], effortCurrent: "low" }),
        ],
      },
      overlay: [],
      nativeContextWindow: () => undefined,
      effortMechanism: "meta",
      credentialScope: "default",
    });
    expect(merged[0]!.effort?.selectionDefault).toBe("max");
    expect(merged[1]!.effort?.selectionDefault).toBe("low");
    expect(merged[1]!.effort?.choices).toEqual(["default", "low"]);
  });

  it("ignores an advertised effort default the same model does not offer", () => {
    const merged = mergeClaudeCatalogModels({
      probe: {
        wrapperCurrentValue: "a",
        models: [probed({ advertisedId: "a", effortChoices: ["default", "low"], effortCurrent: "max" })],
      },
      overlay: [],
      nativeContextWindow: () => undefined,
      effortMechanism: "meta",
      credentialScope: "default",
    });
    expect(merged[0]!.effort?.selectionDefault).toBe("default");
  });
});

describe("#232 scope, determinism, and failure handling", () => {
  it("is deterministic: an unchanged wrapper and overlay produce an identical candidate", async () => {
    const profile = directProfile(async () => liveProbe());
    const [a, b] = await Promise.all([profile.catalog.fetch(), profile.catalog.fetch()]);
    expect(JSON.stringify(a!.models)).toBe(JSON.stringify(b!.models));
  });

  it("gives an additional direct credential profile its own scope but the same strategy", async () => {
    const base = await directProfile(async () => liveProbe()).catalog.fetch();
    const alternate = await directProfile(async () => liveProbe(), {
      id: "claude-work",
      configDir: "/credentials/work",
    }).catalog.fetch();
    expect(base.scope.fingerprint).not.toBe(alternate.scope.fingerprint);
    expect(alternate.scope.credentialProfile).toBe("/credentials/work");
    expect(alternate.scope.provider).toBe("anthropic");
    expect(alternate.source).toBe("claude-acp-live+verified-overlay");
    // FAIL CLOSED on credential scope. The overlay was verified on the DEFAULT
    // credential set, so an alternate credential profile does NOT inherit it:
    // it publishes only what its own live probe advertised. Asserting the two
    // profiles publish the same identities is exactly what let borrowed
    // evidence look like an independently scoped snapshot.
    expect(alternate.models.map((m) => m.id)).toEqual([
      "default", "opus[1m]", "claude-fable-5-1", "sonnet", "haiku",
    ]);
    expect(base.models.map((m) => m.id)).toEqual([
      "default", "opus[1m]", "claude-fable-5-1", "sonnet", "haiku",
      "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5", "claude-sonnet-5",
    ]);
    // No row on the alternate profile carries evidence captured elsewhere.
    for (const model of alternate.models) {
      for (const record of model.evidence ?? []) {
        expect(record.kind).toBe("live-observation");
      }
    }
  });

  it("throws on probe failure so the service retains the previous generation", async () => {
    const profile = directProfile(async () => {
      throw new Error("claude-agent-acp exited early (code=3)");
    });
    await expect(profile.catalog.fetch()).rejects.toThrow(/exited early/);
  });

});

describe("#232 deferred backends do not inherit the direct catalog", () => {
  const shouldNotProbe = async (): Promise<ClaudeCatalogProbe> => {
    throw new Error("deferred backend must not run the direct-Anthropic probe");
  };

  it("leaves Vertex on the validated manifest", async () => {
    const candidate = await makeClaudeProfile({
      id: "claude-vertex",
      brand: "vertex",
      cliPath: "false",
      defaultModel: "claude-opus-5",
      staticModels: [{ modelId: "claude-opus-5", name: "Opus 5" }],
      catalogProbe: shouldNotProbe,
      extraEnv: {
        CLAUDE_CODE_USE_VERTEX: "1",
        ANTHROPIC_VERTEX_PROJECT_ID: "project-7",
        CLOUD_ML_REGION: "us-east5",
      },
    }).catalog.fetch();
    validateCandidate(candidate);
    expect(candidate.source).toBe("validated-manifest");
    expect(candidate.models.map((model) => model.id)).toEqual(["claude-opus-5"]);
    expect(candidate.models.every((model) => model.provenance === undefined)).toBe(true);
  });

  it("leaves Z.ai and other compatible backends on the validated manifest", async () => {
    const candidate = await makeClaudeProfile({
      id: "zai",
      brand: "z-ai",
      cliPath: "false",
      defaultModel: "glm-5.2",
      staticModels: [{ modelId: "glm-5.2", name: "GLM 5.2", contextLimit: 1_000_000 }],
      effort: { mechanism: "none", levels: [] },
      catalogProbe: shouldNotProbe,
      extraEnv: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
    }).catalog.fetch();
    validateCandidate(candidate);
    expect(candidate.source).toBe("validated-manifest");
    expect(candidate.models.map((model) => model.id)).toEqual(["glm-5.2"]);
    // No Anthropic overlay leaked into a non-Anthropic backend.
    for (const entry of CLAUDE_VERIFIED_OVERLAY) {
      expect(candidate.models.some((model) => model.id === entry.modelId)).toBe(false);
    }
  });
});

describe("#232 probe isolation against a fake ACP agent", () => {
  let dir: string;
  let log: string;

  const baseEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    FAKE_ACP_LOG: log,
    FAKE_ACP_MODELS: JSON.stringify(LIVE_ADVERTISED),
    FAKE_ACP_CURRENT: "sonnet",
    FAKE_ACP_EFFORT: JSON.stringify({
      default: FULL_EFFORT,
      "opus[1m]": FULL_EFFORT,
      "claude-fable-5-1[1m]": FULL_EFFORT,
      "claude-fable-5-1": FULL_EFFORT,
      sonnet: FULL_EFFORT,
    }),
    ...over,
  });

  const records = () =>
    fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  /** One record per spawned wrapper process (the startup line). */
  const invocations = () => records().filter((row) => "anthropicModel" in row);
  /** Every JSON-RPC method the probe actually sent. */
  const methods = () => records().filter((row) => row.method !== undefined).map((row) => row.method);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-232-"));
    log = path.join(dir, "acp.log");
    fs.writeFileSync(log, "");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("opens one FRESH process per advertised model and cleans every one up", async () => {
    const probe = await probeClaudeCatalog({
      cliPath: FAKE_ACP,
      cwd: dir,
      env: baseEnv(),
      // Mirrors the profile's spawn(): canonical ids are forwarded, aliases are not.
      modelEnv: (modelId) =>
        /^claude-[a-z]+-\d/.test(modelId) ? baseEnv({ ANTHROPIC_MODEL: modelId }) : baseEnv(),
      timeoutMs: 20_000,
      concurrency: 2,
    });
    expect(probe.models.map((model) => model.advertisedId)).toEqual(
      LIVE_ADVERTISED.map((entry) => entry.value)
    );
    const runs = invocations();
    // 5 advertised models, minus the one the bare session already came up on.
    expect(runs).toHaveLength(LIVE_ADVERTISED.length);
    expect(new Set(runs.map((run) => run.pid)).size).toBe(runs.length);
    // Canonical ids are forwarded through ANTHROPIC_MODEL exactly as runtime spawn does.
    // CANONICAL identity — the value a real catalog selection spawns with, not
    // the raw advertised `claude-fable-5-1[1m]` that never reaches a turn.
    expect(runs.map((run) => run.anthropicModel).filter(Boolean)).toEqual(["claude-fable-5-1"]);
    // Nothing is left running — cleanup waits for each child to be reaped.
    for (const run of runs) {
      expect(() => process.kill(run.pid, 0)).toThrow();
    }
  });

  it("spends no model tokens: it never sends session/prompt", async () => {
    await probeClaudeCatalog({
      cliPath: FAKE_ACP,
      cwd: dir,
      env: baseEnv(),
      modelEnv: () => baseEnv(),
      timeoutMs: 20_000,
    });
    const sent = methods();
    expect(sent).not.toContain("session/prompt");
    expect(sent.filter((method) => method === "session/new")).toHaveLength(LIVE_ADVERTISED.length);
    expect(new Set(sent)).toEqual(
      new Set(["initialize", "session/new", "session/set_config_option", "session/close"])
    );
  });

  it("selects at most ONE model per fresh session", async () => {
    // The isolation rule is not "never select" — an alias is not selected by the
    // environment, so a session that never selects it reports the wrapper's own
    // model under the alias's name. The rule is that no session ever holds two
    // models, so one model's state can never decide another's advertised default.
    await probeClaudeCatalog({
      cliPath: FAKE_ACP,
      cwd: dir,
      env: baseEnv(),
      modelEnv: (modelId) =>
        /^claude-[a-z]+-\d/.test(modelId) ? baseEnv({ ANTHROPIC_MODEL: modelId }) : baseEnv(),
      timeoutMs: 20_000,
    });
    const selectionsByPid = new Map<number, string[]>();
    for (const row of records().filter((entry) => entry.selected !== undefined)) {
      selectionsByPid.set(row.pid, [...(selectionsByPid.get(row.pid) ?? []), row.selected]);
    }
    for (const [, selected] of selectionsByPid) expect(selected).toHaveLength(1);
    // Every advertised model is observed, each under its own identity.
    // `claude-fable-5-1[1m]` needs NO explicit select: its environment forwards
    // the CANONICAL id, the session therefore comes up already on
    // `claude-fable-5-1`, and the canonical id is exactly what the published
    // runtime binding uses. Selecting the suffixed advertisement instead would
    // measure a selection runtime never performs. The aliases still need one,
    // because the environment does not select them.
    expect([...selectionsByPid.values()].flat().sort()).toEqual(
      ["default", "haiku", "opus[1m]"].sort()
    );
  });

  it("reports each alias's OWN capabilities, not the wrapper's starting model", async () => {
    // Regression: the wrapper starts on `sonnet`. Before the explicit select,
    // `default`/`opus[1m]`/`haiku` all published sonnet's effort list and
    // sonnet's resolution under their own names.
    const probe = await probeClaudeCatalog({
      cliPath: FAKE_ACP,
      cwd: dir,
      env: baseEnv({
        FAKE_ACP_EFFORT: JSON.stringify({
          default: FULL_EFFORT,
          "opus[1m]": ["default", "high"],
          sonnet: FULL_EFFORT,
          // haiku deliberately advertises no effort option at all.
        }),
      }),
      modelEnv: () => baseEnv({
        FAKE_ACP_EFFORT: JSON.stringify({
          default: FULL_EFFORT,
          "opus[1m]": ["default", "high"],
          sonnet: FULL_EFFORT,
        }),
      }),
      timeoutMs: 20_000,
    });
    const byId = new Map(probe.models.map((model) => [model.advertisedId, model]));
    expect(byId.get("default")!.resolvedValue).toBe("default");
    expect(byId.get("opus[1m]")!.resolvedValue).toBe("opus[1m]");
    expect(byId.get("opus[1m]")!.effortChoices).toEqual(["default", "high"]);
    expect(byId.get("haiku")!.effortChoices).toEqual([]);
    expect(byId.get("sonnet")!.effortChoices).toEqual(FULL_EFFORT);
  });

  it("records the bare session's current value without adopting it as a default", async () => {
    const probe = await probeClaudeCatalog({
      cliPath: FAKE_ACP,
      cwd: dir,
      env: baseEnv(),
      timeoutMs: 20_000,
    });
    expect(probe.wrapperCurrentValue).toBe("sonnet");
    const models = mergeClaudeCatalogModels({
      probe,
      overlay: CLAUDE_VERIFIED_OVERLAY,
      nativeContextWindow: () => undefined,
      effortMechanism: "meta",
      credentialScope: "default",
    });
    expect(resolveClaudeDefaultModel(models, "default")).toBe("default");
  });

  it("carries the profile's credential scope into the probe environment", async () => {
    await probeClaudeCatalog({
      cliPath: FAKE_ACP,
      cwd: dir,
      env: baseEnv({ CLAUDE_CONFIG_DIR: "/credentials/work" }),
      modelEnv: () => baseEnv({ CLAUDE_CONFIG_DIR: "/credentials/work" }),
      timeoutMs: 20_000,
    });
    expect(invocations().every((run) => run.configDir === "/credentials/work")).toBe(true);
  });

  it("propagates a wrapper that cannot start, rather than publishing a guess", async () => {
    await expect(
      probeClaudeCatalog({
        cliPath: FAKE_ACP,
        cwd: dir,
        env: baseEnv({ FAKE_ACP_FAIL: "1" }),
        timeoutMs: 20_000,
      })
      // The wrapper's own stderr must reach the operator; a bare
      // "ACP connection closed" is undiagnosable in a refresh log.
    ).rejects.toMatchObject({ code: "exited_early" });
  });

  it("refuses a wrapper that advertises no models at all", async () => {
    await expect(
      probeClaudeCatalog({
        cliPath: FAKE_ACP,
        cwd: dir,
        env: baseEnv({ FAKE_ACP_MODELS: "[]" }),
        timeoutMs: 20_000,
      })
    ).rejects.toThrow(/advertised no model|empty model list/);
  });
});

describe("#232 overlay evidence is scoped to the credential set that proved it", () => {
  it("publishes an overlay entry only on its verified credential scope", () => {
    const onDefault = mergeClaudeCatalogModels({
      probe: liveProbe(),
      overlay: CLAUDE_VERIFIED_OVERLAY,
      nativeContextWindow: lookupClaudeNativeContextWindow,
      effortMechanism: "meta",
      credentialScope: "default",
    });
    const onConfigured = mergeClaudeCatalogModels({
      probe: liveProbe(),
      overlay: CLAUDE_VERIFIED_OVERLAY,
      nativeContextWindow: lookupClaudeNativeContextWindow,
      effortMechanism: "meta",
      credentialScope: "configured",
    });
    expect(onDefault.length).toBeGreaterThan(onConfigured.length);
    // Every overlay-only identity is absent from the non-matching scope.
    for (const entry of CLAUDE_VERIFIED_OVERLAY) {
      if (LIVE_ADVERTISED.some((live) => live.value.startsWith(entry.modelId))) continue;
      expect(onConfigured.some((model) => model.modelId === entry.modelId)).toBe(false);
    }
  });

  it("maps a config directory to a non-default, non-path credential scope", () => {
    expect(claudeCredentialScope(undefined)).toBe("default");
    expect(claudeCredentialScope("   ")).toBe("default");
    const scoped = claudeCredentialScope("/home/ubuntu/.claude-work");
    expect(scoped).not.toBe("default");
    // Never a filesystem path: a scope identity must not carry one into evidence.
    expect(scoped).not.toContain("/");
    expect(scoped).not.toContain("home");
  });

  it("filters purely by recorded scope, with no near-miss rule", () => {
    const entry = CLAUDE_VERIFIED_OVERLAY[0]!;
    expect(overlayForCredentialScope([entry], entry.credentialScope)).toEqual([entry]);
    expect(overlayForCredentialScope([entry], "configured")).toEqual([]);
    expect(overlayForCredentialScope([entry], "")).toEqual([]);
  });
});

describe("#232 the probe uses the shared bounded lifecycle", () => {
  let dir: string;
  let log: string;
  const baseEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    FAKE_ACP_LOG: log,
    FAKE_ACP_MODELS: JSON.stringify(LIVE_ADVERTISED),
    FAKE_ACP_CURRENT: "sonnet",
    FAKE_ACP_EFFORT: JSON.stringify({ sonnet: FULL_EFFORT }),
    ...over,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-232-life-"));
    log = path.join(dir, "acp.log");
    fs.writeFileSync(log, "");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const pids = (): number[] => [
    ...new Set(
      fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { pid?: number })
        .flatMap((row) => (typeof row.pid === "number" ? [row.pid] : []))
    ),
  ];
  const gone = (pid: number): boolean => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  };

  it("bounds a wrapper that never answers session/close and still reaps it", async () => {
    // The blocker: success cleanup awaited closeSession() with no timeout, so a
    // wrapper that stays alive but never replies could hang refresh and the
    // shutdown drain indefinitely.
    // ONE advertised model: each unanswered close costs the helper's bounded
    // close window, so the point is that it terminates at all, not how many
    // windows a five-model fixture would serialize.
    const single = JSON.stringify([{ value: "sonnet", name: "Sonnet" }]);
    const env = () => baseEnv({ FAKE_ACP_SILENT_CLOSE: "1", FAKE_ACP_MODELS: single });
    const started = Date.now();
    await probeClaudeCatalog({
      cliPath: FAKE_ACP,
      cwd: dir,
      env: env(),
      modelEnv: env,
      timeoutMs: 20_000,
      concurrency: 1,
    });
    // Bounded by the shared helper's close window, not by the wrapper: without
    // the bound this never returns at all.
    expect(Date.now() - started).toBeLessThan(20_000);
    for (const pid of pids()) expect(gone(pid)).toBe(true);
  }, 30_000);

  it("cancels through an AbortSignal and leaves no wrapper behind", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    await expect(
      probeClaudeCatalog({
        cliPath: FAKE_ACP,
        cwd: dir,
        env: baseEnv({ FAKE_ACP_SILENT_INIT: "1" }),
        modelEnv: () => baseEnv({ FAKE_ACP_SILENT_INIT: "1" }),
        timeoutMs: 20_000,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const pid of pids()) expect(gone(pid)).toBe(true);
  });

  it("times out a wrapper that never answers initialize, bounded", async () => {
    const started = Date.now();
    await expect(
      probeClaudeCatalog({
        cliPath: FAKE_ACP,
        cwd: dir,
        env: baseEnv({ FAKE_ACP_SILENT_INIT: "1" }),
        modelEnv: () => baseEnv({ FAKE_ACP_SILENT_INIT: "1" }),
        timeoutMs: 150,
      })
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const pid of pids()) expect(gone(pid)).toBe(true);
  });

  it("retains no private lifecycle: no spawn, timers, or reap in the collector", () => {
    const source = fs.readFileSync(
      new URL("../packages/adapters/src/profiles/claude-catalog.ts", import.meta.url),
      "utf8"
    );
    // The whole point of consuming the shared helper is that there is no second
    // implementation of bounding/cleanup here to drift from it.
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("function reap");
    expect(source).not.toContain("probeTimeout");
    expect(source).toContain("runBoundedProbe");
  });
});

describe("#232 QA fixtures — direct regressions", () => {
  /** QA blocker 1: default-scope context relabeled as alternate live evidence. */
  it("an unresolved alias on an ALTERNATE scope has null context and no borrowed window", () => {
    const probe: ClaudeCatalogProbe = {
      wrapperCurrentValue: "sonnet",
      models: [probed({ advertisedId: "default", advertisedName: "Default" })],
    };
    const merged = mergeClaudeCatalogModels({
      probe,
      overlay: CLAUDE_VERIFIED_OVERLAY,
      effortMechanism: "meta",
      credentialScope: "configured",
      scopeRef: "a".repeat(64),
    });
    const row = merged[0]!;
    // The QA reproduction emitted context.native = 1_000_000 here, sourced from
    // the DEFAULT account's verification table, inside a live-observation
    // carrying the alternate scopeRef.
    expect(row.context).toEqual({ native: null, maximum: null, effective: null });
    expect(row.contextLimit).toBeUndefined();
    for (const record of row.evidence ?? []) {
      expect(record.kind).toBe("live-observation");
      // A live ACP session reports no window; attaching one would attribute a
      // verified-record fact to a live observation.
      expect(record.context).toBeUndefined();
    }
    expect(JSON.stringify(row)).not.toContain("1000000");
  });

  it("the SAME probe on the matching scope still carries its verified window", () => {
    const probe: ClaudeCatalogProbe = {
      wrapperCurrentValue: "sonnet",
      models: [probed({ advertisedId: "default", advertisedName: "Default" })],
    };
    const merged = mergeClaudeCatalogModels({
      probe,
      overlay: CLAUDE_VERIFIED_OVERLAY,
      effortMechanism: "meta",
      credentialScope: "default",
      scopeRef: "b".repeat(64),
    });
    expect(merged[0]!.context.native).toBe(1_000_000);
    // …and the window is attributed to the record that established it.
    const verified = merged[0]!.evidence!.find((r) => r.kind === "verified-record")!;
    expect(verified.context?.native).toBe(1_000_000);
    const live = merged[0]!.evidence!.find((r) => r.kind === "live-observation")!;
    expect(live.context).toBeUndefined();
  });

  /** QA blocker 2: discovery selected a value runtime never uses. */
  it("discovery selects exactly the value the published runtime binding uses", async () => {
    const probe: ClaudeCatalogProbe = {
      wrapperCurrentValue: "sonnet",
      models: [probed({ advertisedId: "claude-fable-5-1[1m]", advertisedName: "Fable" })],
    };
    const models = mergeClaudeCatalogModels({
      probe, overlay: [], effortMechanism: "meta", credentialScope: "default",
    });
    const candidate = await manifestCatalogSource({
      provider: "anthropic",
      defaultModel: models[0]!.modelId,
      models: () => models,
      adapterVersion: 4,
    }).fetch();
    const published = candidate.models[0]!;
    // The binding runtime spawns and setModel()s with.
    expect(published.runtimeId).toBe("claude-fable-5-1");
    expect(published.bindings[0]!.rawModel).toBe("claude-fable-5-1");
    // The raw advertisement stays resolvable as an alias, but is not the
    // selection identity.
    expect(published.aliases).toEqual(["claude-fable-5-1[1m]"]);
    expect(canonicalClaudeModelId("claude-fable-5-1[1m]")).toBe(published.runtimeId);
  });

  /** QA blocker 3: clean code-0 teardown reclassified as a failure. */
  it("a clean code-0 exit during completion is NOT exited_early", async () => {
    const { runBoundedProbe } = await import("@seam/adapters");
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const emitter = new EventEmitter();
    const child = emitter as unknown as Record<string, unknown>;
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => emitter.emit("spawn"));

    const value = await runBoundedProbe<string>({
      executable: "x",
      spawnOverride: () => child as never,
      timeoutMs: 5_000,
      killGraceMs: 50,
      run: async () => {
        // A short-lived wrapper ends cleanly as part of ordinary teardown,
        // BEFORE the run's own resolution is delivered. The QA reproduction
        // turned this into `exited_early` and failed a successful probe.
        child.exitCode = 0;
        emitter.emit("exit", 0, null);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "collected";
      },
    });
    expect(value).toBe("collected");
  });

  it("an ABNORMAL exit is still exited_early", async () => {
    const { runBoundedProbe } = await import("@seam/adapters");
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const emitter = new EventEmitter();
    const child = emitter as unknown as Record<string, unknown>;
    child.pid = 4243;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => emitter.emit("spawn"));

    await expect(
      runBoundedProbe<string>({
        executable: "x",
        spawnOverride: () => child as never,
        timeoutMs: 5_000,
        killGraceMs: 50,
        run: async () => {
          child.exitCode = 7;
          emitter.emit("exit", 7, null);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return "unreachable";
        },
      })
    ).rejects.toMatchObject({ code: "exited_early" });
  });

  it("a wrapper that exits cleanly right after session/close still succeeds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-232-clean-"));
    try {
      const log = path.join(dir, "acp.log");
      fs.writeFileSync(log, "");
      const env = (): NodeJS.ProcessEnv => ({
        ...process.env,
        FAKE_ACP_LOG: log,
        FAKE_ACP_MODELS: JSON.stringify([{ value: "sonnet", name: "Sonnet" }]),
        FAKE_ACP_CURRENT: "sonnet",
        FAKE_ACP_EXIT_ON_CLOSE: "1",
        FAKE_ACP_EFFORT: JSON.stringify({ sonnet: FULL_EFFORT }),
      });
      const result = await probeClaudeCatalog({
        cliPath: FAKE_ACP, cwd: dir, env: env(), modelEnv: env, timeoutMs: 15_000,
      });
      expect(result.models.map((m) => m.advertisedId)).toEqual(["sonnet"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  /** QA blocker 3: fanout must cancel and drain siblings, under one deadline. */
  it("one worker failure cancels siblings and leaves no wrapper behind", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-232-fanout-"));
    try {
      const log = path.join(dir, "acp.log");
      fs.writeFileSync(log, "");
      const base = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
        ...process.env,
        FAKE_ACP_LOG: log,
        FAKE_ACP_MODELS: JSON.stringify(LIVE_ADVERTISED),
        FAKE_ACP_CURRENT: "sonnet",
        FAKE_ACP_EFFORT: JSON.stringify({ sonnet: FULL_EFFORT }),
        ...over,
      });
      await expect(
        probeClaudeCatalog({
          cliPath: FAKE_ACP,
          cwd: dir,
          env: base(),
          // Every per-model session refuses to start; the first failure must
          // abort the rest rather than leaving them running behind a rejection.
          modelEnv: () => base({ FAKE_ACP_FAIL: "1" }),
          timeoutMs: 5_000,
          concurrency: 2,
        })
      ).rejects.toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const pids = [...new Set(
        fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
          .map((line) => JSON.parse(line) as { pid?: number })
          .flatMap((row) => (typeof row.pid === "number" ? [row.pid] : []))
      )];
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * QA blocker 2 (this round): the FIRST rejection must abort in-flight
   * siblings immediately. Draining afterwards is not enough — a sibling that
   * never answers `initialize` would otherwise burn its whole session budget
   * before the shared abort is even raised.
   */
  it("a failing worker aborts a HUNG sibling promptly, not after its session budget", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-232-fanout-mixed-"));
    try {
      const log = path.join(dir, "acp.log");
      fs.writeFileSync(log, "");
      const base = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
        ...process.env,
        FAKE_ACP_LOG: log,
        FAKE_ACP_MODELS: JSON.stringify(LIVE_ADVERTISED),
        FAKE_ACP_CURRENT: "sonnet",
        FAKE_ACP_EFFORT: JSON.stringify({ sonnet: FULL_EFFORT }),
        ...over,
      });
      const sessionBudgetMs = 2_500;
      const started = Date.now();
      await expect(
        probeClaudeCatalog({
          cliPath: FAKE_ACP,
          cwd: dir,
          env: base(),
          // One worker dies at once; every other worker is MUTE and would
          // otherwise sit until its own timeout.
          modelEnv: (model) =>
            model === "default" ? base({ FAKE_ACP_FAIL: "1" }) : base({ FAKE_ACP_SILENT_INIT: "1" }),
          timeoutMs: sessionBudgetMs,
          overallTimeoutMs: 20_000,
          concurrency: 2,
        })
      ).rejects.toMatchObject({ code: "exited_early" });
      // The QA reproduction returned in 2614ms for a 2500ms hung sibling.
      expect(Date.now() - started).toBeLessThan(sessionBudgetMs);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const pids = [...new Set(
        fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
          .map((line) => JSON.parse(line) as { pid?: number })
          .flatMap((row) => (typeof row.pid === "number" ? [row.pid] : []))
      )];
      expect(pids.length).toBeGreaterThan(1);
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * QA blocker 1 (this round): the wrapper self-resolving `claude-fable-5-1[1m]`
   * to `claude-fable-5-1` must not cost the row the verified record that
   * established its 1M window. A live ACP session reports no window at all.
   */
  it("a SELF-RESOLVING live Fable row keeps the verified record behind its 1M window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-232-fable-"));
    try {
      const log = path.join(dir, "acp.log");
      fs.writeFileSync(log, "");
      const env = (): NodeJS.ProcessEnv => ({
        ...process.env,
        FAKE_ACP_LOG: log,
        // The installed shape: the wrapper comes up on `sonnet`, so Fable is
        // probed in its own session spawned with ANTHROPIC_MODEL=claude-fable-5-1
        // — which is exactly what makes the wrapper self-resolve its identity.
        FAKE_ACP_MODELS: JSON.stringify(LIVE_ADVERTISED),
        FAKE_ACP_CURRENT: "sonnet",
        FAKE_ACP_EFFORT: JSON.stringify({ sonnet: FULL_EFFORT, "claude-fable-5-1": FULL_EFFORT }),
      });
      const probe = await probeClaudeCatalog({
        cliPath: FAKE_ACP, cwd: dir, env: env(), modelEnv: env, timeoutMs: 15_000,
      });
      const fable = probe.models.find((model) => model.advertisedId === "claude-fable-5-1[1m]")!;
      // The precondition the QA reproduction hit on the installed wrapper.
      expect(fable.resolvedValue).toBe("claude-fable-5-1");
      const merged = mergeClaudeCatalogModels({
        probe,
        overlay: CLAUDE_VERIFIED_OVERLAY,
        effortMechanism: "meta",
        credentialScope: "default",
        scopeRef: "c".repeat(64),
      });
      const row = merged.find((model) => model.modelId === "claude-fable-5-1")!;
      expect(row.context.native).toBe(1_000_000);
      // A live-observation alone must never substantiate a 1M window.
      const verified = row.evidence!.find((record) => record.kind === "verified-record");
      expect(verified?.context).toEqual({ native: 1_000_000, method: "runbook-verified" });
      const live = row.evidence!.find((record) => record.kind === "live-observation")!;
      expect(live.context).toBeUndefined();
      expect(live.resolvedModel).toBe("claude-fable-5-1");
      // The whole-catalog invariant, not just this row: a published window is
      // always attributable to the verified record that established it.
      for (const model of merged) {
        if (model.context.native === null) continue;
        expect(
          model.evidence!.some(
            (record) => record.kind === "verified-record" && record.context?.native === model.context.native
          )
        ).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("enforces ONE catalog-wide deadline across concurrency waves", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-232-deadline-"));
    try {
      const log = path.join(dir, "acp.log");
      fs.writeFileSync(log, "");
      const env = (): NodeJS.ProcessEnv => ({
        ...process.env,
        FAKE_ACP_LOG: log,
        FAKE_ACP_MODELS: JSON.stringify(LIVE_ADVERTISED),
        FAKE_ACP_CURRENT: "sonnet",
        FAKE_ACP_SILENT_INIT: "1",
      });
      const started = Date.now();
      await expect(
        probeClaudeCatalog({
          cliPath: FAKE_ACP, cwd: dir, env: env(), modelEnv: env,
          // A per-session budget alone would restart for every model; the
          // catalog deadline is what bounds the whole collection.
          timeoutMs: 10_000,
          overallTimeoutMs: 400,
          concurrency: 1,
        })
      ).rejects.toBeTruthy();
      expect(Date.now() - started).toBeLessThan(9_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
