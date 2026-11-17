import { expect, it, vi } from "vitest";
import { bridgeDetachFixture, until } from "./helpers/bridge-detach.js";

it("the same compiled bridge reconnects before its holder and finishes the original permission turn", async () => {
  const f = await bridgeDetachFixture();
  await f.arm();
  f.data(f.prompt("continue with a client reply"));
  const permission = (frame: Record<string, any>) => frame.data?.includes('"id":"fixture-client-reply"');
  await f.frame(permission, "original permission");
  const initial = f.frames.find(frame => frame.type === "hello")!;
  const daemon = f.daemon as any;
  const entry = daemon.slots.get(9);
  const accepted = vi.spyOn(daemon, "holderWrite");
  const holderIdentity = { ...entry.identity };
  expect(holderIdentity.pid).toBeGreaterThan(0);
  const connect = daemon.connectHolder.bind(daemon);
  const reconnect = vi.spyOn(daemon, "connectHolder").mockResolvedValue(false);
  const answer = () => f.data(JSON.stringify({ jsonrpc: "2.0", id: "fixture-client-reply",
    result: { outcome: { outcome: "selected", optionId: "allow" } } }) + "\n");
  try {
    entry.link.destroy();
    await until(() => entry.attached === false ? true : undefined, "holder detached");
    answer();
    await until(() => f.frames.filter(frame => frame.type === "hello").length === 2 ? true : undefined,
      "same bridge automatic WebSocket reconnect");
    expect(f.first.bridge.exitCode).toBeNull();
    expect(f.frames.filter(frame => frame.type === "hello")[1]!.instanceId).toBe(initial.instanceId);
    expect(f.first.stderr()).toContain("retaining owner and reconnecting");
    expect(entry.attached).toBe(false);
    await f.replay();
    expect(entry.attached).toBe(false);
    reconnect.mockRestore();
    expect(await connect(entry, 0)).toBe(true);
    await until(() => f.frames.filter(permission).length === 2 ? true : undefined, "original permission replay");
    answer();
    await f.completed();
    expect(entry.identity).toEqual(holderIdentity);
    expect(f.first.bridge.exitCode).toBeNull();
    expect(f.frames.filter(frame => frame.type === "hello")).toHaveLength(2);
    expect(accepted.mock.calls.filter(([, bytes]) => {
      const frame = JSON.parse((bytes as Buffer).toString());
      return frame.type === "input" && Buffer.from(frame.dataBase64, "base64").toString()
        .includes('"id":"fixture-client-reply","result"');
    })).toHaveLength(1);
  } finally { reconnect.mockRestore(); }
}, 30_000);
