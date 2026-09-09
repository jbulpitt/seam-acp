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
  mergeClaudeCatalogModels,
  probeClaudeCatalog,
  resolveClaudeDefaultModel,
  type ClaudeCatalogProbe,
  type ClaudeProbedModel,
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

    const live = candidate.models.filter((model) => model.provenance?.startsWith("acp-live"));
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
      .filter((model) => model.provenance?.startsWith("verified-overlay"))
      .map((model) => model.id);
    expect(overlayIds).toEqual([
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-fable-5",
      "claude-sonnet-5",
    ]);
    const opus5 = candidate.models.find((model) => model.id === "claude-opus-5")!;
    expect(opus5.provenance).toContain("verified-overlay");
    expect(opus5.provenance).toContain("absent from ACP");
    expect(opus5.provenance).toContain("resolved=claude-opus-5");
    expect(opus5.provenance).toContain("verified 2026-09-02");
    expect(opus5.provenance).toContain("claude-agent-acp 0.73.0");
    expect(opus5.provenance).toContain("credential scope default");
    expect(opus5.provenance).toContain("effort [default,low,medium,high,xhigh,max]");
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
    expect(fable[0]!.provenance).toContain("acp-live");
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
    // resolution, so the row must not claim one of its own.
    expect(fallback.provenance).toContain("resolution unverified live");
    expect(fallback.provenance).toContain("latest verified claude-opus-5");
    expect(fallback.provenance).toContain("verified 2026-09-02");
    expect(fallback.context.native).toBe(1_000_000);
  });

  it("reports an unresolved alias plainly when no verified resolution exists", () => {
    const merged = mergeClaudeCatalogModels({
      probe: { wrapperCurrentValue: null, models: [probed({ advertisedId: "mystery" })] },
      overlay: [],
      nativeContextWindow: () => undefined,
      effortMechanism: "meta",
    });
    expect(merged[0]!.provenance).toBe("acp-live; resolution unverified");
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
    });
    expect(merged[0]!.provenance).toBe("acp-live; resolved=claude-opus-6");
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

  it("falls back deterministically when the configured default is absent", () => {
    const models = mergeClaudeCatalogModels({
      probe: liveProbe(),
      overlay: [],
      nativeContextWindow: () => undefined,
      effortMechanism: "meta",
    });
    expect(resolveClaudeDefaultModel(models, "claude-not-real")).toBe("default");
    expect(resolveClaudeDefaultModel(models.filter((m) => m.modelId !== "default"), "nope")).toBe("opus[1m]");
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
    expect(alternate.models.map((m) => m.id)).toEqual(base.models.map((m) => m.id));
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
    expect(runs.map((run) => run.anthropicModel).filter(Boolean)).toEqual(["claude-fable-5-1[1m]"]);
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
    ).rejects.toThrow(/refusing to start/);
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
