import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { commandRunner, renderRemoteScript } from "../scripts/lib/bridge-rollout.mjs";

const repo = path.resolve(import.meta.dirname,".."); const H=(v:string)=>v.repeat(64);
const fixtures: ActivationFixture[] = [];
type ActivationFixture = Awaited<ReturnType<typeof makeFixture>>;

function put(block:Buffer,offset:number,length:number,value:string){block.write(value,offset,Math.min(length,Buffer.byteLength(value)),"utf8");}
function oct(block:Buffer,offset:number,length:number,value:number){put(block,offset,length,`${value.toString(8).padStart(length-1,"0")}\0`);}
function tarMember(name:string,bytes:Buffer){const h=Buffer.alloc(512);put(h,0,100,name);oct(h,100,8,0o600);oct(h,108,8,process.getuid!());oct(h,116,8,process.getgid!());oct(h,124,12,bytes.length);oct(h,136,12,0);h.fill(32,148,156);h[156]=48;put(h,257,6,"ustar\0");put(h,263,2,"00");const sum=h.reduce((a,b)=>a+b,0);put(h,148,8,`${sum.toString(8).padStart(6,"0")}\0 `);return Buffer.concat([h,bytes,Buffer.alloc((512-bytes.length%512)%512)]);}
function makeArchive(sourceSha:string,indexSource:string){
  const names=["package.json","package-lock.json","packages/adapters/package.json","packages/bridge/package.json","packages/core/package.json"];
  const files=names.map((name)=>({path:name,bytes:Buffer.from(readFileSync(path.join(repo,name)))}));
  files.push(
    {path:"packages/adapters/dist/index.js",bytes:Buffer.from("export {};\n")},
    {path:"packages/adapters/dist/command-bus.js",bytes:Buffer.from('export const PROTOCOL_VERSION = 1;\nconst methods = ["describeModelCatalog", "fetchModelCatalog"];\n')},
    {path:"packages/bridge/dist/index.js",bytes:Buffer.from(indexSource)},
    {path:"packages/bridge/dist/rpc.js",bytes:Buffer.from("export function isAllowedRpcMethod(){}\nexport function dispatchAdapter(){}\n")},
  );
  const manifest=Buffer.from(`${JSON.stringify({formatVersion:2,sourceSha,files:files.map((f)=>({path:f.path,size:f.bytes.length,sha256:createHash("sha256").update(f.bytes).digest("hex")}))})}\n`);
  return gzipSync(Buffer.concat([tarMember("bridge-release.json",manifest),...files.map((f)=>tarMember(f.path,f.bytes)),Buffer.alloc(1024)]));
}

async function makeFixture(behavior:"good"|"stale"|"wrong-ack"|"adapter-loss"|"cross-clock"|"hello-only"|"no-hello"|"settle"="good", oldBehavior:"good"|"interrupt"="good") {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"bridge-activation-e2e-")); const checkout=path.join(root,"checkout"); const releaseRoot=path.join(root,"rollouts"); const entry=path.join(checkout,"packages/bridge/dist/index.js"); const pidFile=path.join(root,"fixture-app-0.pid"); const pm2File=path.join(root,"pm2.json"); const pm2Module=path.join(root,"pm2.cjs"); const runtime=path.join(root,"runtime"); const node=path.join(runtime,"node"); const failPrebuild=path.join(root,"fail-prebuild");
  await fs.mkdir(path.dirname(entry),{recursive:true}); await fs.mkdir(runtime); await fs.link(process.execPath,node); await fs.writeFile(path.join(runtime,"npm"),`#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then printf '10.9.0\\n'; exit 0; fi
case "$PATH" in "$PWD/.seam-install-bin:${path.dirname(node)}:/usr/bin:/bin") ;; *) exit 91 ;; esac
mkdir -p node_modules/prebuild-install node_modules/better-sqlite3/build/Release node_modules/@agentclientprotocol/sdk node_modules/@types/ws node_modules/ws node_modules/@seam/adapters
printf '%s\\n' "import fs from 'node:fs'; fs.writeFileSync(new URL('../better-sqlite3/build/Release/better_sqlite3.node', import.meta.url), 'prebuilt');" > node_modules/prebuild-install/bin.js
if [ -f ${failPrebuild} ]; then node-gyp; fi
prebuild-install
`,{mode:0o755});
  const bridgeSource=(mode:string)=>`import fs from 'node:fs';import path from 'node:path';import{spawn}from'node:child_process';const entry=${JSON.stringify(entry)},pidFile=${JSON.stringify(pidFile)},pm2File=${JSON.stringify(pm2File)},node=${JSON.stringify(node)},cwd=${JSON.stringify(checkout)},mode=${JSON.stringify(mode)};let signalCount=0;function update(pid){const j=JSON.parse(fs.readFileSync(pm2File));j.pid=pid;j.pm_uptime=Date.now();fs.writeFileSync(pm2File,JSON.stringify(j));fs.writeFileSync(pidFile,String(pid));}const release=path.resolve(new URL('.',import.meta.url).pathname,'../../..');const ep=path.join(release,'activation-envelope.json'),rp=path.join(release,'release-receipt.json');if(mode!=='no-hello'&&fs.existsSync(ep)){const e=JSON.parse(fs.readFileSync(ep)),s=JSON.parse(fs.readFileSync(rp)),now=Date.now(),iso=ms=>new Date(ms).toISOString(),t=iso(now),describeAt=mode==='cross-clock'?iso(now+10):t,fetchAt=mode==='cross-clock'?iso(now+20):t,ackAt=mode==='cross-clock'?iso(now+7):t,started=mode==='stale'?'2000-01-01T00:00:00.000Z':e.startedAt,instance='instance-'+e.activationId.slice(0,12),ackChecksum=mode==='wrong-ack'?'f'.repeat(64):e.artifactChecksum,adapterRefusals=mode==='adapter-loss'?[{agentId:'agy',code:'configuration_incomplete',missing:['AGY_ENABLED=true','AGY_SHA256']}]:[];const good=mode==='hello-only'?{}:{catalogRpcs:{grok:{describeModelCatalogAt:describeAt,fetchModelCatalogAt:fetchAt}},controllerAck:{activationId:e.activationId,bridgeId:e.bridgeId,instanceId:instance,pid:process.pid,sourceSha:e.sourceSha,artifactChecksum:ackChecksum},controllerVerifiedAt:ackAt,completedAt:ackAt};function publish(extra){fs.writeFileSync(rp,JSON.stringify({...s,...e,pid:process.pid,instanceId:instance,protocolVersion:1,startedAt:started,helloAcceptedAt:t,adapterRefusals,...extra})+String.fromCharCode(10));}if(mode==='settle'){fs.writeFileSync(rp,JSON.stringify({...s,formatVersion:2,activationId:'a'.repeat(64),bridgeId:e.bridgeId,sourceSha:e.sourceSha,artifactChecksum:e.artifactChecksum,stageId:e.stageId,oldPid:e.oldPid,pid:process.pid,instanceId:instance,protocolVersion:1,helloAcceptedAt:t,startedAt:started})+String.fromCharCode(10));setTimeout(()=>publish({catalogRpcs:{grok:{describeModelCatalogAt:iso(now+50),fetchModelCatalogAt:iso(now+10)}},controllerAck:{activationId:'b'.repeat(64),bridgeId:e.bridgeId,instanceId:instance,pid:process.pid,sourceSha:e.sourceSha,artifactChecksum:e.artifactChecksum},controllerVerifiedAt:ackAt,completedAt:ackAt}),400);setTimeout(()=>publish(good),900);}else publish(good);}process.on('SIGUSR2',()=>{signalCount+=1;if(mode==='interrupt'&&signalCount===1)return;const c=spawn(node,[entry],{cwd,detached:true,stdio:'ignore'});c.unref();update(c.pid);setTimeout(()=>process.exit(0),100);});setInterval(()=>{},1000);\n`;
  await fs.writeFile(entry,bridgeSource("legacy"));
  await fs.writeFile(pm2Module,`const fs=require('fs'),p=${JSON.stringify(pm2File)};module.exports={connect(cb){setImmediate(()=>cb(null))},describe(_n,cb){const j=JSON.parse(fs.readFileSync(p,'utf8'));setImmediate(()=>cb(null,[{pid:j.pid,pm_id:j.pm_id,pm2_env:{name:j.name,pm_id:j.pm_id,pm_pid_path:j.pidFile,pm_cwd:j.cwd,pm_exec_path:j.entry,exec_interpreter:j.node,pm_uptime:j.pm_uptime,args:['connect','--server','wss://controller.invalid','--token','fixture-token','--id','fixture']}}]))},disconnect(){}}`);
  const start=spawn(node,[entry],{cwd:checkout,detached:true,stdio:"ignore"});start.unref(); await fs.writeFile(pidFile,String(start.pid)); await fs.writeFile(pm2File,JSON.stringify({pid:start.pid,pm_id:0,pidFile,name:"fixture-app",cwd:checkout,entry,node,pm_uptime:Date.now()}));
  const shell=await renderRemoteScript(path.join(repo,"scripts/bridge-rollout-remote.sh"),path.join(repo,"scripts/bridge-rollout-remote.mjs"));
  const base=["fixture","fixture-app","grok",String(process.getuid!()),checkout,entry,node,pm2Module,"-","no",releaseRoot,"pm2","-"];
  const run=(action:string[],timeoutMs=30_000)=>commandRunner({file:"/bin/sh",args:["-s","--",node,...base,...action],input:shell,timeoutMs});
  await run(["prepare-upload",H("f")]);
  const stage=async(sourceSha:string,source:string,operation:string)=>{const bytes=makeArchive(sourceSha,source),checksum=createHash("sha256").update(bytes).digest("hex"),upload=`bridge-${sourceSha}-${checksum}.tgz.upload-${operation}`;await fs.mkdir(path.join(releaseRoot,"incoming"),{recursive:true});await fs.writeFile(path.join(releaseRoot,"incoming",upload),bytes);const result=await run(["stage",sourceSha,checksum,upload,operation],60_000);return{sourceSha,checksum,stageId:operation,release:path.join(releaseRoot,"releases",`${sourceSha}-${checksum}`),result};};
  const old=await stage("1".repeat(40),bridgeSource(oldBehavior),H("1"));
  process.kill(start.pid!,"SIGKILL"); await new Promise((resolve)=>setTimeout(resolve,100)); await fs.unlink(entry); await fs.symlink(path.join(old.release,"packages/bridge/dist/index.js"),entry);
  const managed=spawn(node,[entry],{cwd:checkout,detached:true,stdio:"ignore"});managed.unref();await fs.writeFile(pidFile,String(managed.pid));await fs.writeFile(pm2File,JSON.stringify({pid:managed.pid,pm_id:0,pidFile,name:"fixture-app",cwd:checkout,entry,node,pm_uptime:Date.now()}));await new Promise((resolve)=>setTimeout(resolve,100));
  const next=await stage("2".repeat(40),bridgeSource(behavior),H("2"));
  const value={root,checkout,releaseRoot,entry,pidFile,run,stage,failPrebuild,old,next}; fixtures.push(value); return value;
}

afterEach(async()=>{while(fixtures.length){const fixture=fixtures.pop()!;try{const pid=Number(await fs.readFile(fixture.pidFile,"utf8"));process.kill(pid,"SIGKILL");}catch{}await fs.rm(fixture.root,{recursive:true,force:true});}});

describe.sequential("production remote shell activation and rollback gates (#241)",()=>{
  it("surfaces an adapter lost by the new build without refusing the verified upgrade", async () => {
    const f = await makeFixture("adapter-loss");
    const activation = H("0");
    const result = await f.run(["activate", f.next.sourceSha, f.next.checksum, f.next.stageId, activation, "10", H("1")], 20_000);

    expect(result.stdout).toContain("activation=verified");
    expect(result.stdout).toContain("adapter_inventory=degraded");
    expect(result.stdout).toContain("adapter_refusal=agy:configuration_incomplete");
    expect(result.stdout).toContain("adapter_refusal_missing_agy=AGY_ENABLED=true,AGY_SHA256");
    expect(result.stdout).toContain("upgrade_status=verified_with_adapter_refusal");
    const receipt = JSON.parse(await fs.readFile(path.join(f.next.release, "release-receipt.json"), "utf8"));
    expect(receipt.adapterRefusals).toEqual([{
      agentId: "agy",
      code: "configuration_incomplete",
      missing: ["AGY_ENABLED=true", "AGY_SHA256"],
    }]);
  }, 60_000);

  it("verifies when the controller ack is stamped a few milliseconds before catalog RPCs (#489)", async () => {
    const f = await makeFixture("cross-clock");
    const result = await f.run(["activate", f.next.sourceSha, f.next.checksum, f.next.stageId, H("0"), "10", H("1")], 20_000);
    expect(result.stdout).toContain("activation=verified");
    const receipt = JSON.parse(await fs.readFile(path.join(f.next.release, "release-receipt.json"), "utf8"));
    expect(Date.parse(receipt.controllerVerifiedAt)).toBeLessThan(Date.parse(receipt.catalogRpcs.grok.describeModelCatalogAt));
  }, 60_000);

  it("reports no refusal when the successor deliberately advertises no agy", async () => {
    const f = await makeFixture("good");
    const result = await f.run(["activate", f.next.sourceSha, f.next.checksum, f.next.stageId, H("0"), "10", H("1")], 20_000);

    expect(result.stdout).toContain("activation=verified");
    expect(result.stdout).toContain("adapter_refusals=none");
    expect(result.stdout).not.toContain("adapter_inventory=degraded");
  }, 60_000);

  it("proves a nonce-bound new instance, refuses current-release mismatch, then proves exact rollback",async()=>{
    const f=await makeFixture(); const activation=H("3"),operation=H("4");
    expect(await fs.readFile(path.join(f.next.release,"node_modules/better-sqlite3/build/Release/better_sqlite3.node"),"utf8")).toBe("prebuilt");
    await expect(fs.stat(path.join(f.next.release,".seam-install-bin"))).rejects.toThrow();
    const activated=await f.run(["activate",f.next.sourceSha,f.next.checksum,f.next.stageId,activation,"10",operation],20_000);
    expect(activated.stdout).toContain(`activation_id=${activation}`); expect(activated.stdout).toContain("activation=verified");
    const verified=JSON.parse(await fs.readFile(path.join(f.releaseRoot,"activations",`${activation}.verified.json`),"utf8"));
    expect(verified.verification).toEqual({forward:"receipt",catalogRpcsVerified:true});
    const newTarget=path.join(f.next.release,"packages/bridge/dist/index.js"),oldTarget=path.join(f.old.release,"packages/bridge/dist/index.js");
    await fs.unlink(f.entry);await fs.symlink(oldTarget,f.entry);
    await expect(f.run(["rollback",activation,H("5"),"10",H("6")],20_000)).rejects.toThrow(/rollback_current_activation_mismatch/);
    await fs.unlink(f.entry);await fs.symlink(newTarget,f.entry);
    const rolled=await f.run(["rollback",activation,H("7"),"10",H("8")],20_000);
    expect(rolled.stdout).toContain("rollback=verified");expect(rolled.stdout).toContain(`restored_sha=${f.old.sourceSha}`);expect(await fs.realpath(f.entry)).toBe(oldTarget);
  },60_000);

  it("refuses native source fallback with a named error instead of using an undeclared toolchain",async()=>{
    const f=await makeFixture(); const sourceSha="3".repeat(40),operation=H("f");
    await fs.writeFile(f.failPrebuild,"");
    await expect(f.stage(sourceSha,"export {};\n",operation)).rejects.toThrow(/native_prebuild_unavailable/);
    const releases=await fs.readdir(path.join(f.releaseRoot,"releases"));
    expect(releases.some((name)=>name.startsWith(`${sourceSha}-`))).toBe(false);
  },60_000);

  it("reports a stale shared receipt as verification failed, with evidence before rollback",async()=>{
    const f=await makeFixture("stale"),activation=H("9");
    const result=await f.run(["activate",f.next.sourceSha,f.next.checksum,f.next.stageId,activation,"10",H("a")],20_000);
    expect(result.stdout).toContain("activation=verification_failed");
    expect(result.stdout).toContain("verification_reason=receipt_outside_window");
    expect(result.stdout).toContain("old_pid_exited=yes");
    expect(result.stdout).toContain("post_describeModelCatalog=yes");
    expect(result.stdout).toContain("post_fetchModelCatalog=yes");
    expect(result.stdout).toContain("post_rollout_ready=yes");
    expect(result.stdout.indexOf("verification_reason=")).toBeLessThan(result.stdout.indexOf("rollback_command="));
    expect(result.stdout.indexOf("current_entrypoint_target=")).toBeLessThan(result.stdout.indexOf("rollback_command="));
    expect(result.stdout.indexOf("process_started_at=")).toBeLessThan(result.stdout.indexOf("rollback_command="));
    await expect(fs.stat(path.join(f.releaseRoot,"activations",`${activation}.intent.json`))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(f.releaseRoot,"activations",`${activation}.observed.json`))).resolves.toBeTruthy();
    const failed=JSON.parse(await fs.readFile(path.join(f.releaseRoot,"activations",`${activation}.failed.json`),"utf8"));
    expect(failed.verification).toEqual({forward:"failed",catalogRpcsVerified:false,state:"failed"});
    expect(failed.confirmationError).toBe("receipt_outside_window");
    expect(failed.recheck).toMatchObject({oldPidExited:true,describeModelCatalog:"yes",fetchModelCatalog:"yes",rolloutReady:"yes"});
    expect(Date.parse(failed.recheck.processStartedAt)).not.toBeNaN();
    const observed=JSON.parse(await fs.readFile(path.join(f.releaseRoot,"activations",`${activation}.observed.json`),"utf8"));
    expect(observed.verification).toEqual({forward:"receipt",catalogRpcsVerified:false,state:"pending"});
    await expect(fs.stat(path.join(f.releaseRoot,"activations",`${activation}.verified.json`))).rejects.toThrow();
    await expect(fs.stat(path.join(f.releaseRoot,"locks/fixture"))).rejects.toThrow();
    const rolled=await f.run(["rollback",activation,H("b"),"10",H("c")],20_000); expect(rolled.stdout).toContain("rollback=verified");
  },60_000);

  it("names a wrong controller acknowledgement as verification failed",async()=>{
    const f=await makeFixture("wrong-ack"),activation=H("d");
    const result=await f.run(["activate",f.next.sourceSha,f.next.checksum,f.next.stageId,activation,"10",H("e")],20_000);
    expect(result.stdout).toContain("activation=verification_failed");
    expect(result.stdout).toContain("verification_reason=controller_ack_mismatch");
    await expect(fs.stat(path.join(f.releaseRoot,"activations",`${activation}.observed.json`))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(f.releaseRoot,"activations",`${activation}.failed.json`))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(f.releaseRoot,"activations",`${activation}.verified.json`))).rejects.toThrow();
  },60_000);

  it("waits out a leftover receipt, a stale ack, and a mid-write catalog snapshot (#492)", async () => {
    const f = await makeFixture("settle");
    const started = Date.now();
    const result = await f.run(["activate", f.next.sourceSha, f.next.checksum, f.next.stageId, H("a"), "40", H("b")], 60_000);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.stdout).toContain("activation=verified");
    expect(result.stdout).toContain("catalog_rpcs_verified=yes");
    expect(result.stdout).not.toContain("activation_receipt_identity_mismatch");
    expect(result.stdout).not.toContain("controller_ack_mismatch");
    expect(result.stdout).not.toContain("catalog_timestamp_order");
  }, 60_000);

  it("rolls back after later agents append catalog stamps to a verified receipt (#492)", async () => {
    const f = await makeFixture("good");
    const activation = H("c");
    const activated = await f.run(["activate", f.next.sourceSha, f.next.checksum, f.next.stageId, activation, "20", H("d")], 30_000);
    expect(activated.stdout).toContain("activation=verified");
    expect(activated.stdout).toContain("catalog_rpcs_verified=yes");
    const receiptPath = path.join(f.next.release, "release-receipt.json");
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    receipt.catalogRpcs.claude = {
      describeModelCatalogAt: new Date().toISOString(),
      fetchModelCatalogAt: new Date().toISOString(),
    };
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    const rolled = await f.run(["rollback", activation, H("e"), "20", H("f")], 30_000);
    expect(rolled.stdout).toContain("rollback=verified");
    expect(await fs.realpath(f.entry)).toBe(path.join(f.old.release, "packages/bridge/dist/index.js"));
  }, 60_000);

  it("verifies from hello when no catalog refresh stamps the receipt (#492)", async () => {
    const f = await makeFixture("hello-only");
    const started = Date.now();
    const result = await f.run(["activate", f.next.sourceSha, f.next.checksum, f.next.stageId, H("1"), "40", H("2")], 60_000);
    expect(Date.now() - started).toBeLessThan(35_000);
    expect(result.stdout).toContain("activation=verified");
    expect(result.stdout).toContain("catalog_rpcs_verified=no");
    expect(result.stdout).toContain("verification_reason=catalog_rpc_not_observed");
    expect(result.stdout).not.toContain("activation_receipt_timeout");
    const verified = JSON.parse(await fs.readFile(path.join(f.releaseRoot, "activations", `${H("1")}.verified.json`), "utf8"));
    expect(verified.verification).toEqual({ forward: "hello", catalogRpcsVerified: false });
    expect(verified.readyReceiptSha256).toBeUndefined();
    const rolled = await f.run(["rollback", H("1"), H("7"), "20", H("8")], 30_000);
    expect(rolled.stdout).toContain("rollback=verified");
    expect(await fs.realpath(f.entry)).toBe(path.join(f.old.release, "packages/bridge/dist/index.js"));
  }, 90_000);

  it("fails verification when the replacement never reconnects (#492)", async () => {
    const f = await makeFixture("no-hello");
    const result = await f.run(["activate", f.next.sourceSha, f.next.checksum, f.next.stageId, H("3"), "40", H("4")], 60_000);
    expect(result.stdout).toContain("activation=verification_failed");
    expect(result.stdout).toContain("verification_reason=activation_hello_timeout");
    await expect(fs.stat(path.join(f.releaseRoot, "activations", `${H("3")}.verified.json`))).rejects.toThrow();
  }, 60_000);

  it("uses the immutable pre-switch intent to roll back a switched pointer when the old PID never exited",async()=>{
    const f=await makeFixture("good","interrupt"),activation=H("6");
    await expect(f.run(["activate",f.next.sourceSha,f.next.checksum,f.next.stageId,activation,"10",H("7")],20_000)).rejects.toThrow(/replacement_pid_timeout/);
    await expect(fs.stat(path.join(f.releaseRoot,"activations",`${activation}.intent.json`))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(f.releaseRoot,"activations",`${activation}.observed.json`))).rejects.toThrow();
    expect(await fs.realpath(f.entry)).toBe(path.join(f.next.release,"packages/bridge/dist/index.js"));
    const rolled=await f.run(["rollback",activation,H("8"),"10",H("9")],20_000);
    expect(rolled.stdout).toContain("rollback=verified"); expect(await fs.realpath(f.entry)).toBe(path.join(f.old.release,"packages/bridge/dist/index.js"));
    const rollback = JSON.parse(await fs.readFile(path.join(f.releaseRoot,"rollbacks",`${activation}-${H("8")}.verified.json`),"utf8"));
    expect(rollback.failedActivationRecordKind).toBe("intent");
  },60_000);
});
