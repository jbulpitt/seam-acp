import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGzip, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandRunner, renderRemoteScript } from "../scripts/lib/bridge-rollout.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const H = (value: string) => value.repeat(64);
const sha = "a".repeat(40);
let fixture = ""; let checkout = ""; let releaseRoot = ""; let entrypoint = ""; let pidFile = ""; let pm2Module = ""; let remoteScript = ""; let bridge: ChildProcess;

function field(block: Buffer, offset: number, length: number, value: string) { block.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8"); }
function octal(block: Buffer, offset: number, length: number, value: number) { field(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`); }
function member(name: string, options: { type?: string; bytes?: Buffer; size?: number; link?: string } = {}) {
  const bytes = options.bytes ?? Buffer.alloc(0); const size = options.size ?? bytes.length; const block = Buffer.alloc(512);
  field(block, 0, 100, name); octal(block, 100, 8, 0o600); octal(block, 108, 8, process.getuid!()); octal(block, 116, 8, process.getgid!()); octal(block, 124, 12, size); octal(block, 136, 12, 0);
  block.fill(0x20, 148, 156); block[156] = (options.type ?? "0").charCodeAt(0); if (options.link) field(block, 157, 100, options.link); field(block, 257, 6, "ustar\0"); field(block, 263, 2, "00");
  const checksum = block.reduce((sum, byte) => sum + byte, 0); field(block, 148, 8, `${checksum.toString(8).padStart(6,"0")}\0 `);
  return Buffer.concat([block, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}
function archive(members: Buffer[]) { return gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]), { mtime: 0 } as never); }
async function expansionBomb() {
  const gzip=createGzip(); const chunks:Buffer[]=[]; gzip.on("data",(chunk)=>chunks.push(chunk)); const zero=Buffer.alloc(1024*1024);
  for(let index=0;index<129;index+=1) if(!gzip.write(zero)) await once(gzip,"drain");
  gzip.end(); await once(gzip,"end"); return Buffer.concat(chunks);
}
function artifactFiles() {
  const names = ["package.json","package-lock.json","packages/adapters/package.json","packages/bridge/package.json","packages/core/package.json"];
  const items = names.map((name) => ({ path: name, bytes: requireBytes(name) }));
  items.push({ path: "packages/adapters/dist/index.js", bytes: Buffer.from("export {};\n") }, { path: "packages/bridge/dist/index.js", bytes: Buffer.from("// SIGUSR2\nsetInterval(()=>{},1000);\n") }, { path: "packages/bridge/dist/rpc.js", bytes: Buffer.from("// isAllowedRpcMethod dispatchAdapter\n") });
  return items;
}
function requireBytes(relative: string) { return Buffer.from(readFileSync(path.join(repo, relative))); }
function validArchive(extra: { path: string; bytes: Buffer }[] = []) {
  const files = [...artifactFiles(), ...extra];
  const manifest = Buffer.from(`${JSON.stringify({ formatVersion: 2, sourceSha: sha, files: files.map((item) => ({ path: item.path, size: item.bytes.length, sha256: createHash("sha256").update(item.bytes).digest("hex") })) })}\n`);
  return archive([member("bridge-release.json", { bytes: manifest }), ...files.map((item) => member(item.path, { bytes: item.bytes }))]);
}

async function writePm2(overrides: Record<string, unknown> = {}) {
  const config = { pid: bridge.pid, name: "fixture-app", pm_cwd: checkout, pm_exec_path: entrypoint, exec_interpreter: process.execPath, args: ["connect","--server","wss://controller.invalid","--token","fixture-token","--id","fixture"], ...overrides };
  await fs.writeFile(path.join(fixture,"pm2.json"), JSON.stringify(config));
}

function baseArgs(overrides: Partial<{ bridgeId:string; app:string; uid:string; checkout:string; entrypoint:string; pidFile:string }> = {}) {
  return [overrides.bridgeId ?? "fixture", overrides.app ?? "fixture-app", "grok", overrides.uid ?? String(process.getuid!()), overrides.checkout ?? checkout, overrides.entrypoint ?? entrypoint, overrides.pidFile ?? pidFile, process.execPath, pm2Module, "-", "no", releaseRoot];
}

async function runRemote(action: string[], overrides = {}) {
  return commandRunner({ file: "/bin/sh", args: ["-s","--",process.execPath,...baseArgs(overrides),...action], input: remoteScript, timeoutMs: 30_000 });
}

async function stageBytes(bytes: Buffer, operationId = H("1")) {
  const checksum = createHash("sha256").update(bytes).digest("hex"); const upload = `bridge-${sha}-${checksum}.tgz.upload-${operationId}`;
  await fs.mkdir(path.join(releaseRoot,"incoming"), { recursive: true }); await fs.writeFile(path.join(releaseRoot,"incoming",upload), bytes);
  return runRemote(["stage",sha,checksum,upload,operationId]);
}

beforeAll(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(),"bridge-rollout-hostile-")); checkout = path.join(fixture,"checkout"); releaseRoot = path.join(fixture,"rollouts"); entrypoint = path.join(checkout,"packages/bridge/dist/index.js"); pidFile = path.join(fixture,"fixture.pid"); pm2Module = path.join(fixture,"pm2-module");
  await fs.mkdir(path.dirname(entrypoint), { recursive: true }); await fs.mkdir(path.join(checkout,"packages/adapters/dist"),{recursive:true}); await fs.mkdir(path.join(checkout,".git")); await fs.mkdir(pm2Module);
  await fs.writeFile(entrypoint, "process.title='fixture-bridge';process.on('SIGUSR2',()=>{});setInterval(()=>{},1000);\n");
  await fs.writeFile(path.join(checkout,"packages/bridge/package.json"),requireBytes("packages/bridge/package.json"));
  await fs.writeFile(path.join(checkout,"packages/bridge/dist/rpc.js"),"// isAllowedRpcMethod dispatchAdapter\n");
  await fs.writeFile(path.join(checkout,"packages/adapters/dist/command-bus.js"),'export const PROTOCOL_VERSION = 1;\nconst methods = ["describeModelCatalog", "fetchModelCatalog"];\n');
  await fs.writeFile(path.join(checkout,".git/HEAD"),`${sha}\n`);
  bridge = spawn(process.execPath, [entrypoint], { cwd: checkout, stdio: "ignore" }); await new Promise((resolve) => setTimeout(resolve,100));
  await fs.writeFile(pidFile, String(bridge.pid)); await fs.writeFile(path.join(pm2Module,"package.json"), JSON.stringify({ type:"commonjs", main:"index.cjs" }));
  await fs.writeFile(path.join(pm2Module,"index.cjs"), `const fs=require('fs');const p=${JSON.stringify(path.join(fixture,"pm2.json"))};module.exports={connect(cb){cb(null)},describe(_n,cb){const j=JSON.parse(fs.readFileSync(p));cb(null,[{pid:j.pid,pm2_env:{name:j.name,pm_cwd:j.pm_cwd,pm_exec_path:j.pm_exec_path,exec_interpreter:j.exec_interpreter,args:j.args}}])},disconnect(){}};`);
  await writePm2(); remoteScript = await renderRemoteScript(path.join(repo,"scripts/bridge-rollout-remote.sh"),path.join(repo,"scripts/bridge-rollout-remote.mjs")); await runRemote(["prepare-upload",H("f")]);
});

afterAll(async () => { if (bridge?.pid) { try { process.kill(bridge.pid,"SIGKILL"); } catch {} } await fs.rm(fixture,{recursive:true,force:true}); });

describe.sequential("production remote shell archive defenses (#241)", () => {
  const attacks: Array<[string, () => Buffer, RegExp]> = [
    ["absolute path", () => archive([member("/absolute")]), /archive_unsafe_path/],
    ["dot-dot traversal", () => archive([member("../escape")]), /archive_traversal/],
    ["ambiguous normalization", () => archive([member("a//b")]), /archive_ambiguous_path/],
    ["control character", () => archive([member("bad\nname")]), /archive_unsafe_path/],
    ["empty path", () => archive([member("")]), /archive_unsafe_path/],
    ["symlink", () => archive([member("link",{type:"2",link:"outside"})]), /archive_non_regular_member/],
    ["hardlink", () => archive([member("link",{type:"1",link:"outside"})]), /archive_non_regular_member/],
    ["device", () => archive([member("dev",{type:"3"})]), /archive_non_regular_member/],
    ["FIFO", () => archive([member("fifo",{type:"6"})]), /archive_non_regular_member/],
    ["socket-like special", () => archive([member("socket",{type:"7"})]), /archive_non_regular_member/],
    ["duplicate", () => archive([member("same"),member("same")]), /archive_duplicate_path/],
    ["path-prefix conflict", () => archive([member("parent"),member("parent/child")]), /archive_path_prefix_conflict/],
    ["member count", () => archive(Array.from({length:2001},(_,index)=>member(`f${index}`))), /archive_member_count_limit/],
    ["member expansion", () => archive([member("huge",{size:16*1024*1024+1})]), /archive_member_size_limit/],
    ["unexpected root", () => validArchive([{ path:"unexpected.txt",bytes:Buffer.from("x") }]), /archive_unexpected_file/],
  ];
  for (const [label, make, error] of attacks) it(`rejects ${label} through the shipped shell`, async () => { await expect(stageBytes(make(), createHash("sha256").update(label).digest("hex"))).rejects.toThrow(error); });

  it("rejects excessive total expansion before parsing or extraction",async()=>{await expect(stageBytes(await expansionBomb(),H("e"))).rejects.toThrow(/archive_invalid_or_expansion_limit/);},60_000);

  it("rejects malicious existing release instead of trusting one state file", async () => {
    const bytes = validArchive(); const checksum = createHash("sha256").update(bytes).digest("hex"); const release = path.join(releaseRoot,"releases",`${sha}-${checksum}`);
    await fs.mkdir(release,{recursive:true}); const outside = path.join(fixture,"outside-receipt.json"); await fs.writeFile(outside,JSON.stringify({formatVersion:2,bridgeId:"fixture",sourceSha:sha,artifactChecksum:checksum,stageId:H("1"),treeDigest:H("2")})); await fs.symlink(outside,path.join(release,"release-receipt.json"));
    await expect(stageBytes(bytes,H("3"))).rejects.toThrow(/release_receipt_wrong_type/);
  });

  it("refuses a concurrent fresh target lock and audits a stale interrupted lock", async () => {
    const lock = path.join(releaseRoot,"locks/fixture"); await fs.rm(lock,{recursive:true,force:true}); await fs.mkdir(lock,{recursive:true}); await fs.writeFile(path.join(lock,"owner.json"),JSON.stringify({operationId:H("4"),pid:process.pid,createdAt:new Date().toISOString()}));
    await expect(stageBytes(archive([member("x")]),H("5"))).rejects.toThrow(/target_lock_busy/);
    await fs.rm(lock,{recursive:true,force:true}); await fs.mkdir(lock,{recursive:true}); await fs.writeFile(path.join(lock,"owner.json"),JSON.stringify({operationId:H("6"),pid:2147483647,createdAt:new Date(Date.now()-20*60_000).toISOString()}));
    await expect(stageBytes(archive([member("../stale")]),H("7"))).rejects.toThrow(/archive_traversal/);
    expect((await fs.readdir(path.join(releaseRoot,"stale-locks"))).some((name) => name.startsWith(`fixture-${H("6")}-`))).toBe(true);
  });
});

describe.sequential("production remote shell deployment identity defenses (#241)", () => {
  it("accepts the exact bound process and rejects wrong app, UID, PID/cwd, and launcher", async () => {
    const preflight = await runRemote(["preflight"]);
    expect(preflight.stdout).toContain("identity_bound=yes"); expect(preflight.stdout).toContain("remote_mutation=no");
    expect(preflight.stdout).toContain(`checkout_source_sha=${sha}`); expect(preflight.stdout).toContain("artifact_source_sha=unmanaged"); expect(preflight.stdout).toContain("artifact_mode=legacy-checkout"); expect(preflight.stdout).toMatch(/artifact_identity=entrypoint-sha256:[0-9a-f]{64}/);
    expect(preflight.stdout).toContain("protocol_version=1"); expect(preflight.stdout).toContain("drain_SIGUSR2=yes");
    expect(preflight.stdout).toContain("describeModelCatalog=yes"); expect(preflight.stdout).toContain("fetchModelCatalog=yes");
    expect(preflight.stdout).toMatch(/node_version=v(?:2[2-9]|[3-9]\d)\./); expect(preflight.stdout).toMatch(/npm_version=\d+\.\d+\.\d+/); expect(preflight.stdout).toMatch(/disk_bytes_available=\d+/);
    await expect(runRemote(["preflight"],{app:"wrong-app"})).rejects.toThrow(/pm2_app_pid_mismatch/);
    await expect(runRemote(["preflight"],{uid:String(process.getuid!()+1)})).rejects.toThrow(/wrong_owner/);
    const otherPid = path.join(fixture,"other.pid"); await fs.writeFile(otherPid,String(process.pid)); await expect(runRemote(["preflight"],{pidFile:otherPid})).rejects.toThrow(/process_cwd_mismatch/);
    await writePm2({pm_exec_path:path.join(checkout,"other.js")}); await expect(runRemote(["preflight"])).rejects.toThrow(/pm2_launcher_mismatch/); await writePm2();
    await writePm2({args:["connect","--server","wss://controller.invalid","--token","fixture-token","--id","fixture","--dev"]}); await expect(runRemote(["preflight"])).rejects.toThrow(/pm2_dev_mode_mismatch/); await writePm2();
  });

  it("reports a non-ready preflight when the deployed bridge cannot prove both catalog RPCs",async()=>{
    const commandBus=path.join(checkout,"packages/adapters/dist/command-bus.js"); await fs.writeFile(commandBus,'export const PROTOCOL_VERSION = 1;\nconst methods = ["describeModelCatalog"];\n');
    const result=await runRemote(["preflight"]); expect(result.stdout).toContain("fetchModelCatalog=no"); expect(result.stdout).toContain("rollout_ready=no");
    await fs.writeFile(commandBus,'export const PROTOCOL_VERSION = 1;\nconst methods = ["describeModelCatalog", "fetchModelCatalog"];\n');
  });
});
