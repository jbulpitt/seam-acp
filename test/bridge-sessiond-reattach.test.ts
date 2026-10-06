/**
 * #574 — restart the bridge control-plane PROCESS around one live sessiond
 * slot. The child and descriptor owner remain real OS processes throughout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import type { SessiondOutputFrame } from "../packages/bridge/src/sessiond-protocol.js";

const roots: string[] = [];
const servers: SessiondServer[] = [];
const clients: SessiondClient[] = [];
const bridges: ChildProcess[] = [];

function bridgeProcess(args: string[]) {
  const child = fork(fileURLToPath(new URL("./fixtures/sessiond-bridge-client.ts", import.meta.url)), args, {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  bridges.push(child);
  return child;
}

function message(child: ReturnType<typeof bridgeProcess>, type: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", receive);
      child.off("error", failed);
    };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => failed(new Error(`fixture did not report ${type}`)), 5_000);
    const receive = (value: unknown) => {
      const record = value as Record<string, any>;
      if (record.type !== type) return;
      cleanup();
      resolve(record);
    };
    child.on("message", receive);
    child.once("error", failed);
  });
}

function output(client: SessiondClient, afterSeq: number, matches: (frame: SessiondOutputFrame) => boolean) {
  let subscribed!: Promise<unknown>;
  const frame = new Promise<SessiondOutputFrame>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture output did not arrive")), 5_000);
    subscribed = client.subscribe({ slot: 7, afterSeq }, event => {
      if (event.type !== "output" || !matches(event.frame)) return;
      clearTimeout(timer);
      resolve(event.frame);
    }).catch(error => { clearTimeout(timer); reject(error); });
  });
  return { subscribed, frame };
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    if (bridge.exitCode !== null || bridge.signalCode !== null) continue;
    const exited = once(bridge, "exit");
    bridge.kill("SIGKILL");
    await exited;
  }
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("#574 bridge process reattachment", () => {
  it.each([false, true])("completes across a restart with gap output once, ordered, and retained stdin usable (deferred reply: %s)", async deferred => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-574-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const socketPath = path.join(root, "sessiond.sock");
    const statePath = path.join(root, "slots.json");
    const childPath = path.join(root, "fixture-adapter-child.mjs");
    await fs.writeFile(childPath, `
      let input = "";
      let resumePending = false;
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
          if (text.includes("begin")) out("before\\n");
          if (text.includes("gap")) { out("gap-1\\n"); out("gap-2\\n"); }
          if (text.includes("post-restart-resume")) {
            resumePending = true;
            if (!${deferred}) out("RESUMED\\n");
          }
          if (text.includes("finish")) {
            if (${deferred} && resumePending) out("RESUMED\\n");
            out("after\\n");
          }
        }
      });
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });

    const server = new SessiondServer({ socketPath, statePath });
    servers.push(server);
    await server.start();

    const first = bridgeProcess([socketPath, childPath, "first", "0", "arm"]);
    const firstExited = once(first, "exit");
    const armedPromise = message(first, "armed");
    const beforePromise = message(first, "first");
    const armed = await armedPromise;
    expect(armed.armed).toMatchObject({ phase: "armed", submissionId: "submission-574" });
    const before = await beforePromise;
    expect(before.data).toBe("before\n");
    await firstExited;

    // Both frames are produced while no bridge process exists.
    const observer = await SessiondClient.connect(socketPath);
    clients.push(observer);
    const gaps = output(observer, before.seq, frame => frame.stream === "stdout"
      && JSON.parse(Buffer.from(frame.dataBase64!, "base64").toString()).data === "gap-2\n");
    await gaps.subscribed;
    await observer.write(7, `${JSON.stringify({ v: 1, type: "input", dataBase64: Buffer.from("gap\n").toString("base64") })}\n`);
    await gaps.frame;
    const second = bridgeProcess([socketPath, childPath, "second", String(before.seq)]);
    const secondExited = once(second, "exit");
    const reboundPromise = message(second, "rebound");
    const resumedPromise = message(second, "resumed");
    const livePromise = message(second, "live");
    const ready = message(second, "ready").then(() => second.send("resume"));
    const [, rebound, resumed, live] = await Promise.all([ready, reboundPromise, resumedPromise, livePromise]);
    expect(rebound.alive).toBe(true);
    expect(rebound.accepted).toBe(true);
    const reboundData = rebound.frames.map((frame: { data?: string }) => frame.data).filter(Boolean);
    // The gap frames still replay exactly once, in order.
    expect(reboundData.slice(0, 2)).toEqual(["gap-1\n", "gap-2\n"]);
    // And the post-restart write reached the retained child. #584 refused this,
    // which left a restarted thread unable to accept a prompt ever again.
    expect(resumed.frame.data).toBe("RESUMED\n");
    if (deferred) expect(reboundData).not.toContain("RESUMED\n");
    expect(live.data).toBe("after\n");
    expect(live.seq).toBeGreaterThan(rebound.frames.at(-1).seq);
    const received = [...rebound.frames, ...live.frames];
    expect(received.filter(frame => frame.type === "data").map(frame => frame.data))
      .toEqual(["gap-1\n", "gap-2\n", "RESUMED\n", "after\n"]);
    expect(received.map(frame => frame.seq)).toEqual([...new Set(received.map(frame => frame.seq))].sort((a, b) => a - b));
    await secondExited;

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
          if (Buffer.from(frame.dataBase64, "base64").toString().includes("begin")) out("before\\n");
          if (Buffer.from(frame.dataBase64, "base64").toString().includes("exit")) process.exit(7);
        }
      });
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });
    const server = new SessiondServer({ socketPath, statePath });
    servers.push(server);
    await server.start();

    const first = bridgeProcess([socketPath, childPath, "first"]);
    const firstExited = once(first, "exit");
    const before = await message(first, "first");
    await firstExited;
    const observer = await SessiondClient.connect(socketPath);
    clients.push(observer);
    const ended = output(observer, before.seq, frame => frame.stream === "exit");
    await ended.subscribed;
    await observer.write(7, `${JSON.stringify({ v: 1, type: "input", dataBase64: Buffer.from("exit\n").toString("base64") })}\n`);
    await ended.frame;

    const replacement = bridgeProcess([socketPath, childPath, "dead", String(before.seq)]);
    const replacementExited = once(replacement, "exit");
    const reboundPromise = message(replacement, "rebound");
    const ready = message(replacement, "ready").then(() => replacement.send("resume"));
    const [, rebound] = await Promise.all([ready, reboundPromise]);
    expect(rebound.alive).toBe(false);
    expect(rebound.frames).toEqual([
      expect.objectContaining({ type: "exit", code: 7 }),
    ]);
    await replacementExited;
  });
});
