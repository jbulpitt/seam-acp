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

function makeAgyProfileCalls(source: string): string[] {
  const marker = "makeAgyProfile({";
  const calls: string[] = [];
  let cursor = 0;
  while ((cursor = source.indexOf(marker, cursor)) !== -1) {
    const start = cursor;
    let depth = 0;
    let end = cursor + marker.length;
    for (let index = cursor + "makeAgyProfile(".length; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
    calls.push(source.slice(start, end));
    cursor = end;
  }
  return calls;
}

/**
 * #324/#391. Production runs agy with every tool permission auto-approved and
 * has no native sandbox profile option. The removed option was exercised only
 * by tests, so checking its own argv shape proved no production behavior.
 *
 * `docs/agy-native-lifecycle.md` states the posture. These assertions are what
 * stop that document from quietly becoming false. These are launch-policy
 * facts only; neither the argv nor these assertions prove OS confinement.
 */

describe("the documented AGY execution posture is the one production uses (#324/#391)", () => {
  it("has no dormant sandbox switch in the exported production policy", () => {
    expect(DEFAULT_AGY_EXECUTION_POLICY).toEqual({ exposeGlobalStaging: true });
  });

  it("launches with no --sandbox and with permissions auto-approved", () => {
    const args = agyExecutionPolicyArgs("/workspace", DEFAULT_AGY_EXECUTION_POLICY);

    // The claim the docs make, asserted rather than described.
    expect(args).not.toContain("--sandbox");
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("passes the session workspace and shared staging as accessible roots", () => {
    // This asserts the inputs AGY needs. It deliberately makes no claim that
    // `--add-dir` confines what the child process can access.
    const args = agyExecutionPolicyArgs("/workspace", DEFAULT_AGY_EXECUTION_POLICY);
    expect(args.filter((arg) => arg === "--add-dir")).toHaveLength(2);
    expect(args).toContain("/workspace");
  });

  it.each([
    ["core startup", "packages/core/src/index.ts"],
    ["bridge inventory", "packages/bridge/src/inventory.ts"],
  ])("keeps the removed option out of the %s production construction site", (_label, relative) => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", relative), "utf8");
    const calls = makeAgyProfileCalls(source);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toMatch(/\bsandbox\s*:/);
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
      { exposeGlobalStaging: false },
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
