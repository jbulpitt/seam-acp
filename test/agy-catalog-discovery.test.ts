/**
 * #260 (R4a) — the native catalog is discovered without starting a model turn.
 *
 * Three probes used to run `agy -p ok`, a real turn against a real model, none
 * of them visible at the call site:
 *
 *   fetchAgyCatalog          `-p ok --print-timeout 30s`, then GetAvailableModels
 *   fetchAgyAcceptedModels   `-p ok --model __seam_probe_invalid__`
 *   fetchAgyUserStatus       the same LS boot, on the quota path (#345)
 *
 * `getCatalog` ran the first two on every cold catalog and intersected them:
 * two model turns to learn a list of models. `agy models` answers both
 * questions at once, exits 0, and spends nothing.
 *
 * The first test here is the one that matters. It does not merely refrain from
 * prompting — it records every argv the CLI is invoked with and asserts no
 * prompt flag appears, so reintroducing a probe fails rather than passing
 * quietly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import {
  AGY_ASSUMED_CONTEXT_WINDOW,
  agyContextWindow,
  makeAgyProfile,
  type AgyCatalogEntry,
} from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { createManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";

const fixtures = fileURLToPath(new URL("./fixtures/agy-native-capabilities/", import.meta.url));
const logger = pino({ level: "silent" }) as unknown as Logger;

/** Every flag agy treats as "run a turn". A probe cannot avoid all of these. */
const PROMPT_FLAGS = ["-p", "--print", "--prompt", "-i", "--prompt-interactive"];

interface Invocation { args?: string[]; prompt?: string; scenario?: string }

async function discover(): Promise<{ catalog: AgyCatalogEntry[]; invocations: Invocation[]; cleanup: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r4a-"));
  const log = path.join(root, "invocations");
  const managed = createManagedAgyFixture({
    source: path.join(fixtures, "fake-native-agy.mjs"),
    version: "agy fixture 1.1.28",
    cwd: root,
    approvedEnvironment: {
      SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtures,
      SEAM_AGY_CAPABILITY_INVOCATIONS: log,
    },
  });
  const profile = makeAgyProfile({
    runtime: managed.runtime,
    dataDir: root,
    defaultModel: "fixture-native-model",
    exposeGlobalStaging: false,
  });
  const candidate = await profile.catalog.fetch();
  const invocations: Invocation[] = fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Invocation)
    : [];
  return {
    catalog: candidate.models as unknown as AgyCatalogEntry[],
    invocations,
    cleanup: () => { managed.cleanup(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

describe("#260 native catalog discovery is prompt-free", () => {
  it("never passes a prompt flag to the CLI while building a catalog", async () => {
    const { invocations, cleanup } = await discover();
    try {
      expect(invocations.length).toBeGreaterThan(0);
      for (const invocation of invocations) {
        const args = invocation.args ?? [];
        // The assertion, stated positively so a reintroduced probe fails here
        // rather than somewhere downstream: no invocation may carry a prompt.
        expect(args.filter((arg) => PROMPT_FLAGS.includes(arg))).toEqual([]);
        expect(invocation.prompt ?? "").toBe("");
        // And the one that used to hide inside an error path.
        expect(args).not.toContain("__seam_probe_invalid__");
      }
      // Exactly one prompt-free invocation does the whole job; the intersection
      // of two probes is gone, not reimplemented.
      expect(invocations.some((row) => (row.args ?? []).includes("models"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("publishes the ids agy lists, and publishes no window it did not observe", async () => {
    const { catalog, cleanup } = await discover();
    try {
      expect(catalog.map((row) => row.id)).toEqual([
        "fixture-native-model",
        "fixture-native-model-low",
      ]);
      // Rule from #260: unknown context stays unknown. A name list is not
      // evidence of a window, so the published catalog carries none — #346
      // learns the real ones from a session's own language server.
      for (const row of catalog) {
        expect(row.context?.maximum ?? null).toBeNull();
      }
    } finally {
      cleanup();
    }
  });

  it("leaves the agent startable when discovery fails", async () => {
    // Blast radius: a catalog that cannot be built refuses the CATALOG, not
    // the agent. #326 was the version of this that made an online host unable
    // to accept any turn; #339 rule 15 keeps `default` startable, and this
    // asserts AGY does not reintroduce the dead end on its own side.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r4a-fail-"));
    const managed = createManagedAgyFixture({
      source: path.join(fixtures, "fake-native-agy.mjs"),
      version: "agy fixture 1.1.28",
      cwd: root,
      approvedEnvironment: {
        SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtures,
        SEAM_AGY_R5_CATALOG_MODE: "fail",
      },
    });
    const profile = makeAgyProfile({
      runtime: managed.runtime,
      dataDir: root,
      defaultModel: "fixture-native-model",
      exposeGlobalStaging: false,
    });
    try {
      await expect(profile.catalog.fetch()).rejects.toBeDefined();
      // The adapter itself is intact: it still describes itself and still
      // carries a default to start on.
      expect(profile.id).toBe("agy");
      expect(profile.defaultModel).toBe("fixture-native-model");
      const runtime = new AgentRuntime({ profile, logger });
      await runtime.start();
      await runtime.dispose();
    } finally {
      managed.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#260 unknown context windows assume a floor, never a ceiling", () => {
  const entry = (modelId: string, maxTokens: number): AgyCatalogEntry => ({
    modelId, rawDisplayName: modelId, displayName: modelId, ctx: "",
    recommended: false, supportsThinking: false, supportsImages: false, maxTokens,
  });

  it("uses the model's own observed window when there is one", () => {
    const catalog = [entry("a", 200_000), entry("b", 1_000_000)];
    expect(agyContextWindow(catalog, catalog[1])).toBe(1_000_000);
  });

  it("falls back to the smallest window observed in this binding's catalog", () => {
    // A real number from a real sibling beats a constant, and staying inside
    // the smallest known window cannot overrun any of them.
    const catalog = [entry("a", 1_000_000), entry("b", 200_000), entry("c", 0)];
    expect(agyContextWindow(catalog, catalog[2])).toBe(200_000);
  });

  it("assumes the conservative floor when nothing is known", () => {
    const catalog = [entry("a", 0), entry("b", 0)];
    expect(agyContextWindow(catalog, catalog[0])).toBe(AGY_ASSUMED_CONTEXT_WINDOW);
    expect(agyContextWindow([], undefined)).toBe(AGY_ASSUMED_CONTEXT_WINDOW);
  });

  it("never assumes more than the smallest window AGY ships", () => {
    // The asymmetry that decides the number. Assuming too much drives a
    // smaller-window model past its limit and fails mid-turn, far from the
    // cause; assuming too little only compacts sooner than necessary. The old
    // `?? 1_000_000` was the ceiling — correct for Gemini, five times over for
    // a 200k Claude window, and undetectable until the turn broke.
    expect(AGY_ASSUMED_CONTEXT_WINDOW).toBeLessThanOrEqual(200_000);
    expect(AGY_ASSUMED_CONTEXT_WINDOW).toBeLessThan(1_000_000);
  });
});
