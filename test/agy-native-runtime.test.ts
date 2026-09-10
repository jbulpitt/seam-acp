import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import {
  agyManagedExecutablePath,
  agyAcpReleaseArtifact,
  fetchAgyUserStatus,
  makeAgyNativeRuntime,
  makeAgyProfile,
  makeAgyPackageProfile,
} from "@seam/adapters";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { inventoryFromAdapters, loadHostAdapters } from "../packages/bridge/src/inventory.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { createManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";

const logger = pino({ level: "silent" }) as unknown as Logger;
const here = path.dirname(fileURLToPath(import.meta.url));
const capabilityFixtureDir = path.join(here, "fixtures", "agy-native-capabilities");
const capabilityCli = path.join(capabilityFixtureDir, "fake-native-agy.mjs");

describe("native AGY R2 runtime identity", () => {
  it("drives local and bridge inventory from the same verified native tuple", async () => {
    const fixture = createManagedAgyFixture({
      version: "agy-test 1.0",
      credentialScope: "antigravity-oauth:fixture-seven",
    });
    try {
      const launch = await fixture.runtime.resolve(["models"], "/tmp");
      expect(launch.executable).toBe(agyManagedExecutablePath(fixture.runtimeRoot, fixture.sha256));
      expect(launch.argv).toEqual(["models"]);
      expect(launch.cwd).toBe("/tmp");
      expect(launch.env.AGY_UNAPPROVED_SECRET).toBeUndefined();

      const local = makeAgyProfile({
        runtime: fixture.runtime,
        defaultModel: "fixture-model",
        staticModels: [{ modelId: "fixture-model", name: "Fixture Model", contextLimit: 200_000 }],
      });
      const candidate = await local.catalog.fetch();
      expect(candidate.cliVersion).toBe("agy-test 1.0");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: os.homedir(),
        PATH: process.env.PATH,
        AGY_ENABLED: "true",
        AGY_PACKAGE_ENABLED: "false",
        AGY_CLI_PATH: fixture.executable,
        AGY_BIN: fixture.executable,
        AGY_RUNTIME_ROOT: fixture.runtimeRoot,
        AGY_VERSION: "agy-test 1.0",
        AGY_SHA256: fixture.sha256,
        AGY_DEFAULT_MODEL: "fixture-model",
        AGY_CREDENTIAL_SCOPE: "antigravity-oauth:fixture-seven",
      };
      const bridged = loadHostAdapters("missing-copilot", {
        cwd: os.tmpdir(),
        env,
        exists: (candidate) => candidate === fixture.executable,
      });
      const remote = inventoryFromAdapters(bridged, "missing-copilot", env)
        .find((row) => row.agentId === "agy");
      expect(remote?.runtime).toEqual(local.describe().runtime);
      expect(remote?.runtime).toMatchObject({
        executable: fixture.executable,
        argv: [],
        cwd: os.tmpdir(),
        environment: {},
        topology: "virtual-acp-native-cli",
        immutableRoot: fixture.runtimeRoot,
        cwdPolicy: "session",
        credentialScope: "antigravity-oauth:fixture-seven",
        provenance: {
          source: "google:antigravity-native-cli",
          version: "agy-test 1.0",
          sha256: fixture.sha256,
        },
      });
      expect(remote?.runtime?.environmentKeys).toEqual(expect.arrayContaining(["HOME", "PATH"]));
    } finally {
      fixture.cleanup();
    }
  });

  it("uses the same verified runtime for quota and the real native turn consumer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r2-consumers-"));
    const invocationLog = path.join(root, "invocations.ndjson");
    const fixture = createManagedAgyFixture({
      source: capabilityCli,
      version: "agy fixture 1.1.28",
      credentialScope: "antigravity-oauth:r2-consumer",
      cwd: root,
      approvedEnvironment: {
        SEAM_AGY_CAPABILITY_FIXTURE_DIR: capabilityFixtureDir,
        SEAM_AGY_CAPABILITY_INVOCATIONS: invocationLog,
      },
    });
    const profile = makeAgyProfile({
      runtime: fixture.runtime,
      dataDir: root,
      defaultModel: "Fixture Native Model",
      persistModelSelection: false,
      exposeGlobalStaging: false,
    });
    const agent = new AgentRuntime({ profile, logger });
    try {
      const usage = await fetchAgyUserStatus(fixture.runtime);
      expect(usage).toEqual({
        description: "Sanitized fixture quota",
        groups: [{
          displayName: "Fixture plan",
          buckets: [{
            bucketId: "fixture-weekly",
            displayName: "Weekly",
            window: "weekly",
            remainingFraction: 0.75,
          }],
        }],
      });

      await agent.start();
      await agent.newSession({ cwd: root, model: "fixture-native-model", strictModel: true });
      const marker = path.join(root, "replacement-executed");
      const releaseDir = path.dirname(fixture.executable);
      fs.chmodSync(fixture.runtimeRoot, 0o700);
      fs.chmodSync(releaseDir, 0o700);
      fs.chmodSync(fixture.executable, 0o700);
      fs.writeFileSync(fixture.executable, `#!/bin/sh\nprintf touched > ${JSON.stringify(marker)}\n`, { mode: 0o500 });
      fs.chmodSync(fixture.executable, 0o500);
      fs.chmodSync(releaseDir, 0o500);
      fs.chmodSync(fixture.runtimeRoot, 0o500);
      await expect(agent.prompt("capability-turn-one")).rejects.toThrow("Internal error");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      await agent.dispose();
      fixture.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a replaced artifact by digest before executing replacement bytes", async () => {
    const fixture = createManagedAgyFixture({ version: "agy-test 1.0" });
    const marker = path.join(os.tmpdir(), `agy-r2-replacement-${process.pid}-${Date.now()}`);
    try {
      await fixture.runtime.resolve(["models"], "/tmp");
      const releaseDir = path.dirname(fixture.executable);
      fs.chmodSync(fixture.runtimeRoot, 0o700);
      fs.chmodSync(releaseDir, 0o700);
      fs.chmodSync(fixture.executable, 0o700);
      fs.writeFileSync(fixture.executable, `#!/bin/sh\nprintf touched > ${JSON.stringify(marker)}\nprintf 'agy-test 1.0\\n'\n`, { mode: 0o500 });
      fs.chmodSync(fixture.executable, 0o500);
      fs.chmodSync(releaseDir, 0o500);
      fs.chmodSync(fixture.runtimeRoot, 0o500);
      await expect(fixture.runtime.resolve(["models"], "/tmp"))
        .rejects.toThrow(/sha256 does not match/);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(marker, { force: true });
      fixture.cleanup();
    }
  });

  it("also blocks agy-package before its catalog consumer can use a replaced managed CLI", async () => {
    const fixture = createManagedAgyFixture();
    const probe = vi.fn(async () => ({
      agyVersion: "agy-test 1.0",
      models: [{ modelId: "fixture-model", displayName: "Fixture Model" }],
    }));
    try {
      const profile = makeAgyPackageProfile({
        acpPath: "/bin/false",
        agyBin: fixture.executable,
        agyVersion: "agy-test 1.0",
        agySha256: fixture.sha256,
        runtimeRoot: fixture.runtimeRoot,
        defaultModel: "fixture-model",
        stateDir: path.join(os.homedir(), ".agy-acp"),
        conversationsDir: "/tmp/agy-conversations",
        cwd: "/tmp",
        credentialScope: "antigravity-oauth:test",
        wrapperVersion: "1.1.0",
        wrapperSha256: agyAcpReleaseArtifact().sha256,
        permissionRiskAcknowledged: true,
        verifyWrapper: () => {},
        catalogProbe: probe,
      });
      const releaseDir = path.dirname(fixture.executable);
      fs.chmodSync(fixture.runtimeRoot, 0o700);
      fs.chmodSync(releaseDir, 0o700);
      fs.chmodSync(fixture.executable, 0o700);
      fs.appendFileSync(fixture.executable, "\n# replaced\n");
      fs.chmodSync(fixture.executable, 0o500);
      fs.chmodSync(releaseDir, 0o500);
      fs.chmodSync(fixture.runtimeRoot, 0o500);
      await expect(profile.catalog.fetch()).rejects.toThrow(/sha256 does not match/);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it("requires version and digest to move together for a deliberate upgrade", async () => {
    const fixture = createManagedAgyFixture({ version: "actual-version" });
    try {
      expect(() => makeAgyNativeRuntime({
        executable: fixture.executable,
        runtimeRoot: fixture.runtimeRoot,
        version: "stale-version",
        sha256: fixture.sha256,
        credentialScope: "antigravity-oauth:test",
        cwd: "/tmp",
        approvedEnvironment: { FAKE_AGY_VERSION: "actual-version" },
      })).toThrow(/version does not match AGY_VERSION/);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not share cached evidence across semantic credential scopes", () => {
    const fixture = createManagedAgyFixture();
    const alternate = createManagedAgyFixture();
    try {
      const otherAccount = makeAgyNativeRuntime({
        executable: fixture.executable,
        runtimeRoot: fixture.runtimeRoot,
        version: "agy-test 1.0",
        sha256: fixture.sha256,
        credentialScope: "antigravity-oauth:other-account",
        cwd: "/tmp",
      });
      const otherEnvironment = makeAgyNativeRuntime({
        executable: fixture.executable,
        runtimeRoot: fixture.runtimeRoot,
        version: "agy-test 1.0",
        sha256: fixture.sha256,
        credentialScope: "antigravity-oauth:test",
        cwd: "/tmp",
        baseEnv: { ...process.env, HOME: "/tmp/agy-other-home" },
      });
      expect(otherAccount.identityKey).not.toBe(fixture.runtime.identityKey);
      expect(otherAccount.descriptor.credentialScope).toBe("antigravity-oauth:other-account");
      expect(otherEnvironment.identityKey).not.toBe(fixture.runtime.identityKey);
      expect(otherEnvironment.descriptor.environmentFingerprint)
        .not.toBe(fixture.runtime.descriptor.environmentFingerprint);
      expect(alternate.runtime.identityKey).not.toBe(fixture.runtime.identityKey);
    } finally {
      alternate.cleanup();
      fixture.cleanup();
    }
  });

  it("fails missing artifacts actionably and leaves incomplete hosts unavailable", () => {
    expect(() => makeAgyNativeRuntime({
      executable: "/definitely/missing/agy",
      runtimeRoot: "/definitely/missing/runtime",
      version: "fixture-version",
      sha256: "a".repeat(64),
      credentialScope: "antigravity-oauth:test",
      cwd: "/tmp",
    })).toThrow(/AGY_RUNTIME_ROOT does not exist/);

    const adapters = loadHostAdapters("missing-copilot", {
      exists: () => true,
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        AGY_ENABLED: "true",
        AGY_CLI_PATH: "/definitely/missing/agy",
        AGY_DEFAULT_MODEL: "fixture-model",
      },
    });
    expect(adapters.has("agy")).toBe(false);
  });

  it("persists a value-free runtime provenance audit through the real ledger", () => {
    const fixture = createManagedAgyFixture({ version: "audited-version" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r2-audit-"));
    const store = new SessionStore(path.join(dir, "seam.db"));
    try {
      const mutation = new ConfigMutationService({
        store,
        describeConfig: () => { throw new Error("not used"); },
        modelCatalog: { model: () => undefined },
        presetsFile: undefined,
        tierCEnabled: false,
        reloadPresets: () => ({ ok: true }),
        reschedule: () => {},
        defaultTimezone: "UTC",
        logger,
      });
      mutation.recordRuntimeProvenance({
        agentId: "agy",
        location: "local",
        runtime: fixture.runtime.descriptor,
      });
      const [row] = store.listConfigMutations(1);
      expect(row).toMatchObject({
        tier: "runtime-provenance",
        scope: "runtime:agy@local",
        actorId: "seam-runtime",
        summary: "verified agy@local runtime provenance",
      });
      const after = JSON.parse(row!.afterJson) as Record<string, unknown>;
      expect(after).toMatchObject({
        agentId: "agy",
        location: "local",
        runtime: {
          executable: fixture.executable,
          environment: {},
          topology: "virtual-acp-native-cli",
          provenance: { version: "audited-version", sha256: fixture.sha256 },
        },
      });
      expect(row!.afterJson).not.toContain("fixture-marker");
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});
