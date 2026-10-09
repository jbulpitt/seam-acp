import { expect, it } from "vitest";
import { bridgeDetachFixture, until } from "./helpers/bridge-detach.js";

it("#777 compiled bridge delivers prompt during detach and the client reply after reconnect", async () => {
  const f = await bridgeDetachFixture();
  const held = f.blockWrite(value => value.type === "arm_recovery");
  const armed = f.arm();
  await until(() => held.reached() ? true : undefined, "arm transfer held before holder acceptance");
  f.first.signal();
  await until(() => f.first.stderr().includes("SIGUSR2 received") ? true : undefined, "restart signal handled");
  f.data(f.prompt("continue with a client reply"));
  await f.handled();
  held.release();
  await armed;
  await f.first.exited();
  await f.start();
  await f.replay();
  await f.frame(value => value.data?.includes('"id":"fixture-client-reply"'), "pending native client request");
  f.data(JSON.stringify({ jsonrpc: "2.0", id: "fixture-client-reply",
    result: { outcome: { outcome: "selected", optionId: "allow" } } }) + "\n");
  await f.completed();
  expect(f.first.bridge.exitCode).toBe(0);
}, 30_000);
