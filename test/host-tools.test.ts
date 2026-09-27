import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function context(cwd: string, workspaceRoot = cwd) {
  return {
    adapters: new Map(),
    cwd,
    workspaceRoot,
  };
}

describe("bridge host operations", () => {
  it("runs outside the workspace root and returns exit metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "seam-host-exec-"));
    dirs.push(dir);
    const root = path.join(dir, "workspace");
    const outside = path.join(dir, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);

    const result = await dispatchBridgeRpc(
      "shell",
      {
        command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.cwd())'`,
        cwd: outside,
        timeoutSec: 5,
      },
      undefined,
      context(root)
    ) as {
      stdout: string;
      exitCode: number | null;
      timedOut: boolean;
      stdoutTruncated: boolean;
    };

    expect(result).toMatchObject({
      stdout: outside,
      exitCode: 0,
      timedOut: false,
      stdoutTruncated: false,
    });
  });

  it("bounds output without killing the command", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "seam-host-output-"));
    dirs.push(dir);
    const result = await dispatchBridgeRpc(
      "shell",
      {
        command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(70000))'`,
        timeoutSec: 5,
      },
      undefined,
      context(dir)
    ) as { stdout: string; exitCode: number | null; stdoutTruncated: boolean };

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(64 * 1024);
    expect(result.stdoutTruncated).toBe(true);
  });

  it("returns non-zero exit and stderr as the real result", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "seam-host-exit-"));
    dirs.push(dir);
    const result = await dispatchBridgeRpc(
      "shell",
      {
        command: `${JSON.stringify(process.execPath)} -e 'process.stderr.write("broken");process.exit(7)'`,
      },
      undefined,
      context(dir)
    ) as { stderr: string; exitCode: number | null; timedOut: boolean };

    expect(result).toMatchObject({ stderr: "broken", exitCode: 7, timedOut: false });
  });

  it("reports command timeout as a bounded result", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "seam-host-timeout-"));
    dirs.push(dir);
    const result = await dispatchBridgeRpc(
      "shell",
      {
        command: `${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'`,
        timeoutSec: 1,
      },
      undefined,
      context(dir)
    ) as { timedOut: boolean; exitCode: number | null; signal: string | null };

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toMatch(/^SIG/);
  });

  it("round-trips binary bytes through unrestricted attachment paths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "seam-host-copy-"));
    dirs.push(dir);
    const root = path.join(dir, "workspace");
    const source = path.join(dir, "outside", "source.bin");
    const destination = path.join(dir, "elsewhere", "destination.bin");
    const expected = Buffer.from([0, 1, 2, 255, 10, 13, 0, 42]);
    await fs.mkdir(root);
    await fs.mkdir(path.dirname(source));
    await fs.writeFile(source, expected);

    const read = await dispatchBridgeRpc(
      "readAttachment",
      { hostPath: true, path: source },
      undefined,
      context(root)
    ) as { bytesBase64: string; size: number };
    const written = await dispatchBridgeRpc(
      "writeAttachment",
      { hostPath: true, path: destination, bytesBase64: read.bytesBase64 },
      undefined,
      context(root)
    ) as { path: string; size: number };

    expect(read.size).toBe(expected.byteLength);
    expect(written).toEqual({ path: destination, size: expected.byteLength });
    expect(await fs.readFile(destination)).toEqual(expected);
  });
});
