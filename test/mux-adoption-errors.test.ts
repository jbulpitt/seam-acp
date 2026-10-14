import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/mux-adoption-error.mjs", import.meta.url));

describe("adoption replay errors cannot crash the controller", () => {
  it("logs a missing slot's real cause without an error listener or an unhandled rejection", async () => {
    // A separate Node process reproduces the fatal EventEmitter contract.
    const { stdout, stderr } = await execute(process.execPath,
      ["--unhandled-rejections=strict", "--import", "tsx", fixture, "unowned"], { timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual({ survived: true, errors: [] });
    expect(stderr).toContain("retained-host");
    expect(stderr).toContain("42");
    expect(stderr).toContain("replayOutput: slot does not exist");
    expect(stderr).not.toContain("Unhandled 'error' event");
  }, 15_000);

  it("delivers the original replay cause once to its existing runtime listener", async () => {
    const { stdout, stderr } = await execute(process.execPath,
      ["--unhandled-rejections=strict", "--import", "tsx", fixture, "owned"], { timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual({ survived: true, errors: ["replayOutput: slot does not exist"] });
    expect(stderr).toBe("");
  }, 15_000);
});
