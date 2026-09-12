import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_AGY_EXECUTION_POLICY,
  agyExecutionPolicyArgs,
} from "../packages/adapters/src/profiles/agy.js";
import { loadHostAdapters } from "../packages/bridge/src/inventory.js";
import { createManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";

/**
 * #324. Production runs agy with NO sandbox and with every tool permission
 * auto-approved. That is a deliberate choice — a sandbox was never a
 * requirement — but the flag list invites the opposite reading, because
 * `--sandbox` exists in the policy and is exercised by helper-path tests.
 *
 * `docs/agy-native-lifecycle.md` states the posture. These assertions are what
 * stop that document from quietly becoming false: enabling the sandbox by
 * default would mean depending on a CLI boundary nobody has demonstrated, so it
 * has to fail here and send the reader back to #324 rather than pass silently.
 */

describe("the documented AGY sandbox posture is the one production uses (#324)", () => {
  it("does not enable the sandbox by default", () => {
    expect(DEFAULT_AGY_EXECUTION_POLICY.sandbox).toBe(false);
  });

  it("launches with no --sandbox and with permissions auto-approved", () => {
    const args = agyExecutionPolicyArgs("/workspace", DEFAULT_AGY_EXECUTION_POLICY);

    // The claim the docs make, asserted rather than described.
    expect(args).not.toContain("--sandbox");
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("bounds the workspace with --add-dir alone", () => {
    // `--add-dir` is the ONLY thing limiting reachable directories, so a change
    // to how many are added is a change to the only boundary that exists.
    const args = agyExecutionPolicyArgs("/workspace", DEFAULT_AGY_EXECUTION_POLICY);
    expect(args.filter((arg) => arg === "--add-dir")).toHaveLength(2);
    expect(args).toContain("/workspace");
  });

  it("auto-approves permissions even when the sandbox IS requested", () => {
    // Worth pinning: the two flags are independent, so a future helper opting
    // into the sandbox does not thereby gain permission prompting. Anyone
    // wiring that path needs to know it is not a substitute.
    const args = agyExecutionPolicyArgs("/private/helper", {
      sandbox: true,
      exposeGlobalStaging: false,
    });
    expect(args).toContain("--sandbox");
    expect(args).toContain("--dangerously-skip-permissions");
  });
});

/**
 * #380. The posture above was not only undocumented for a while — it was
 * actively contradicted. `AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED` sat in the
 * config schema defaulting to `"false"`, so the one place an operator would
 * look said the bypass was off. Its only consumer was the agy-package config
 * block (#377), and native agy never read it.
 *
 * These assertions stop it coming back, in either direction: as a key that
 * misrepresents, or as a gate that takes agy off a host to fix the
 * misrepresentation.
 */
describe("no configuration gates the permission bypass, and none pretends to (#380)", () => {
  const configSource = fs.readFileSync(
    path.join(import.meta.dirname, "..", "packages", "core", "src", "config.ts"),
    "utf8"
  );

  it("has no acknowledgement key in the schema", () => {
    // Re-adding it as a no-op restores the exact defect: a false-by-default
    // key named for a bypass that happens unconditionally.
    expect(configSource).not.toMatch(/^\s*AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED:/m);
    // And the reason is recorded where someone would re-add it.
    expect(configSource).toContain("THERE IS DELIBERATELY NO PERMISSION-BYPASS ACKNOWLEDGEMENT KEY (#380)");
  });

  it("keeps the bypass unconditional rather than config-driven", () => {
    // Making it conditional is a real design change, not a refactor: it would
    // mean a host's config could silently turn permission prompting back on
    // mid-fleet. If that is ever wanted it needs its own decision, so the
    // argv builder must not start reading configuration.
    for (const policy of [
      DEFAULT_AGY_EXECUTION_POLICY,
      { sandbox: false, exposeGlobalStaging: false },
      { sandbox: true, exposeGlobalStaging: true },
    ]) {
      expect(agyExecutionPolicyArgs("/workspace", policy)).toContain("--dangerously-skip-permissions");
    }
  });

  it("loses no host: agy still loads with the removed key still set in env", async () => {
    // THE negative assertion. Four of five agy hosts are agy-only, so an
    // operator whose .env still carries the key must not lose their agent —
    // and the schema is non-strict, so an unknown key is simply ignored.
    const managed = createManagedAgyFixture({ version: "agy fixture 1.1.28" });
    try {
      const env = {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        AGY_ENABLED: "true",
        AGY_CLI_PATH: managed.executable,
        AGY_BIN: managed.executable,
        AGY_VERSION: "agy fixture 1.1.28",
        AGY_SHA256: managed.sha256,
        AGY_RUNTIME_ROOT: managed.runtimeRoot,
        AGY_DEFAULT_MODEL: "fixture-native-model",
        // Still present on a host nobody has updated yet.
        AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED: "false",
      };
      const adapters = loadHostAdapters("copilot", {
        exists: () => true,
        env,
      });
      expect(adapters.has("agy")).toBe(true);
      // And with the key absent entirely, which is the post-migration state.
      const { AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED: _drop, ...without } = env;
      const after = loadHostAdapters("copilot", {
        exists: () => true,
        env: without,
      });
      expect(after.has("agy")).toBe(true);
    } finally {
      managed.cleanup();
    }
  }, 30_000);
});
