import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { artifactName, buildArtifact, commandRunner, makeScpCommand, makeSshCommand, parseArgs, resolveTarget, rollbackPlan, runPreflight, validateReadyReceipt, validateTargetMap, verifyChecksum } from "../scripts/lib/bridge-rollout.mjs";

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
    enrolled: "no",
    enrollment_id: "none",
    baseline_digest: "none",
    baseline_receipt_capable: "none",
    node_path: target.nodePath,
    node_version: "v24.15.0",
    npm_version: "11.6.2",
    disk_path: target.checkoutPath,
    disk_bytes_available: "1024",
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
    expect(() => makeScpCommand(target, "/tmp/release.tgz", `${artifactName("a".repeat(40), "b".repeat(64))}.upload-${token}`)).toThrow(/explicitly unmanaged/);
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

  it("contains SIGUSR2 only and no secret-bearing or immediate PM2 command", () => {
    const source = ["scripts/bridge-rollout-remote.sh", "scripts/bridge-rollout-remote.mjs", "scripts/bridge-rollout.mjs", "scripts/lib/bridge-rollout.mjs"].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
    expect(source).not.toMatch(/pm2\s+(?:restart|reload|jlist|prettylist|env)\b/i);
    expect(source).not.toMatch(/SIGTERM|SIGKILL.*oldPid/);
    expect(source).toContain('process.kill(before.pid, "SIGUSR2")');
    expect(source).toContain('preflight.report.rollout_ready !== "yes"');
  });
});
