import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { activationRefusal, artifactName, firstActivationFromBaselineAllowed, buildArtifact, commandRunner, makeScpCommand, makeSshCommand, parseArgs, parseKeyValues, resolveTarget, rollbackPlan, runPreflight, validateReadyReceipt, validateTargetMap, verifyChecksum } from "../scripts/lib/bridge-rollout.mjs";

const root = path.resolve(import.meta.dirname, "..");
const configured = JSON.parse(fs.readFileSync(path.join(root, "ops/bridge/targets.json"), "utf8"));
const targets = validateTargetMap(configured);
const token = "c".repeat(64);

function preflightReport(target: ReturnType<typeof resolveTarget>, overrides: Record<string, string> = {}): string {
  return Object.entries({
    reachable: "yes",
    bridge_id: target.bridgeId,
    pm2_app: target.pm2App,
    identity_bound: "yes",
    remote_mutation: "no",
    pid: "123",
    platform: "darwin-arm64",
    artifact_mode: "managed",
    artifact_identity: `${"a".repeat(40)}:${"b".repeat(64)}`,
    artifact_source_sha: "a".repeat(40),
    checkout_source_sha: "not-applicable",
    artifact_checksum: "b".repeat(64),
    entrypoint_sha256: "c".repeat(64),
    bridge_version: "0.1.0",
    protocol_version: "1",
    drain_SIGUSR2: "yes",
    describeModelCatalog: "yes",
    fetchModelCatalog: "yes",
    rollout_ready: "yes",
    verification_agent: target.verifyAgent,
    process_started_at: "2026-09-11T14:00:00.000Z",
    enrolled: "no",
    enrollment_id: "none",
    baseline_digest: "none",
    baseline_rollback_proof: "none",
    node_path: target.nodePath,
    node_version: "v24.15.0",
    npm_version: "11.6.2",
    disk_path: target.checkoutPath,
    disk_bytes_available: "1024",
    release_parent: "ready",
    native_dependency: "better-sqlite3@11.10.0",
    native_install_strategy: "locked-prebuild",
    native_prebuild: "better-sqlite3@11.10.0-node-v127-darwin-arm64",
    native_install_ready: "yes",
    ...overrides,
  }).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

describe("bridge rollout target safety (#241)", () => {
  it("pins the full operator-owned deployment identity", () => {
    expect(resolveTarget(targets, "media-server")).toMatchObject({ bridgeId: "media-server", sshAlias: "media-server", pm2App: "remote-agent-bridge", expectedUid: 501, checkoutPath: "/Users/jesse/seam-acp", entrypointPath: "/Users/jesse/seam-acp/packages/bridge/dist/index.js", pidFilePath: "/Users/jesse/.pm2/pids/remote-agent-bridge-0.pid", releaseRoot: "/Users/jesse/.seam/bridge-rollouts" });
    expect(resolveTarget(targets, "macbook-air")).toMatchObject({ bridgeId: "macbook-air", sshAlias: "macbook-air", pm2App: "seam-bridge", expectedUid: 501, workspaceArg: "/Users/jessebulpitt" });
  });

  it("keeps AGY-only hosts mapped but outside this rollout", () => {
    expect(configured.targets["jennifer-laptop"].sshAlias).toBe("macbook-air-j");
    expect(() => resolveTarget(targets, "jennifer-laptop")).toThrow(/AGY-only/);
  });

  it("keeps macbook-pro explicitly unmanaged and refuses every mutating phase before command construction (#282)", () => {
    const target = targets.get("macbook-pro")!;
    expect(target.sshAlias).toBeNull();
    expect(target.unmanagedReason).toMatch(/no verified SSH management path/);
    for (const argv of [
      ["--target", "macbook-pro", "--stage", "--apply"],
      ["--target", "macbook-pro", "--activate", "--sha", "a".repeat(40), "--checksum", "b".repeat(64), "--stage-id", token, "--apply"],
    ]) {
      const parsed = parseArgs(argv);
      expect(() => resolveTarget(targets, parsed.target)).toThrow(/explicitly unmanaged.*home-hub is a distinct bridge/);
    }
    expect(() => makeSshCommand(target, ["preflight"], "fixed-script")).toThrow(/explicitly unmanaged/);
    // #281: enrollment must refuse the same state. Recording a baseline for a
    // host with no verified management path would produce a rollback target
    // nobody could ever restore to — the inversion of the primitive's purpose.
    for (const argv of [
      ["--target", "macbook-pro", "--enroll", "--apply"],
      ["--target", "macbook-pro", "--restore-baseline", "--enrollment-id", token, "--apply"],
    ]) {
      const parsed = parseArgs(argv);
      expect(() => resolveTarget(targets, parsed.target)).toThrow(/explicitly unmanaged/);
    }
    expect(() => makeSshCommand(target, ["enroll", token, token], "fixed-script")).toThrow(/explicitly unmanaged/);
    expect(() => makeScpCommand(target, "/tmp/release.tgz", `${artifactName("a".repeat(40), "b".repeat(64))}.upload-${token}`)).toThrow(/explicitly unmanaged/);
  });

  it("surfaces the enrollment-specific reason behind the activation capability gate (#281)", () => {
    const target = resolveTarget(targets, "media-server");
    // The gate itself is unchanged — it still refuses — but a legacy host no
    // longer gets a generic capability message that hides which of the four
    // legacy states it is actually in.
    const legacy = (overrides: Record<string, string>) =>
      parseKeyValues(preflightReport(target, { artifact_mode: "legacy-checkout", rollout_ready: "no", ...overrides }));
    expect(activationRefusal(legacy({ enrolled: "no" }))).toMatch(/nothing is enrolled.*legacy_previous_release_not_receipt_capable.*--enroll/s);
    expect(activationRefusal(legacy({ enrolled: "drifted", enrollment_id: "a".repeat(64), baseline_digest: "b".repeat(64), baseline_rollback_proof: "reduced-baseline" })))
      .toMatch(/enrolled_baseline_state_drift/);
    // #288: a baseline that cannot be drained still cannot host a transition,
    // and the operator is told which rung failed.
    expect(activationRefusal(legacy({ enrolled: "yes", enrollment_id: "a".repeat(64), baseline_digest: "b".repeat(64), baseline_rollback_proof: "reduced-baseline", drain_SIGUSR2: "no" })))
      .toMatch(/enrolled_baseline_not_drainable/);
    expect(activationRefusal(legacy({ enrolled: "yes", enrollment_id: "a".repeat(64), baseline_digest: "b".repeat(64), baseline_rollback_proof: "reduced-baseline", protocol_version: "2" })))
      .toMatch(/enrolled_baseline_protocol_unsupported/);
    // #288: a drainable, protocol-1 enrolled host is no longer refused at all —
    // the capability gate is decomposed, not relaxed, and the two catalog RPCs
    // are demanded of the NEW release on the new connection instead.
    const eligible = legacy({ enrolled: "yes", enrollment_id: "a".repeat(64), baseline_digest: "b".repeat(64), baseline_rollback_proof: "reduced-baseline" });
    expect(firstActivationFromBaselineAllowed(eligible)).toBe(true);
    // …and the exception is scoped to legacy hosts, so it stops applying the
    // moment the entrypoint resolves into a managed release — and applies again
    // if the host later returns to a verified legacy baseline.
    expect(firstActivationFromBaselineAllowed(parseKeyValues(preflightReport(target, { rollout_ready: "no", enrolled: "yes", enrollment_id: "a".repeat(64), baseline_digest: "b".repeat(64), baseline_rollback_proof: "receipt" })))).toBe(false);
    expect(firstActivationFromBaselineAllowed(legacy({ enrolled: "no" }))).toBe(false);
    // The exception is a DECOMPOSITION of the gate, not a hole in it: the old
    // process must still be drainable and speak protocol 1, because the
    // transition itself depends on both.
    expect(firstActivationFromBaselineAllowed(legacy({ enrolled: "yes", enrollment_id: "a".repeat(64), baseline_digest: "b".repeat(64), baseline_rollback_proof: "reduced-baseline", drain_SIGUSR2: "no" }))).toBe(false);
    expect(firstActivationFromBaselineAllowed(legacy({ enrolled: "yes", enrollment_id: "a".repeat(64), baseline_digest: "b".repeat(64), baseline_rollback_proof: "reduced-baseline", protocol_version: "2" }))).toBe(false);
    expect(firstActivationFromBaselineAllowed(legacy({ enrolled: "drifted", enrollment_id: "a".repeat(64), baseline_digest: "b".repeat(64), baseline_rollback_proof: "reduced-baseline" }))).toBe(false);
    // A managed host keeps the original message; enrollment says nothing there.
    expect(activationRefusal(parseKeyValues(preflightReport(target, { rollout_ready: "no" })))).toBe(
      "active bridge lacks the verified drain/protocol/catalog capabilities required for activation or rollback"
    );
  });

  it("rejects unknown fields, shell characters, path ambiguity, and incomplete identities", () => {
    expect(() => resolveTarget(targets, "unknown-host")).toThrow(/unknown/);
    expect(() => parseArgs(["--target", "media-server", "--app", "anything"])).toThrow(/unknown option/);
    const base = { ...configured.targets["media-server"] };
    expect(() => validateTargetMap({ schemaVersion: 3, targets: { ok: { ...base, sshAlias: "host;id" } } })).toThrow(/unsafe SSH/);
    expect(() => validateTargetMap({ schemaVersion: 3, targets: { ok: { ...base, checkoutPath: "/safe/../escape", entrypointPath: "/safe/../escape/packages/bridge/dist/index.js" } } })).toThrow(/unsafe checkout/);
    expect(() => validateTargetMap({ schemaVersion: 3, targets: { ok: { ...base, surprise: "x" } } })).toThrow(/unknown target property/);
    expect(() => validateTargetMap({ schemaVersion: 3, targets: { ok: { sshAlias: null, pm2App: null, verifyAgent: null, rolloutEnabled: false } } })).toThrow(/requires a safe reason/);
    expect(() => validateTargetMap({ schemaVersion: 3, targets: { ok: { sshAlias: "known-host", pm2App: null, verifyAgent: null, rolloutEnabled: false, unmanagedReason: "wrong state" } } })).toThrow(/must not declare an unmanaged reason/);
  });

  it("constructs argv directly with every pinned identity field", () => {
    const target = resolveTarget(targets, "media-server");
    const ssh = makeSshCommand(target, ["preflight"], "fixed-script");
    expect(ssh.file).toBe("ssh"); expect(ssh.input).toBe("fixed-script"); expect(ssh.mutates).toBe(false);
    expect(ssh.args).toContain(target.nodePath); expect(ssh.args).toContain(target.entrypointPath); expect(ssh.args).toContain(target.pidFilePath); expect(ssh.args.at(-1)).toBe("preflight");
    const name = `${artifactName("a".repeat(40), "b".repeat(64))}.upload-${token}`;
    expect(makeScpCommand(target, "/tmp/release.tgz", name).args.at(-1)).toBe(`media-server:${target.releaseRoot}/incoming/${name}`);
  });
});

describe("bridge rollout gating and verification (#241)", () => {
  it("defaults to one-host dry-run and requires immutable phase identities", () => {
    expect(parseArgs(["--target", "media-server"])).toMatchObject({ action: "preflight", apply: false });
    expect(parseArgs(["--target", "media-server", "--stage", "--apply"])).toMatchObject({ action: "stage", apply: true });
    expect(() => parseArgs(["--target", "media-server", "--stage"])).toThrow(/requires --apply/);
    expect(() => parseArgs(["--target", "media-server", "--activate", "--sha", "a".repeat(40), "--checksum", "b".repeat(64), "--apply"])).toThrow(/stage-id/);
    expect(() => parseArgs(["--target", "media-server", "--rollback", "--apply"])).toThrow(/activation-id/);
    expect(() => parseArgs([])).toThrow(/exactly one host/);
  });

  it("dry-run accepts only a fully bound identity response", async () => {
    const target = resolveTarget(targets, "macbook-air");
    const fake = vi.fn(async (command: { mutates: boolean }) => { expect(command.mutates).toBe(false); return { stdout: preflightReport(target), stderr: "" }; });
    expect((await runPreflight(target, "fixed-script", fake)).report.pid).toBe("123");
    const mismatch = vi.fn(async () => ({ stdout: "bridge_id=other\npm2_app=seam-bridge\nidentity_bound=yes\n", stderr: "" }));
    await expect(runPreflight(target, "fixed-script", mismatch)).rejects.toThrow(/identity/);
    // #281: enrollment evidence is part of the bound identity response, and a
    // half-reported baseline is refused rather than read as "not enrolled".
    const halfEnrolled = vi.fn(async () => ({ stdout: preflightReport(target, { enrolled: "yes" }), stderr: "" }));
    await expect(runPreflight(target, "fixed-script", halfEnrolled)).rejects.toThrow(/enrollment evidence/);
    const wrongVerifier = vi.fn(async () => ({ stdout: preflightReport(target, { verification_agent: "other-agent" }), stderr: "" }));
    await expect(runPreflight(target, "fixed-script", wrongVerifier)).rejects.toThrow(/verification identity evidence/);
    const badStartTime = vi.fn(async () => ({ stdout: preflightReport(target, { process_started_at: "not-a-time" }), stderr: "" }));
    await expect(runPreflight(target, "fixed-script", badStartTime)).rejects.toThrow(/verification identity evidence/);
  });

  it("refuses an unsupported native runtime in preflight before staging", async () => {
    const target = resolveTarget(targets, "media-server");
    const fake = vi.fn(async (command: { mutates: boolean }) => {
      expect(command.mutates).toBe(false);
      return { stdout: preflightReport(target, { native_prebuild: "better-sqlite3@11.10.0-node-v137-darwin-x64", native_install_ready: "no" }), stderr: "" };
    });
    await expect(runPreflight(target, "fixed-script", fake)).rejects.toThrow(/no reviewed prebuild.*undeclared Python\/compiler toolchain/);
  });

  it("refuses a mapped SSH host whose reported bridge id differs from the target before mutation (#282)", async () => {
    const media = configured.targets["media-server"];
    const mapped = validateTargetMap({
      schemaVersion: 3,
      targets: { "macbook-pro": { ...media, sshAlias: "home-hub" } },
    });
    const target = resolveTarget(mapped, "macbook-pro");
    const fake = vi.fn(async (command: { mutates: boolean }) => {
      expect(command.mutates).toBe(false);
      return { stdout: preflightReport(target, { bridge_id: "home-hub" }), stderr: "" };
    });
    await expect(runPreflight(target, "fixed-script", fake)).rejects.toThrow(/remote deployment identity did not match/);
    expect(fake).toHaveBeenCalledOnce();
  });

  it("refuses checksum mismatch and dirty artifact sources", async () => {
    expect(verifyChecksum("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(() => verifyChecksum("a".repeat(64), "b".repeat(64))).toThrow(/checksum mismatch/);
    const fake = vi.fn(async () => ({ stdout: "?? investigation.txt\n", stderr: "" }));
    await expect(buildArtifact("/unused", fake)).rejects.toThrow(/dirty/);
  });

  it("requires nonce, target, PIDs, instance, ordered fresh window, controller ack and both RPCs", () => {
    const t0 = Date.parse("2026-09-08T00:00:00.000Z");
    const expected = { activationId: "a".repeat(64), bridgeId: "media-server", sha: "b".repeat(40), checksum: "c".repeat(64), stageId: "d".repeat(64), oldPid: 41, pid: 57, instanceId: "instance", protocolVersion: 1, agentId: "grok", notBefore: t0, notAfter: t0 + 10_000 };
    const good = { formatVersion: 2, activationId: expected.activationId, bridgeId: expected.bridgeId, sourceSha: expected.sha, artifactChecksum: expected.checksum, stageId: expected.stageId, oldPid: 41, pid: 57, instanceId: "instance", protocolVersion: 1, startedAt: "2026-09-08T00:00:00.000Z", helloAcceptedAt: "2026-09-08T00:00:01.000Z", controllerVerifiedAt: "2026-09-08T00:00:04.000Z", completedAt: "2026-09-08T00:00:04.000Z", catalogRpcs: { grok: { describeModelCatalogAt: "2026-09-08T00:00:02.000Z", fetchModelCatalogAt: "2026-09-08T00:00:03.000Z" } }, controllerAck: { activationId: expected.activationId, bridgeId: expected.bridgeId, instanceId: "instance", pid: 57, sourceSha: expected.sha, artifactChecksum: expected.checksum } };
    expect(validateReadyReceipt(good, expected)).toBe(true);
    expect(() => validateReadyReceipt({ ...good, activationId: "e".repeat(64) }, expected)).toThrow(/this activation/);
    expect(() => validateReadyReceipt({ ...good, pid: 41 }, expected)).toThrow(/process identity/);
    expect(() => validateReadyReceipt({ ...good, completedAt: "2026-09-09T00:00:00.000Z" }, expected)).toThrow(/stale/);
    expect(() => validateReadyReceipt({ ...good, controllerAck: undefined }, expected)).toThrow(/controller/);
    expect(() => validateReadyReceipt({ ...good, controllerAck: { ...good.controllerAck, artifactChecksum: "e".repeat(64) } }, expected)).toThrow(/controller/);
  });

  it("bounds subprocess duration/output and redacts diagnostics", async () => {
    await expect(commandRunner({ file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 20 })).rejects.toThrow(/timed out/);
    await expect(commandRunner({ file: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(1000))"] }, { maxStdoutBytes: 10 })).rejects.toThrow(/stdout limit/);
    await expect(commandRunner({ file: process.execPath, args: ["-e", "process.stderr.write('token=super-secret');process.exit(2)"] })).rejects.not.toThrow(/super-secret/);
  });

  it("generates only an explicit version-bound rollback", () => {
    expect(rollbackPlan(resolveTarget(targets, "media-server"), token)).toEqual({ target: "media-server", command: `npm run bridge:rollout -- --target media-server --rollback --activation-id ${token} --apply`, automatic: false });
  });

  it("separates an incomplete activation from deployed-but-unconfirmed verification output (#328)", () => {
    const local = fs.readFileSync(path.join(root, "scripts/bridge-rollout.mjs"), "utf8");
    const remote = fs.readFileSync(path.join(root, "scripts/bridge-rollout-remote.mjs"), "utf8");
    expect(local).toContain("activation=failed_or_incomplete");
    expect(local).not.toContain("activation=deployed_verification_unconfirmed");
    expect(remote).toContain("activation=deployed_verification_unconfirmed");
    expect(remote.indexOf('console.log("verification_reason=activation_receipt_timeout")'))
      .toBeLessThan(remote.indexOf("console.log(`rollback_command="));
  });

  it("contains SIGUSR2 only and no secret-bearing or immediate PM2 command", () => {
    const source = ["scripts/bridge-rollout-remote.sh", "scripts/bridge-rollout-remote.mjs", "scripts/bridge-rollout.mjs", "scripts/lib/bridge-rollout.mjs"].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
    expect(source).not.toMatch(/pm2\s+(?:restart|reload|jlist|prettylist|env)\b/i);
    expect(source).not.toMatch(/SIGTERM|SIGKILL.*oldPid/);
    expect(source).toContain('process.kill(before.pid, "SIGUSR2")');
    expect(source).toContain('preflight.report.rollout_ready !== "yes"');
  });
});
