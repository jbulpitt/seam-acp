/**
 * #574 — restart the bridge control-plane PROCESS around one live sessiond
 * slot. The child and descriptor owner remain real OS processes throughout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";

const roots: string[] = [];
const servers: SessiondServer[] = [];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bridgeProcess(args: string[]) {
  return fork(fileURLToPath(new URL("./fixtures/sessiond-bridge-client.ts", import.meta.url)), args, {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

function message(child: ReturnType<typeof bridgeProcess>, type: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture did not report ${type}`)), 5_000);
    child.on("message", (value) => {
      const record = value as Record<string, any>;
      if (record.type !== type) return;
      clearTimeout(timer);
      resolve(record);
    });
    child.once("error", reject);
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("#574 bridge process reattachment", () => {
  it("completes across a restart with gap output once, ordered, and retained stdin guarded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-574-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const socketPath = path.join(root, "sessiond.sock");
    const statePath = path.join(root, "slots.json");
    const childPath = path.join(root, "fixture-adapter-child.mjs");
    await fs.writeFile(childPath, `
      let input = "";
      const send = value => process.stdout.write(JSON.stringify({v:1,...value}) + "\\n");
      const out = data => send({type:"data",data});
      process.stdin.on("data", chunk => {
        input += chunk.toString();
        let newline;
        while ((newline = input.indexOf("\\n")) !== -1) {
          const line = input.slice(0, newline); input = input.slice(newline + 1);
          const frame = JSON.parse(line);
          if (frame.type === "arm_recovery") {
            const snapshot = {version:1,owner:"bridge",submissionId:frame.submissionId,acpSessionId:frame.acpSessionId,rung:1,phase:"armed",retry:0,budget:3,remaining:3,disposition:"none",updatedUtc:"2026-09-23T00:00:00.000Z"};
            send({type:"recovery",recovery:snapshot});
            send({type:"control_result",requestId:frame.requestId,ok:true,result:snapshot});
            continue;
          }
          if (frame.type !== "input") continue;
          const text = Buffer.from(frame.dataBase64, "base64").toString();
          if (text.includes("must-not-reach-child")) out("UNSAFE-RESEND\\n");
          if (!text.includes("begin")) continue;
          out("before\\n");
          setTimeout(() => out("gap-1\\n"), 100);
          setTimeout(() => out("gap-2\\n"), 180);
          setTimeout(() => out("after\\n"), 1200);
        }
      });
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });

    const server = new SessiondServer({ socketPath, statePath });
    servers.push(server);
    await server.start();

    const first = bridgeProcess([socketPath, childPath, "first", "0", "arm"]);
    const armedPromise = message(first, "armed");
    const beforePromise = message(first, "first");
    const armed = await armedPromise;
    expect(armed.armed).toMatchObject({ phase: "armed", submissionId: "submission-574" });
    const before = await beforePromise;
    expect(before.data).toBe("before\n");
    await new Promise<void>((resolve) => first.once("exit", () => resolve()));

    // Both frames are produced while no bridge process exists.
    await delay(250);
    const second = bridgeProcess([socketPath, childPath, "second", String(before.seq)]);
    const rebound = await message(second, "rebound");
    expect(rebound.alive).toBe(true);
    expect(rebound.accepted).toBe(false);
    expect(rebound.frames.map((frame: { data?: string }) => frame.data).filter(Boolean)).toEqual([
      "gap-1\n",
      "gap-2\n",
    ]);
    const live = await message(second, "live");
    expect(live.data).toBe("after\n");
    expect(live.seq).toBeGreaterThan(rebound.frames.at(-1).seq);
    expect(JSON.stringify([rebound, live])).not.toContain("UNSAFE-RESEND");
    await new Promise<void>((resolve) => second.once("exit", () => resolve()));

    const observer = await SessiondClient.connect(socketPath);
    const listed = await observer.listSlots();
    expect(listed.health.find((entry) => entry.slot === 7)?.alive).toBe(false);
    observer.close();
  });

  it("replays an exit observed while no bridge exists instead of resurrecting the dead slot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-574-dead-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const socketPath = path.join(root, "sessiond.sock");
    const statePath = path.join(root, "slots.json");
    const childPath = path.join(root, "fixture-dead-child.mjs");
    await fs.writeFile(childPath, `
      let input = "";
      const out = data => process.stdout.write(JSON.stringify({v:1,type:"data",data}) + "\\n");
      process.stdin.on("data", chunk => {
        input += chunk.toString();
        let newline;
        while ((newline = input.indexOf("\\n")) !== -1) {
          const frame = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1);
          if (frame.type !== "input") continue;
          out("before\\n");
          setTimeout(() => process.exit(7), 100);
        }
      });
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });
    const server = new SessiondServer({ socketPath, statePath });
    servers.push(server);
    await server.start();

    const first = bridgeProcess([socketPath, childPath, "first"]);
    const before = await message(first, "first");
    await new Promise<void>((resolve) => first.once("exit", () => resolve()));
    await delay(200);

    const replacement = bridgeProcess([socketPath, childPath, "dead", String(before.seq)]);
    const rebound = await message(replacement, "rebound");
    expect(rebound.alive).toBe(false);
    expect(rebound.frames).toEqual([
      expect.objectContaining({ type: "exit", code: 7 }),
    ]);
    await new Promise<void>((resolve) => replacement.once("exit", () => resolve()));
  });
});
