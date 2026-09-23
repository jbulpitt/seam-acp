import { describe, expect, it } from "vitest";
import { bridgeHello } from "../packages/bridge/src/hello.js";

describe("#574 bridge hello capability", () => {
  it("advertises durable slot ownership as a capability, never a version inference", () => {
    const hello = bridgeHello({
      bridgeId: "remote",
      instanceId: "instance-1",
      protocolVersion: 1,
      host: { os: "linux", arch: "x64" },
      agents: [],
    });
    expect(hello.capabilities).toEqual({ durableSlots: true });
    expect(hello.protocolVersion).toBe(1);
  });
});
