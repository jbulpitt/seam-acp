import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAgyUnpinnedRuntime } from "../packages/adapters/src/agy-unpinned-runtime.js";
import {
  inventoryFromAdapters,
  loadHostAdapterInventory,
} from "../packages/bridge/src/inventory.js";
import { dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-probe-"));
  dirs.push(dir);
  const executable = path.join(dir, "agy");
  fs.writeFileSync(executable, body, { mode: 0o755 });
  const env = { PATH: dir, HOME: dir };
  return {
    dir, executable, env,
    load: () => makeAgyUnpinnedRuntime({
      credentialScope: "antigravity-oauth:fixture", cwd: dir, baseEnv: env,
    }),
  };
}

function failure(load: () => unknown): Error {
  try {
    load();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected the controlled version probe to fail");
}

describe("unpinned AGY startup version diagnostics", () => {
  it("retains a nonzero exit without publishing captured output or launch paths", () => {
    const probe = fixture("#!/bin/sh\necho private-stdout\necho private-stderr >&2\nexit 23\n");
    const error = failure(probe.load);
    expect(error.message).toBe("ordinary agy --version failed (exit=23); the unpinned binary is not usable");
    expect(error.message).not.toContain(probe.dir);
    expect(error.message).not.toContain("private-stdout");
    expect(error.message).not.toContain("private-stderr");
    expect(error.cause).toBeUndefined();
  });

  it("retains the exact spawn error as cause and its safe code in the diagnostic", () => {
    const probe = fixture("#!/seam-1138-missing-interpreter\n");
    const error = failure(probe.load);
    expect(error.message).toBe("ordinary agy --version failed (code=ENOENT); the unpinned binary is not usable");
    expect(error.message).not.toContain(probe.dir);
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toMatchObject({
      code: "ENOENT", path: probe.executable, spawnargs: ["--version"],
    });
  });

  it("retains signal termination", () => {
    const probe = fixture("#!/bin/sh\nkill -TERM $$\n");
    const error = failure(probe.load);
    expect(error.message).toBe("ordinary agy --version failed (signal=SIGTERM); the unpinned binary is not usable");
    expect(error.cause).toBeUndefined();
  });

  it("retains timeout and kill signal with the existing five-second probe bound", () => {
    // exec keeps the timeout fixture to one child, killed by the real probe.
    const probe = fixture("#!/bin/sh\nexec /bin/sleep 30\n");
    const error = failure(probe.load);
    expect(error.message).toBe("ordinary agy --version failed (code=ETIMEDOUT, signal=SIGKILL); the unpinned binary is not usable");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toMatchObject({ code: "ETIMEDOUT", path: probe.executable });
  }, 10_000);

  it("retains the bounded-output spawn error", () => {
    const probe = fixture("#!/bin/sh\nwhile :; do printf '%0100d' 0; done\n");
    const error = failure(probe.load);
    expect(error.message).toContain("code=ENOBUFS");
    expect(error.cause).toMatchObject({ code: "ENOBUFS" });
  });

  it.each([
    ["printf '1.5.14\\nignored second line\\n'", "1.5.14"],
    ["exit 0", "unpinned"],
  ])("preserves successful version discovery: %s", (body, version) => {
    const probe = fixture(`#!/bin/sh\n${body}\n`);
    expect(probe.load().descriptor.provenance.version).toBe(version);
  });

  it("keeps the failed startup map unchanged after the binary recovers; a fresh inventory registers AGY", async () => {
    const probe = fixture("#!/bin/sh\nexit 23\n");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = vi.fn();
    const options = {
      cwd: probe.dir,
      env: {
        ...probe.env, AGY_ENABLED: "true", AGY_PIN: "unpinned",
        AGY_DEFAULT_MODEL: "fixture-model",
      },
      exists: (bin: string) => bin === "agy" || bin === "fixture-copilot",
      onAdapterRefused: refused,
    };
    const startup = loadHostAdapterInventory("fixture-copilot", options);
    expect([...startup.adapters.keys()]).toEqual(["copilot"]);
    expect(startup.adapterRefusals).toEqual([{ agentId: "agy", code: "runtime_refused" }]);
    expect(refused).toHaveBeenCalledExactlyOnceWith("agy",
      "ordinary agy --version failed (exit=23); the unpinned binary is not usable");
    expect(log.mock.calls.flat().join(" ")).toContain("exit=23");
    expect(log.mock.calls.flat().join(" ")).not.toContain(probe.dir);

    fs.writeFileSync(probe.executable, "#!/bin/sh\necho 1.5.14\n", { mode: 0o755 });
    expect(probe.load().descriptor.provenance.version).toBe("1.5.14");
    // Reconnection republishes this retained map, rather than reloading factories.
    expect(inventoryFromAdapters(startup.adapters, "fixture-copilot", options.env)
      .map(row => row.agentId)).toEqual(["copilot"]);
    await expect(dispatchBridgeRpc("fetchModelCatalog", {}, "agy", {
      adapters: startup.adapters, workspaceRoot: probe.dir, cwd: probe.dir,
    })).rejects.toThrow("unknown agentId: agy");

    const restarted = loadHostAdapterInventory("fixture-copilot", options);
    expect([...restarted.adapters.keys()]).toEqual(["copilot", "agy"]);
    expect(restarted.adapterRefusals).toEqual([]);
    expect(restarted.adapters.get("agy")!.runtime?.provenance.version).toBe("1.5.14");
  });
});
