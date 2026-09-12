import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGY_EXECUTION_POLICY,
  agyExecutionPolicyArgs,
} from "../packages/adapters/src/profiles/agy.js";

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
