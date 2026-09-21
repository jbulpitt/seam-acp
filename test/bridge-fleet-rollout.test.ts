/**
 * #484 — the fleet was described on every run and then never walked.
 *
 * `main()` already called `describeTargetFleet` and printed
 * `formatFleetCoverage` on every invocation, and then acted on exactly one
 * host because `parseArgs` took a single `--target`. Upgrading four hosts on
 * 2026-09-21 cost roughly ten invocations and four sequential refusals.
 *
 * Every refusal that morning was correct, so nothing here asserts that a guard
 * became more permissive. What it asserts is that the same refusals arrive
 * together, early, with the fix attached.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, validateTargetMap } from "../scripts/lib/bridge-rollout.mjs";
import {
  blockingOnly,
  collectBlockers,
  describeTargetFleet,
  fleetRunExitCode,
  formatBlockers,
  formatFleetCoverage,
  formatFleetRunSummary,
  makeReachabilityProbe,
  partitionReachability,
  planFleetRun,
} from "../scripts/lib/bridge-fleet.mjs";

const root = path.resolve(import.meta.dirname, "..");
const configured = JSON.parse(fs.readFileSync(path.join(root, "ops/bridge/targets.json"), "utf8"));
const targets = validateTargetMap(configured);
const fleet = describeTargetFleet(targets, new Set(Object.keys(configured.targets)));

/** A well-formed preflight report with nothing wrong with it. */
const CLEAN = Object.freeze({
  bridge_id: "media-server",
  node_path: "/Users/jesse/.nvm/versions/node/v22.23.2/bin/node",
  node_version: "v22.23.2",
  native_install_ready: "yes",
  native_dependency: "better-sqlite3@11.10.0",
  native_prebuild: "better-sqlite3@11.10.0-node-v127-linux-x64",
  enrolled: "yes",
  rollout_ready: "yes",
  disk_path: "/Users/jesse/seam-acp",
  disk_bytes_available: "50000000000",
});

describe("#484 fleet mode exists at all", () => {
  it("accepts --all with no --target", () => {
    expect(parseArgs(["--all"])).toMatchObject({ all: true, action: "preflight", apply: false });
  });

  it("refuses naming both a host and the fleet", () => {
    expect(() => parseArgs(["--all", "--target", "media-server"])).toThrow(/either --target .* or --all/);
  });

  it("still refuses naming neither, and now says how to ask for the fleet", () => {
    expect(() => parseArgs([])).toThrow(/--target is required.*--all/s);
  });

  it("plans only the rollout-managed hosts, never an excluded one", () => {
    const plan = planFleetRun(fleet);
    expect(plan.attempt).toEqual([...fleet.rolloutManaged]);
    expect(plan.attempt.length).toBeGreaterThan(0);
    for (const row of fleet.rolloutExcluded) expect(plan.attempt).not.toContain(row.id);
  });

  it("names the hosts a fleet run will touch, instead of only counting them", () => {
    const text = formatFleetCoverage(fleet);
    expect(text).toContain(`operation_scope=${fleet.rolloutManaged.length} of ${fleet.registered.length}`);
    for (const id of fleet.rolloutManaged) expect(text).toContain(id);
  });

  it("keeps the single-host scope line exactly as it was", () => {
    expect(formatFleetCoverage(fleet, "media-server")).toContain("operation_scope=1 of");
  });
});

describe("#484 --all is narrow on purpose", () => {
  it.each([
    ["--rollback", ["--all", "--rollback", "--activation-id", "a".repeat(64), "--apply"]],
    ["--restore-baseline", ["--all", "--restore-baseline", "--enrollment-id", "a".repeat(64), "--apply"]],
    ["--activate", ["--all", "--activate", "--sha", "a".repeat(40), "--checksum", "b".repeat(64), "--stage-id", "c".repeat(64), "--apply"]],
    ["--enroll", ["--all", "--enroll", "--apply"]],
  ])("refuses --all with %s, which carries per-host identity", (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(/--all supports only preflight and --rollout/);
  });

  it("allows the two that genuinely generalise", () => {
    expect(parseArgs(["--all"])).toMatchObject({ all: true, action: "preflight" });
    expect(parseArgs(["--all", "--rollout", "--apply"])).toMatchObject({ all: true, action: "rollout", apply: true });
  });

  it("still requires --apply for the combined path", () => {
    expect(() => parseArgs(["--all", "--rollout"])).toThrow(/requires --apply/);
    expect(() => parseArgs(["--target", "media-server", "--rollout"])).toThrow(/requires --apply/);
  });

  it("confines --auto-enroll to the combined path", () => {
    expect(() => parseArgs(["--target", "media-server", "--auto-enroll"])).toThrow(/applies only to --rollout/);
    expect(parseArgs(["--all", "--rollout", "--auto-enroll", "--apply"])).toMatchObject({ autoEnroll: true });
  });

  it("does not let --rollout be combined with another action", () => {
    expect(() => parseArgs(["--target", "media-server", "--rollout", "--enroll", "--apply"])).toThrow(/choose only one/);
  });
});

describe("#484 unreachable is a normal state, not an error", () => {
  it("splits probes and keeps the reason for each skip", () => {
    const split = partitionReachability([
      { id: "rhc-server", reachable: true },
      { id: "macbook-air", reachable: false, detail: "ssh timed out after 15000ms" },
      { id: "home-hub", reachable: false },
    ]);
    expect(split.reachable).toEqual(["rhc-server"]);
    expect(split.unreachable.map((r) => r.id)).toEqual(["macbook-air", "home-hub"]);
    expect(split.unreachable[0]!.detail).toMatch(/timed out/);
    expect(split.unreachable[1]!.detail).toBe("ssh probe failed");
  });

  it("does not fail a run merely because laptops were closed", () => {
    // Six of ten hosts were unreachable on 2026-09-21. That is a fleet of
    // laptops behaving normally.
    const results = [
      { id: "rhc-server", outcome: "succeeded" },
      { id: "macbook-air", outcome: "skipped-unreachable" },
      { id: "home-hub", outcome: "skipped-unreachable" },
    ];
    expect(fleetRunExitCode(results)).toBe(0);
    expect(formatFleetRunSummary(results)).toContain("skipped_unreachable=2");
  });

  it("does fail a run when a host refused or failed", () => {
    expect(fleetRunExitCode([{ id: "a", outcome: "refused", reason: "x" }])).toBe(1);
    expect(fleetRunExitCode([{ id: "a", outcome: "failed", reason: "x" }])).toBe(1);
  });

  it("counts every host it considered, so silence cannot look like success", () => {
    const summary = formatFleetRunSummary([
      { id: "a", outcome: "succeeded" },
      { id: "b", outcome: "skipped-unreachable" },
      { id: "c", outcome: "refused", reason: "not_enrolled", blockers: [{ code: "not_enrolled", detail: "d", remediation: "run --enroll --apply" }] },
    ]);
    expect(summary).toContain("considered=3");
    expect(summary).toContain("succeeded=1");
    expect(summary).toContain("refused=1");
    expect(summary).toContain("remediation=run --enroll --apply");
  });
});

describe("#484 the reachability probe asks one question and mutates nothing", () => {
  const target = targets.get(fleet.rolloutManaged[0]!)!;

  it("is read-only", () => {
    expect(makeReachabilityProbe(target).mutates).toBe(false);
  });

  it("carries no deployment identity — it is not an operation", () => {
    const probe = makeReachabilityProbe(target);
    expect(probe.args).toContain("true");
    expect(probe.args).not.toContain(target.pm2App);
    expect(probe.args).not.toContain(target.checkoutPath);
    expect(probe.args).not.toContain(target.nodePath);
  });

  it("gives up quickly, because the expected answer for a laptop is no", () => {
    expect(makeReachabilityProbe(target).timeoutMs).toBeLessThanOrEqual(15_000);
  });

  it("refuses a target with no verified SSH path", () => {
    expect(() => makeReachabilityProbe({ bridgeId: "x", sshAlias: "a; rm -rf /" })).toThrow(/verified SSH management path/);
    expect(() => makeReachabilityProbe({ bridgeId: "x", sshAlias: null })).toThrow(/verified SSH management path/);
  });
});

describe("#484 every blocker at once, each with its remediation", () => {
  it("reports NOTHING for a healthy host", () => {
    expect(collectBlockers(CLEAN, targets.get("media-server"))).toEqual([]);
    expect(formatBlockers("media-server", [])).toBe("host_clear=media-server");
  });

  it("collects four blockers from ONE report instead of one per round trip", () => {
    // This is the morning of 2026-09-21 compressed into a single answer.
    const blockers = collectBlockers(
      { ...CLEAN, native_install_ready: "no", enrolled: "no", rollout_ready: "no", disk_bytes_available: "1024" },
      targets.get("media-server"),
      targets
    );
    expect(blockers.map((b) => b.code).sort()).toEqual(
      ["low_disk", "native_prebuild_unavailable", "not_enrolled", "not_rollout_ready"].sort()
    );
    for (const row of blockers) expect(row.remediation.length).toBeGreaterThan(0);
  });

  it("names the enrollment remediation that cost a round trip", () => {
    const [blocker] = collectBlockers({ ...CLEAN, enrolled: "no", artifact_mode: "legacy-checkout" }, targets.get("media-server"));
    expect(blocker!.code).toBe("not_enrolled");
    expect(blocker!.detail).toContain("legacy_previous_release_not_receipt_capable");
    expect(blocker!.remediation).toContain("--enroll --apply");
  });

  it("distinguishes a drifted baseline from an absent one", () => {
    const codes = collectBlockers({ ...CLEAN, enrolled: "drifted" }, targets.get("media-server")).map((b) => b.code);
    expect(codes).toContain("enrolled_baseline_drift");
    expect(codes).not.toContain("not_enrolled");
  });

  it("survives a malformed report rather than throwing over it", () => {
    expect(collectBlockers(null, targets.get("media-server"))).toEqual([]);
    expect(collectBlockers("nonsense" as never, targets.get("media-server"))).toEqual([]);
  });

  it("prints each blocker with its remediation underneath", () => {
    const text = formatBlockers("media-server", collectBlockers({ ...CLEAN, enrolled: "no", artifact_mode: "legacy-checkout" }, targets.get("media-server")));
    expect(text).toContain("host_blocked=media-server blocking=1");
    expect(text).toContain("blocking=not_enrolled");
    expect(text).toContain("remediation=");
  });
});

describe("#484 an advisory is not a refusal", () => {
  // A real read-only fleet preflight caught this reporting layer inventing a
  // refusal: macbook-air was managed, rollout_ready=yes and serving, and got
  // reported as refused purely because its recorded rollback baseline had
  // drifted. Severity is now read off the gates that already exist.
  it("does not call a managed, rollout-ready host refused over a stale baseline", () => {
    const blockers = collectBlockers(
      { ...CLEAN, artifact_mode: "managed", rollout_ready: "yes", enrolled: "drifted", node_path: "/Users/jessebulpitt/.nvm/versions/node/v22.22.2/bin/node" },
      targets.get("macbook-air")
    );
    expect(blockers.map((b) => b.code)).toContain("enrolled_baseline_drift");
    expect(blockingOnly(blockers)).toEqual([]);
    expect(formatBlockers("macbook-air", blockers)).toContain("host_clear=macbook-air advisory=1");
  });

  it("still calls a legacy host with no baseline blocked — there is no rollback target", () => {
    const blockers = collectBlockers(
      { ...CLEAN, artifact_mode: "legacy-checkout", enrolled: "no" },
      targets.get("macbook-air")
    );
    expect(blockingOnly(blockers).map((b) => b.code)).toContain("not_enrolled");
  });

  it("treats a permitted first activation from a baseline as advisory, not blocking", () => {
    // `firstActivationFromBaselineAllowed`: legacy + enrolled + protocol 1 +
    // drainable. The gate lets this through, so reporting must not claim a
    // refusal the tool would not actually make.
    const blockers = collectBlockers(
      { ...CLEAN, artifact_mode: "legacy-checkout", enrolled: "yes", rollout_ready: "no", protocol_version: "1", drain_SIGUSR2: "yes" },
      targets.get("macbook-air")
    );
    const ready = blockers.find((b) => b.code === "not_rollout_ready");
    expect(ready?.severity).toBe("advisory");
  });

  it("keeps not-rollout-ready blocking when no baseline route exists", () => {
    const blockers = collectBlockers(
      { ...CLEAN, artifact_mode: "managed", rollout_ready: "no", protocol_version: "0", drain_SIGUSR2: "no" },
      targets.get("macbook-air")
    );
    expect(blockingOnly(blockers).map((b) => b.code)).toContain("not_rollout_ready");
  });

  it("keeps a missing prebuild blocking — the gate that stopped a half-done Mac rollout", () => {
    const blockers = collectBlockers({ ...CLEAN, native_install_ready: "no" }, targets.get("macbook-air"), targets);
    expect(blockingOnly(blockers).map((b) => b.code)).toContain("native_prebuild_unavailable");
  });
});

describe("#484 item 6: the nodePath diagnosis nobody assembled", () => {
  // macbook-air was pinned to an absolute v24.15.0 path while the fleet moved
  // to v22.22.2, and it surfaced as an opaque native-prebuild refusal (#412).
  // Every fact was in the report; nothing put them together.
  const drifted = new Map([
    ["macbook-air", { bridgeId: "macbook-air", nodePath: "/Users/j/.nvm/versions/node/v24.15.0/bin/node" }],
    ["rhc-server", { bridgeId: "rhc-server", nodePath: "/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node" }],
    ["media-server", { bridgeId: "media-server", nodePath: "/Users/jesse/.nvm/versions/node/v22.22.2/bin/node" }],
  ]);

  it("says which node is pinned, which ABI is missing, and what the fleet uses", () => {
    const [blocker] = collectBlockers(
      { ...CLEAN, native_install_ready: "no", node_version: "v24.15.0", native_prebuild: "better-sqlite3@11.10.0-node-v137-darwin-arm64" },
      drifted.get("macbook-air"),
      drifted
    );
    expect(blocker!.code).toBe("native_prebuild_unavailable");
    expect(blocker!.detail).toContain("v137");          // the ABI actually missing
    expect(blocker!.detail).toContain("v24.15.0");      // what this host pins
    expect(blocker!.detail).toContain("v22.22.2");      // what the fleet runs
    expect(blocker!.remediation).toContain("targets.json");
  });

  it("does not invent drift when the host already matches the fleet", () => {
    const [blocker] = collectBlockers(
      { ...CLEAN, native_install_ready: "no", node_version: "v22.22.2" },
      drifted.get("rhc-server"),
      drifted
    );
    expect(blocker!.detail).not.toContain("fleet standard");
    expect(blocker!.remediation).toContain("reviewed prebuild");
  });

  it("reports declared-vs-observed drift separately, since both can be true", () => {
    const codes = collectBlockers(
      { ...CLEAN, node_path: "/somewhere/else/bin/node" },
      targets.get("media-server")
    ).map((b) => b.code);
    expect(codes).toContain("node_path_drift");
  });
});
