/**
 * #510 — unpinned is a mode. Deleting the digest pins is not it, and the
 * mode does not snapshot the binary. A second spawn must observe a rewrite
 * of the PATH entry; the pinned path would still be executing the first bytes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGY_UNPINNED_GIVE_UP } from "../packages/adapters/src/agy-pin-mode.js";
import {
  makeAgyUnpinnedRuntime,
  resolveOrdinaryAgyExecutable,
} from "../packages/adapters/src/agy-unpinned-runtime.js";
import { AGY_UNPINNED_GIVE_UP as verifierGiveUp } from "../scripts/verify-agy-deployment.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function installAgy(body: string): { dir: string; executable: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-unpinned-"));
  dirs.push(dir);
  const executable = path.join(dir, "agy");
  fs.writeFileSync(executable, body, { mode: 0o755 });
  return { dir, executable };
}

describe("unpinned AGY", () => {
  it("keeps the give-up sentence the verifier reports identical to the runtime", () => {
    expect(verifierGiveUp).toBe(AGY_UNPINNED_GIVE_UP);
    expect(AGY_UNPINNED_GIVE_UP).toContain("snapshot");
    expect(AGY_UNPINNED_GIVE_UP).toContain("writable-path");
  });

  it("executes the PATH entry by name, so a rewrite is what the next child runs", () => {
    const first = "#!/bin/sh\necho no-fd3\n";
    const { dir, executable } = installAgy(first);
    const env = { PATH: dir, HOME: os.homedir() };
    expect(resolveOrdinaryAgyExecutable(env)).toBe(executable);
    const runtime = makeAgyUnpinnedRuntime({
      credentialScope: "antigravity-oauth:default",
      cwd: dir,
      baseEnv: env,
    });
    expect(runtime.descriptor.provenance.sha256).toBeUndefined();
    expect(runtime.descriptor.executable).toBe(executable);

    const run = () => {
      const child = runtime.prepare(["--version"], dir, {
        stdio: ["ignore", "pipe", "pipe"],
      }).spawn();
      let text = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { text += chunk; });
      return new Promise<string>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve(text.trim()));
      });
    };

    return run().then((firstOut) => {
      expect(firstOut).toBe("no-fd3");
      fs.writeFileSync(executable, "#!/bin/sh\necho replaced\n", { mode: 0o755 });
      return run().then((secondOut) => {
        expect(secondOut).toBe("replaced");
      });
    });
  });
});
