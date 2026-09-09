import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { artifactName, buildArtifact, commandRunner, makeScpCommand, makeSshCommand, parseArgs, resolveTarget, rollbackPlan, runPreflight, validateReadyReceipt, validateTargetMap, verifyChecksum } from "../scripts/lib/bridge-rollout.mjs";

const root = path.resolve(import.meta.dirname, "..");
const configured = JSON.parse(fs.readFileSync(path.join(root, "ops/bridge/targets.json"), "utf8"));
const targets = validateTargetMap(configured);
const token = "c".repeat(64);

describe("bridge rollout target safety (#241)", () => {
  it("pins the full operator-owned deployment identity", () => {
    expect(resolveTarget(targets, "media-server")).toMatchObject({ bridgeId: "media-server", sshAlias: "media-server", pm2App: "remote-agent-bridge", expectedUid: 501, checkoutPath: "/Users/jesse/seam-acp", entrypointPath: "/Users/jesse/seam-acp/packages/bridge/dist/index.js", pidFilePath: "/Users/jesse/.pm2/pids/remote-agent-bridge-0.pid", releaseRoot: "/Users/jesse/.seam/bridge-rollouts" });
    expect(resolveTarget(targets, "macbook-air")).toMatchObject({ bridgeId: "macbook-air", sshAlias: "macbook-air", pm2App: "seam-bridge", expectedUid: 501, workspaceArg: "/Users/jessebulpitt" });
  });

  it("keeps AGY-only hosts mapped but outside this rollout", () => {
    expect(configured.targets["jennifer-laptop"].sshAlias).toBe("macbook-air-j");
    expect(() => resolveTarget(targets, "jennifer-laptop")).toThrow(/AGY-only/);
  });

  it("rejects unknown fields, shell characters, path ambiguity, and incomplete identities", () => {
    expect(() => resolveTarget(targets, "unknown-host")).toThrow(/unknown/);
    expect(() => parseArgs(["--target", "media-server", "--app", "anything"])).toThrow(/unknown option/);
    const base = { ...configured.targets["media-server"] };
    expect(() => validateTargetMap({ schemaVersion: 2, targets: { ok: { ...base, sshAlias: "host;id" } } })).toThrow(/unsafe SSH/);
    expect(() => validateTargetMap({ schemaVersion: 2, targets: { ok: { ...base, checkoutPath: "/safe/../escape", entrypointPath: "/safe/../escape/packages/bridge/dist/index.js" } } })).toThrow(/unsafe checkout/);
    expect(() => validateTargetMap({ schemaVersion: 2, targets: { ok: { ...base, surprise: "x" } } })).toThrow(/unknown target property/);
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
    const fake = vi.fn(async (command: { mutates: boolean }) => { expect(command.mutates).toBe(false); return { stdout: `reachable=yes\nbridge_id=macbook-air\npm2_app=seam-bridge\nidentity_bound=yes\nremote_mutation=no\npid=123\nplatform=darwin-arm64\nartifact_mode=managed\nartifact_identity=${"a".repeat(40)}:${"b".repeat(64)}\nartifact_source_sha=${"a".repeat(40)}\ncheckout_source_sha=not-applicable\nartifact_checksum=${"b".repeat(64)}\nentrypoint_sha256=${"c".repeat(64)}\nbridge_version=0.1.0\nprotocol_version=1\ndrain_SIGUSR2=yes\ndescribeModelCatalog=yes\nfetchModelCatalog=yes\nrollout_ready=yes\nnode_path=${target.nodePath}\nnode_version=v24.15.0\nnpm_version=11.6.2\ndisk_path=${target.checkoutPath}\ndisk_bytes_available=1024\n`, stderr: "" }; });
    expect((await runPreflight(target, "fixed-script", fake)).report.pid).toBe("123");
    const mismatch = vi.fn(async () => ({ stdout: "bridge_id=other\npm2_app=seam-bridge\nidentity_bound=yes\n", stderr: "" }));
    await expect(runPreflight(target, "fixed-script", mismatch)).rejects.toThrow(/identity/);
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
