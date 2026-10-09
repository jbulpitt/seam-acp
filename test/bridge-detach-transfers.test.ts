import { expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { bridgeDetachFixture, until } from "./helpers/bridge-detach.js";

it("detaches after transferring an already-received arm and its queued prompt", async () => {
  const f = await bridgeDetachFixture();
  const held = f.blockWrite(value => value.type === "arm_recovery");
  const armed = f.arm();
  await until(() => held.reached() ? true : undefined, "arm transfer held before holder acceptance");
  f.data(f.prompt());
  await f.handled();
  f.first.signal();
  await until(() => f.first.stderr().includes("SIGUSR2 received") ? true : undefined, "restart signal handled");
  await f.handled();
  expect(f.first.bridge.exitCode).toBeNull();
  held.release();
  await armed;
  await f.first.exited();
  await f.start();
  await f.replay();
  await f.completed();
}, 30_000);

it("keeps an outstanding native client request answerable after bridge detach", async () => {
  const f = await bridgeDetachFixture();
  await f.arm();
  f.data(f.prompt("continue with a client reply"));
  await f.frame(value => value.data?.includes('"id":"fixture-client-reply"'), "native permission request");
  f.first.signal();
  await f.first.exited();
  await f.start();
  await f.replay();
  f.data(JSON.stringify({ jsonrpc: "2.0", id: "fixture-client-reply",
    result: { outcome: { outcome: "selected", optionId: "allow" } } }) + "\n");
  await f.completed();
}, 30_000);

it("finishes a received client reply transfer before detaching", async () => {
  const f = await bridgeDetachFixture();
  await f.arm();
  f.data(f.prompt("continue with a client reply"));
  await f.frame(value => value.data?.includes('"id":"fixture-client-reply"'), "native permission request");
  const held = f.blockWrite(value => value.type === "input"
    && Buffer.from(value.dataBase64, "base64").toString().includes('"fixture-client-reply"'));
  f.data(JSON.stringify({ jsonrpc: "2.0", id: "fixture-client-reply",
    result: { outcome: { outcome: "selected", optionId: "allow" } } }) + "\n");
  await until(() => held.reached() ? true : undefined, "client reply held before holder acceptance");
  f.first.signal();
  await until(() => f.first.stderr().includes("SIGUSR2 received") ? true : undefined, "restart signal handled");
  await f.handled();
  expect(f.first.bridge.exitCode).toBeNull();
  held.release();
  await f.first.exited();
  await f.start();
  await f.replay();
  await f.completed();
}, 30_000);

it("keeps a fragmented prompt in its surviving owner across bridge detach", async () => {
  const f = await bridgeDetachFixture();
  await f.arm();
  const prompt = f.prompt();
  const split = prompt.indexOf("continue") + 3;
  f.data(prompt.slice(0, split));
  await f.handled();
  f.first.signal();
  // Let main really exit, so the regression also proves loss of its fragment buffer.
  await f.first.exited(15_000);
  await f.start();
  await f.replay();
  f.data(prompt.slice(split));
  await f.completed();
}, 40_000);

it("retains session/load frame rewriting when its fragments cross bridge detach", async () => {
  const f = await bridgeDetachFixture();
  const load = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/load",
    params: { sessionId: "s1", cwd: f.requestedCwd, mcpServers: [
      { name: "fixture-mcp", type: "http", url: "https://example.invalid/mcp", headers: [] },
    ] } }) + "\n";
  const split = load.indexOf("mcpServers") + 4;
  f.data(load.slice(0, split));
  await f.handled();
  f.first.signal();
  await f.first.exited(15_000);
  await f.start();
  await f.replay();
  f.data(load.slice(split));
  await f.frame(value => value.data?.includes('"id":3,"result"'), "complete session/load after replacement");
  const native = (await fs.readFile(f.requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(native.filter(value => value.method === "session/load")).toEqual([
    expect.objectContaining({ pid: native[0].pid, params: {
      sessionId: "s1", cwd: f.directory, mcpServers: [
        { name: "fixture-mcp", type: "http", url: "https://example.invalid/mcp", headers: [] },
        f.hostServer,
      ],
    } }),
  ]);
}, 40_000);
