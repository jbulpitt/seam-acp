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
  files.push({path:"packages/adapters/dist/index.js",bytes:Buffer.from("export {};\n")},{path:"packages/bridge/dist/index.js",bytes:Buffer.from(indexSource)},{path:"packages/bridge/dist/rpc.js",bytes:Buffer.from("// describeModelCatalog fetchModelCatalog\n")});
  const manifest=Buffer.from(`${JSON.stringify({formatVersion:2,sourceSha,files:files.map((f)=>({path:f.path,size:f.bytes.length,sha256:createHash("sha256").update(f.bytes).digest("hex")}))})}\n`);
  return gzipSync(Buffer.concat([tarMember("bridge-release.json",manifest),...files.map((f)=>tarMember(f.path,f.bytes)),Buffer.alloc(1024)]));
}

async function makeFixture(behavior:"good"|"stale"="good") {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"bridge-activation-e2e-")); const checkout=path.join(root,"checkout"); const releaseRoot=path.join(root,"rollouts"); const entry=path.join(checkout,"packages/bridge/dist/index.js"); const pidFile=path.join(root,"bridge.pid"); const pm2File=path.join(root,"pm2.json"); const pm2Module=path.join(root,"pm2.cjs"); const runtime=path.join(root,"runtime"); const node=path.join(runtime,"node");
  await fs.mkdir(path.dirname(entry),{recursive:true}); await fs.mkdir(runtime); await fs.link(process.execPath,node); await fs.writeFile(path.join(runtime,"npm"),"#!/bin/sh\nmkdir -p node_modules/@agentclientprotocol/sdk node_modules/@types/ws node_modules/better-sqlite3 node_modules/ws node_modules/@seam/adapters\n",{mode:0o755});
  const bridgeSource=(mode:string)=>`import fs from 'node:fs';import path from 'node:path';import{spawn}from'node:child_process';const entry=${JSON.stringify(entry)},pidFile=${JSON.stringify(pidFile)},pm2File=${JSON.stringify(pm2File)},node=${JSON.stringify(node)},cwd=${JSON.stringify(checkout)},mode=${JSON.stringify(mode)};function update(pid){const j=JSON.parse(fs.readFileSync(pm2File));j.pid=pid;fs.writeFileSync(pm2File,JSON.stringify(j));fs.writeFileSync(pidFile,String(pid));}const release=path.resolve(new URL('.',import.meta.url).pathname,'../../..');const ep=path.join(release,'activation-envelope.json'),rp=path.join(release,'release-receipt.json');if(fs.existsSync(ep)){const e=JSON.parse(fs.readFileSync(ep)),s=JSON.parse(fs.readFileSync(rp)),t=new Date().toISOString(),started=mode==='stale'?'2000-01-01T00:00:00.000Z':e.startedAt,instance='instance-'+e.activationId.slice(0,12);fs.writeFileSync(rp,JSON.stringify({...s,...e,pid:process.pid,instanceId:instance,protocolVersion:1,startedAt:started,helloAcceptedAt:t,catalogRpcs:{grok:{describeModelCatalogAt:t,fetchModelCatalogAt:t}},controllerAck:{activationId:e.activationId,bridgeId:e.bridgeId,instanceId:instance,pid:process.pid},controllerVerifiedAt:t,completedAt:t})+'\\n');}process.on('SIGUSR2',()=>{const c=spawn(node,[entry],{cwd,detached:true,stdio:'ignore'});c.unref();update(c.pid);setTimeout(()=>process.exit(0),100);});setInterval(()=>{},1000);\n`;
  await fs.writeFile(entry,bridgeSource("legacy"));
  await fs.writeFile(pm2Module,`const fs=require('fs'),p=${JSON.stringify(pm2File)};module.exports={connect(cb){setImmediate(()=>cb(null))},describe(_n,cb){const j=JSON.parse(fs.readFileSync(p,'utf8'));setImmediate(()=>cb(null,[{pid:j.pid,pm2_env:{name:j.name,pm_cwd:j.cwd,pm_exec_path:j.entry,exec_interpreter:j.node,args:['connect','--server','wss://controller.invalid','--token','fixture-token','--id','fixture']}}]))},disconnect(){}}`);
  const start=spawn(node,[entry],{cwd:checkout,detached:true,stdio:"ignore"});start.unref(); await fs.writeFile(pidFile,String(start.pid)); await fs.writeFile(pm2File,JSON.stringify({pid:start.pid,name:"fixture-app",cwd:checkout,entry,node}));
  const shell=await renderRemoteScript(path.join(repo,"scripts/bridge-rollout-remote.sh"),path.join(repo,"scripts/bridge-rollout-remote.mjs"));
  const base=["fixture","fixture-app","grok",String(process.getuid!()),checkout,entry,pidFile,node,pm2Module,"-","no",releaseRoot];
  const run=(action:string[],timeoutMs=30_000)=>commandRunner({file:"/bin/sh",args:["-s","--",node,...base,...action],input:shell,timeoutMs});
  await run(["prepare-upload",H("f")]);
  const stage=async(sourceSha:string,source:string,operation:string)=>{const bytes=makeArchive(sourceSha,source),checksum=createHash("sha256").update(bytes).digest("hex"),upload=`bridge-${sourceSha}-${checksum}.tgz.upload-${operation}`;await fs.mkdir(path.join(releaseRoot,"incoming"),{recursive:true});await fs.writeFile(path.join(releaseRoot,"incoming",upload),bytes);const result=await run(["stage",sourceSha,checksum,upload,operation],60_000);return{sourceSha,checksum,stageId:operation,release:path.join(releaseRoot,"releases",`${sourceSha}-${checksum}`),result};};
  const old=await stage("1".repeat(40),bridgeSource("good"),H("1"));
  process.kill(start.pid!,"SIGKILL"); await new Promise((resolve)=>setTimeout(resolve,100)); await fs.unlink(entry); await fs.symlink(path.join(old.release,"packages/bridge/dist/index.js"),entry);
  const managed=spawn(node,[entry],{cwd:checkout,detached:true,stdio:"ignore"});managed.unref();await fs.writeFile(pidFile,String(managed.pid));await fs.writeFile(pm2File,JSON.stringify({pid:managed.pid,name:"fixture-app",cwd:checkout,entry,node}));await new Promise((resolve)=>setTimeout(resolve,100));
  const next=await stage("2".repeat(40),bridgeSource(behavior),H("2"));
  const value={root,checkout,releaseRoot,entry,pidFile,run,old,next}; fixtures.push(value); return value;
}

afterEach(async()=>{while(fixtures.length){const fixture=fixtures.pop()!;try{const pid=Number(await fs.readFile(fixture.pidFile,"utf8"));process.kill(pid,"SIGKILL");}catch{}await fs.rm(fixture.root,{recursive:true,force:true});}});

describe.sequential("production remote shell activation and rollback gates (#241)",()=>{
  it("proves a nonce-bound new instance, refuses current-release mismatch, then proves exact rollback",async()=>{
    const f=await makeFixture(); const activation=H("3"),operation=H("4");
    const activated=await f.run(["activate",f.next.sourceSha,f.next.checksum,f.next.stageId,activation,"10",operation],20_000);
    expect(activated.stdout).toContain(`activation_id=${activation}`); expect(activated.stdout).toContain("activation=verified");
    const newTarget=path.join(f.next.release,"packages/bridge/dist/index.js"),oldTarget=path.join(f.old.release,"packages/bridge/dist/index.js");
    await fs.unlink(f.entry);await fs.symlink(oldTarget,f.entry);
    await expect(f.run(["rollback",activation,H("5"),"10",H("6")],20_000)).rejects.toThrow(/rollback_current_activation_mismatch/);
    await fs.unlink(f.entry);await fs.symlink(newTarget,f.entry);
    const rolled=await f.run(["rollback",activation,H("7"),"10",H("8")],20_000);
    expect(rolled.stdout).toContain("rollback=verified");expect(rolled.stdout).toContain(`restored_sha=${f.old.sourceSha}`);expect(await fs.realpath(f.entry)).toBe(oldTarget);
  },60_000);

  it("rejects a stale shared receipt and rolls an observed interrupted activation back explicitly",async()=>{
    const f=await makeFixture("stale"),activation=H("9");
    await expect(f.run(["activate",f.next.sourceSha,f.next.checksum,f.next.stageId,activation,"10",H("a")],20_000)).rejects.toThrow(/activation_receipt_timeout/);
    await expect(fs.stat(path.join(f.releaseRoot,"activations",`${activation}.intent.json`))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(f.releaseRoot,"activations",`${activation}.observed.json`))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(f.releaseRoot,"activations",`${activation}.verified.json`))).rejects.toThrow();
    await expect(fs.stat(path.join(f.releaseRoot,"locks/fixture"))).rejects.toThrow();
    const rolled=await f.run(["rollback",activation,H("b"),"10",H("c")],20_000); expect(rolled.stdout).toContain("rollback=verified");
  },60_000);
});
