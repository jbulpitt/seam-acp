import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { makeAgyProfile, readErrorClassification } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { createOrdinaryAgyFixture } from "./helpers/agy-runtime-fixture.js";

const fixtures = fileURLToPath(new URL("./fixtures/agy-native-capabilities/", import.meta.url));
const logger = pino({ level: "silent" }) as unknown as Logger;
const modelId = "fixture-native-model";

function fixture(root: string, failing: boolean, staticModels = false) {
  const ordinary = createOrdinaryAgyFixture({
    source: path.join(fixtures, "fake-native-agy.mjs"), cwd: root,
    environment: {
      SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtures,
      ...(failing ? { SEAM_AGY_R5_CATALOG_MODE: "auth-wait" } : {}),
    },
  });
  const profile = makeAgyProfile({
    runtime: ordinary.runtime, dataDir: root, defaultModel: staticModels ? modelId : "Fixture Native Model",
    initialSettingsFile: path.join(root, "settings.json"), exposeGlobalStaging: false,
    ...(staticModels ? { staticModels: [{ modelId, name: "Fixture Native Model" }] } : {}),
  });
  const runtime = new AgentRuntime({ logger, profile, spawnFn: profile.spawn.bind(profile) });
  return { profile, runtime, async close() {
    await runtime.dispose();
    ordinary.cleanup();
  } };
}

function expectVerificationCause(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("Verification required. Please complete verification in your browser to continue.");
  expect(readErrorClassification(error)).toMatchObject({ agentId: "agy", errorKind: "auth_required" });
  expect(String(error)).not.toContain("synthetic-secret-token-481");
  expect(String(error)).not.toContain("Authorization: Bearer");
  expect(String(error)).not.toContain("unknown AGY model");
  expect(String(error)).not.toContain("catalog is unavailable");
}

describe.sequential("AGY catalog failure cause across ACP", () => {
  it.each([false, true])("keeps a failed native models probe as a failure (static models: %s)", async staticModels => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-catalog-cause-"));
    const f = fixture(root, true, staticModels);
    try {
      const error = await f.profile.catalog.fetch().then(() => undefined, error => error);
      expectVerificationCause(error);
    } finally {
      await f.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("returns the native catalog cause from session/new, not Internal error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-new-cause-"));
    const f = fixture(root, true);
    try {
      await f.runtime.start();
      const error = await f.runtime.newSession({ cwd: root }).then(() => undefined, error => error);
      expectVerificationCause(error);
    } finally {
      await f.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("returns the native catalog cause when loading a recorded session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-load-cause-"));
    const healthy = fixture(root, false);
    const failing = fixture(root, true);
    try {
      await healthy.runtime.start();
      const session = await healthy.runtime.newSession({ cwd: root, model: modelId, strictModel: true });
      await healthy.runtime.dispose();
      await failing.runtime.start();
      const error = await failing.runtime.loadSession({ cwd: root, sessionId: session.sessionId })
        .then(() => undefined, error => error);
      expectVerificationCause(error);
    } finally {
      await failing.close();
      await healthy.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
