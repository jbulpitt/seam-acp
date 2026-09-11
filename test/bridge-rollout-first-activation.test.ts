/**
 * #288 — the first managed activation, taken from an enrolled baseline.
 *
 * A legacy host has no managed release to roll back to, so activation refused
 * even after #281 gave it a verified, restorable baseline. This exercises the
 * decision: the baseline may serve as that first transition's rollback target.
 *
 * The fixture deliberately models `media-server`: the deployed bytes have the
 * SIGUSR2 drain and protocol 1 but NEITHER catalog RPC, so the baseline records
 * `rollbackProof: "reduced-baseline"` and a rollback onto it can never produce
 * the ordinary receipt. The forward direction is not weakened — the new release
 * is receipt-capable and must still present the full receipt.
 *
 * Everything runs against a disposable filesystem with real processes and a
 * fake PM2 module. No remote host is contacted, staged, activated or signalled.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { commandRunner, parseKeyValues, renderRemoteScript } from "../scripts/lib/bridge-rollout.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const H = (v: string) => v.repeat(64);
const fixtures: Fixture[] = [];
type Fixture = Awaited<ReturnType<typeof makeFixture>>;

function put(b: Buffer, o: number, l: number, v: string) { b.write(v, o, Math.min(l, Buffer.byteLength(v)), "utf8"); }
function oct(b: Buffer, o: number, l: number, v: number) { put(b, o, l, `${v.toString(8).padStart(l - 1, "0")}\0`); }
function tarMember(name: string, bytes: Buffer) {
  const h = Buffer.alloc(512);
  put(h, 0, 100, name); oct(h, 100, 8, 0o600); oct(h, 108, 8, process.getuid!()); oct(h, 116, 8, process.getgid!());
  oct(h, 124, 12, bytes.length); oct(h, 136, 12, 0); h.fill(32, 148, 156); h[156] = 48;
  put(h, 257, 6, "ustar\0"); put(h, 263, 2, "00");
  put(h, 148, 8, `${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `);
  return Buffer.concat([h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

/** A release whose bytes ARE receipt-capable: protocol 1, drain, both RPCs. */
const CAPABLE_COMMAND_BUS = 'export const PROTOCOL_VERSION = 1;\nconst m = ["describeModelCatalog", "fetchModelCatalog"];\n';
const CAPABLE_RPC = 'export function isAllowedRpcMethod(){return true}\nexport function dispatchAdapter(){}\n';
/** The pre-catalog shape: drain and protocol 1, neither catalog RPC. */
const LEGACY_COMMAND_BUS = 'export const PROTOCOL_VERSION = 1;\nconst m = [];\n';

function makeArchive(sourceSha: string, indexSource: string) {
  const names = ["package.json", "package-lock.json", "packages/adapters/package.json", "packages/bridge/package.json", "packages/core/package.json"];
  const files = names.map((name) => ({ path: name, bytes: Buffer.from(readFileSync(path.join(repo, name))) }));
  files.push(
    { path: "packages/adapters/dist/index.js", bytes: Buffer.from("export {};\n") },
    { path: "packages/adapters/dist/command-bus.js", bytes: Buffer.from(CAPABLE_COMMAND_BUS) },
    { path: "packages/bridge/dist/index.js", bytes: Buffer.from(indexSource) },
    { path: "packages/bridge/dist/rpc.js", bytes: Buffer.from(CAPABLE_RPC) },
  );
  const manifest = Buffer.from(`${JSON.stringify({ formatVersion: 2, sourceSha, files: files.map((f) => ({ path: f.path, size: f.bytes.length, sha256: createHash("sha256").update(f.bytes).digest("hex") })) })}\n`);
  return gzipSync(Buffer.concat([tarMember("bridge-release.json", manifest), ...files.map((f) => tarMember(f.path, f.bytes)), Buffer.alloc(1024)]));
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-first-activation-"));
  const checkout = path.join(root, "checkout");
  const releaseRoot = path.join(root, "rollouts");
  const entry = path.join(checkout, "packages/bridge/dist/index.js");
  const pidFile = path.join(root, "bridge.pid");
  const pm2File = path.join(root, "pm2.json");
  const pm2Module = path.join(root, "pm2.cjs");
  const runtime = path.join(root, "runtime");
  const node = path.join(runtime, "node");
  const checkoutSha = "a".repeat(39) + "3";

  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.mkdir(path.join(checkout, "packages/adapters/dist"), { recursive: true });
  await fs.mkdir(path.join(checkout, "node_modules/ws"), { recursive: true });
  await fs.mkdir(runtime);
  await fs.link(process.execPath, node);
  await fs.writeFile(path.join(runtime, "npm"), "#!/bin/sh\nmkdir -p node_modules/@agentclientprotocol/sdk node_modules/@types/ws node_modules/better-sqlite3 node_modules/ws node_modules/@seam/adapters\necho 10.9.0\n", { mode: 0o755 });

  // One bridge source for both the legacy checkout and the staged release: it
  // drains on SIGUSR2 by spawning a replacement through the stable entrypoint,
  // and writes the activation receipt when it finds an envelope beside itself.
  const bridgeSource = `import fs from 'node:fs';import path from 'node:path';import{spawn}from'node:child_process';` +
    `const entry=${JSON.stringify(entry)},pidFile=${JSON.stringify(pidFile)},pm2File=${JSON.stringify(pm2File)},node=${JSON.stringify(node)},cwd=${JSON.stringify(checkout)};` +
    `function update(pid){const j=JSON.parse(fs.readFileSync(pm2File));j.pid=pid;fs.writeFileSync(pm2File,JSON.stringify(j));fs.writeFileSync(pidFile,String(pid));}` +
    `const release=path.resolve(new URL('.',import.meta.url).pathname,'../../..');` +
    `const ep=path.join(release,'activation-envelope.json'),rp=path.join(release,'release-receipt.json');` +
    `if(fs.existsSync(ep)){const e=JSON.parse(fs.readFileSync(ep)),s=JSON.parse(fs.readFileSync(rp)),t=new Date().toISOString(),instance='instance-'+e.activationId.slice(0,12);` +
    `fs.writeFileSync(rp,JSON.stringify({...s,...e,pid:process.pid,instanceId:instance,protocolVersion:1,startedAt:e.startedAt,helloAcceptedAt:t,catalogRpcs:{grok:{describeModelCatalogAt:t,fetchModelCatalogAt:t}},controllerAck:{activationId:e.activationId,bridgeId:e.bridgeId,instanceId:instance,pid:process.pid,sourceSha:e.sourceSha,artifactChecksum:e.artifactChecksum},controllerVerifiedAt:t,completedAt:t})+'\\n');}` +
    `process.on('SIGUSR2',()=>{const c=spawn(node,[entry],{cwd,detached:true,stdio:'ignore'});c.unref();update(c.pid);setTimeout(()=>process.exit(0),100);});setInterval(()=>{},1000);\n`;

  await fs.writeFile(entry, bridgeSource);
  await fs.writeFile(path.join(checkout, "packages/bridge/package.json"), JSON.stringify({ name: "@seam/bridge", version: "0.1.0" }));
  await fs.writeFile(path.join(checkout, "packages/adapters/dist/command-bus.js"), LEGACY_COMMAND_BUS);
  await fs.writeFile(path.join(checkout, "packages/bridge/dist/rpc.js"), CAPABLE_RPC);
  await fs.writeFile(path.join(checkout, "node_modules/ws/index.js"), "module.exports = {};\n");
  await fs.writeFile(path.join(checkout, "package.json"), JSON.stringify({ name: "seam-acp", version: "0.1.0" }));
  await fs.mkdir(path.join(checkout, ".git"));
  await fs.writeFile(path.join(checkout, ".git/HEAD"), `${checkoutSha}\n`);
  await fs.writeFile(pm2Module, `const fs=require('fs'),p=${JSON.stringify(pm2File)};module.exports={connect(cb){setImmediate(()=>cb(null))},describe(_n,cb){const j=JSON.parse(fs.readFileSync(p,'utf8'));setImmediate(()=>cb(null,[{pid:j.pid,pm2_env:{name:j.name,pm_cwd:j.cwd,pm_exec_path:j.entry,exec_interpreter:j.node,args:['connect','--server','wss://controller.invalid','--token','fixture-token','--id','fixture']}}]))},disconnect(){}}`);

  const child = spawn(node, [entry], { cwd: checkout, detached: true, stdio: "ignore" });
  child.unref();
  await fs.writeFile(pidFile, String(child.pid));
  await fs.writeFile(pm2File, JSON.stringify({ pid: child.pid, name: "fixture-app", cwd: checkout, entry, node }));

  const shell = await renderRemoteScript(path.join(repo, "scripts/bridge-rollout-remote.sh"), path.join(repo, "scripts/bridge-rollout-remote.mjs"));
  const base = ["fixture", "fixture-app", "grok", String(process.getuid!()), checkout, entry, pidFile, node, pm2Module, "-", "no", releaseRoot];
  const run = (action: string[], timeoutMs = 60_000) =>
    commandRunner({ file: "/bin/sh", args: ["-s", "--", node, ...base, ...action], input: shell, timeoutMs });

  const stage = async (sourceSha: string, operation: string) => {
    const bytes = makeArchive(sourceSha, bridgeSource);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const upload = `bridge-${sourceSha}-${checksum}.tgz.upload-${operation}`;
    await run(["prepare-upload", operation]);
    await fs.mkdir(path.join(releaseRoot, "incoming"), { recursive: true });
    await fs.writeFile(path.join(releaseRoot, "incoming", upload), bytes);
    await run(["stage", sourceSha, checksum, upload, operation], 120_000);
    return { sourceSha, checksum, stageId: operation, release: path.join(releaseRoot, "releases", `${sourceSha}-${checksum}`) };
  };

  const value = { root, checkout, releaseRoot, entry, pidFile, run, stage, checkoutSha, bridgeSource };
  fixtures.push(value);
  return value;
}

const baselineDir = (f: Fixture) => path.join(f.releaseRoot, "baselines");
const enroll = (f: Fixture, id = H("1")) => f.run(["enroll", id, H("2")]);
const livePid = async (f: Fixture) => Number(await fs.readFile(f.pidFile, "utf8"));

afterEach(async () => {
  while (fixtures.length) {
    const fixture = fixtures.pop()!;
    try { process.kill(await livePid(fixture), "SIGKILL"); } catch { /* already gone */ }
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

describe.sequential("#288 first managed activation from an enrolled baseline", () => {
  it("activates a pre-catalog host, records the reduced rollback, and self-retires", async () => {
    const f = await makeFixture();
    const enrolled = parseKeyValues((await enroll(f)).stdout);
    // The media-server shape: drain and protocol 1, no catalog RPCs.
    expect(enrolled.baseline_rollback_proof).toBe("reduced-baseline");

    const first = await f.stage("1".repeat(40), H("3"));
    const oldPid = await livePid(f);
    const activation = H("4");
    const result = parseKeyValues((await f.run(["activate", first.sourceSha, first.checksum, first.stageId, activation, "20", H("5")])).stdout);

    expect(result.activation).toBe("verified");
    expect(result.activation_from).toBe("enrolled-baseline");
    expect(result.rollback_proof).toBe("reduced-baseline");
    expect(result.old_pid).toBe(String(oldPid));
    expect(await fs.realpath(f.entry)).toBe(path.join(first.release, "packages/bridge/dist/index.js"));

    // The FORWARD proof is the ordinary receipt, not a reduced one.
    const verified = JSON.parse(await fs.readFile(path.join(f.releaseRoot, "activations", `${activation}.verified.json`), "utf8"));
    expect(verified.verification).toEqual({ forward: "receipt", catalogRpcsVerified: true });
    expect(verified.instanceId).toMatch(/^instance-/);
    // …and the rollback target is recorded as the baseline, with the weaker
    // proof named at intent time rather than discovered later.
    expect(verified.previous).toMatchObject({
      kind: "enrolled-baseline",
      enrollmentId: H("1"),
      entrypoint: f.entry,
      rollbackProof: "reduced-baseline",
    });

    // SELF-RETIRING: a second activation finds a managed previous release and
    // takes the ordinary receipt path, with no baseline involvement at all.
    const second = await f.stage("2".repeat(40), H("6"));
    const secondActivation = H("7");
    const again = parseKeyValues((await f.run(["activate", second.sourceSha, second.checksum, second.stageId, secondActivation, "20", H("8")])).stdout);
    expect(again.activation).toBe("verified");
    expect(again.activation_from).toBeUndefined();
    const secondVerified = JSON.parse(await fs.readFile(path.join(f.releaseRoot, "activations", `${secondActivation}.verified.json`), "utf8"));
    expect(secondVerified.previous.kind).toBeUndefined();
    expect(secondVerified.previous).toMatchObject({ sourceSha: first.sourceSha, artifactChecksum: first.checksum });
  }, 180_000);

  it("rolls back onto the baseline with the strongest proof it can emit, recorded as reduced", async () => {
    const f = await makeFixture();
    await enroll(f);
    const release = await f.stage("1".repeat(40), H("3"));
    const activation = H("4");
    await f.run(["activate", release.sourceSha, release.checksum, release.stageId, activation, "20", H("5")]);

    const rollbackId = H("9");
    const rolled = parseKeyValues((await f.run(["rollback", activation, rollbackId, "20", H("a")])).stdout);
    expect(rolled.rollback).toBe("verified");
    expect(rolled.rollback_to).toBe("enrolled-baseline");
    expect(rolled.rollback_proof).toBe("reduced-baseline");
    // Stated in the operator output as well as the record.
    expect(rolled.catalog_rpcs_verified).toBe("no");

    // The entrypoint is the checkout's own regular file again, byte-exact.
    expect(await fs.realpath(f.entry)).toBe(f.entry);
    expect((await fs.lstat(f.entry)).isSymbolicLink()).toBe(false);
    expect(createHash("sha256").update(await fs.readFile(f.entry)).digest("hex")).toBe(rolled.restored_entrypoint_sha256);

    const record = JSON.parse(await fs.readFile(path.join(f.releaseRoot, "rollbacks", `${activation}-${rollbackId}.verified.json`), "utf8"));
    // A later reader can tell exactly which verification this transition got.
    expect(record.verification).toMatchObject({
      proof: "reduced-baseline",
      catalogRpcsVerified: false,
      controllerObserved: false,
    });
    expect(record.proved).toMatchObject({
      oldPidExited: true,
      protocolVersion: "1",
      drainSigusr2: "yes",
      bridgeId: "fixture",
    });
    // No receipt is claimed anywhere in the record.
    expect(record.readyReceipt).toBeUndefined();
    expect(record.instanceId).toBeUndefined();
  }, 180_000);

  it("refuses when the baseline drifted between enrollment and activation", async () => {
    const f = await makeFixture();
    await enroll(f);
    const release = await f.stage("1".repeat(40), H("3"));
    // A dormant runtime file moves after enrollment: the baseline is no longer
    // a restore target, so it cannot be this transition's rollback target.
    await fs.writeFile(path.join(f.checkout, "node_modules/ws/index.js"), "module.exports = { drifted: true };\n");
    const entryBefore = await fs.realpath(f.entry);

    await expect(
      f.run(["activate", release.sourceSha, release.checksum, release.stageId, H("4"), "20", H("5")])
    ).rejects.toThrow(/enrolled_baseline_state_drift/);
    // Nothing moved.
    expect(await fs.realpath(f.entry)).toBe(entryBefore);
    await expect(fs.stat(path.join(f.releaseRoot, "activations", `${H("4")}.intent.json`))).rejects.toThrow();
    await expect(fs.stat(path.join(baselineDir(f), "current.json"))).resolves.toBeTruthy();
  }, 180_000);

  it("keeps refusing a legacy host with no baseline at all", async () => {
    const f = await makeFixture();
    const release = await f.stage("1".repeat(40), H("3"));
    await expect(
      f.run(["activate", release.sourceSha, release.checksum, release.stageId, H("4"), "20", H("5")])
    ).rejects.toThrow(/legacy_previous_release_not_receipt_capable/);
    expect(await fs.realpath(f.entry)).toBe(f.entry);
  }, 180_000);

  it("refuses the rollback when the baseline drifts after activation", async () => {
    const f = await makeFixture();
    await enroll(f);
    const release = await f.stage("1".repeat(40), H("3"));
    const activation = H("4");
    await f.run(["activate", release.sourceSha, release.checksum, release.stageId, activation, "20", H("5")]);
    const activated = await fs.realpath(f.entry);

    // Drift after the switch: restore must refuse mid-rollback rather than put
    // the entrypoint back onto a tree that is no longer the recorded baseline.
    await fs.writeFile(path.join(f.checkout, "node_modules/ws/index.js"), "module.exports = { drifted: true };\n");
    await expect(
      f.run(["rollback", activation, H("9"), "20", H("a")])
    ).rejects.toThrow(/baseline_runtime_tree_mismatch/);
    // The failed release is still active; nothing was half-restored.
    expect(await fs.realpath(f.entry)).toBe(activated);
    expect((await fs.lstat(f.entry)).isSymbolicLink()).toBe(true);
  }, 180_000);

  it("refuses a first activation onto a release that is not receipt-capable either", async () => {
    const f = await makeFixture();
    await enroll(f);
    const release = await f.stage("1".repeat(40), H("3"));
    // Strip the catalog RPCs from the staged release, so neither direction
    // could be proven. The tree digest check catches the edit first; either way
    // the transition is refused and nothing is switched.
    await fs.chmod(release.release, 0o700);
    await fs.chmod(path.join(release.release, "packages/adapters/dist"), 0o700);
    await fs.writeFile(path.join(release.release, "packages/adapters/dist/command-bus.js"), LEGACY_COMMAND_BUS);
    await expect(
      f.run(["activate", release.sourceSha, release.checksum, release.stageId, H("4"), "20", H("5")])
    ).rejects.toThrow(/release_manifest_file_changed|release_tree_digest_mismatch|first_activation_release_not_receipt_capable/);
    expect(await fs.realpath(f.entry)).toBe(f.entry);
  }, 180_000);
});
