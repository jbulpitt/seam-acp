/**
 * #397 — the exit-code contract, exercised the way an operator runs it.
 *
 * `test/verify-agy-deployment.test.ts` calls `verifyAgyDeployment()` and
 * `main(argv)` in-process. That covers every check, and it covered none of
 * this: anything the **node runtime** consumes before the script starts is
 * invisible to an in-process caller. `--env-file` is a node option, and node
 * scans the whole argv for its own options even after the script path — so
 * `node verify-agy-deployment.mjs --env-file <MISSING>` aborted at exit 9 with
 * the script never running, on exactly the host (`media-server`) whose
 * NOT-DEPLOYED verdict and exit 3 had just been written for it.
 *
 * Every test here spawns a real `node`. That is the point; an in-process
 * assertion cannot observe a flag the runtime ate.
 *
 * The exit codes are the contract a rollout script reads:
 *   0  correct
 *   1  deployed, but not to the reference layout
 *   3  agy is not deployed on this host at all — an observation, not a failure
 *   2  the tool was invoked wrongly
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGY_DEPLOYMENT_FLAGS } from "../scripts/verify-agy-deployment.mjs";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "verify-agy-deployment.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Run { code: number; stdout: string; stderr: string }

function run(args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const BODY = Buffer.from("#!/bin/sh\nexit 0\n");
const DIGEST = createHash("sha256").update(BODY).digest("hex");

/** A host whose pins are in the pm2 ecosystem module the fleet uses. */
function fixture(opts: { correct: boolean }): { pinsFile: string; runtimeParent: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seam-397-")));
  roots.push(root);
  const runtimeParent = path.join(root, "opt", "seam", "agy-runtime");
  // When `correct` is false the tree sits under $HOME, which fails
  // runtime-root-managed and ancestors-durable — a real misdeployment.
  const runtimeRoot = opts.correct ? runtimeParent : path.join(root, "home", ".seam", "agy-runtime");
  const release = path.join(runtimeRoot, DIGEST);
  fs.mkdirSync(release, { recursive: true });
  const cliPath = path.join(release, "agy");
  fs.writeFileSync(cliPath, BODY);
  fs.chmodSync(cliPath, 0o555);
  const pinsFile = path.join(root, "ecosystem.config.cjs");
  fs.writeFileSync(pinsFile, [
    "module.exports = {",
    "  apps: [",
    "    {",
    `      name: "seam-bridge",`,
    "      env: {",
    `        AGY_ENABLED: "true",`,
    `        AGY_RUNTIME_ROOT: "${runtimeRoot}",`,
    `        AGY_SHA256: "${DIGEST}",`,
    `        AGY_CLI_PATH: "${cliPath}",`,
    `        AGY_VERSION: "1.1.28",`,
    `        AGY_DEFAULT_MODEL: "gemini-3.8-flash-high",`,
    "      },",
    "    },",
    "  ],",
    "};",
    "",
  ].join("\n"));
  return { pinsFile, runtimeParent };
}

describe("#397 the exit-code contract, from a real node process", () => {
  /**
   * Exit **0** is deliberately not asserted here, and the reason is worth
   * recording rather than working around.
   *
   * A passing verdict requires every ancestor of the binary to be root-owned,
   * all the way to `/`. The in-process suite injects a `statSync` that reports
   * uid 0; a spawned process cannot be lied to that way. A Linux user namespace
   * (`unshare -r`) was tried and does not help: files created inside it are
   * uid 0, but the pre-existing `/tmp` and `/` belong to real root, which maps
   * to `nobody` inside the namespace — so the walk to `/` can never be clean.
   * Short of running the suite as root or chrooting, exit 0 is not reachable
   * from an unprivileged spawn.
   *
   * So this asserts the strongest thing a test CAN: that a spawned process
   * reaches a fully-passing state for every check a fixture is able to set up,
   * and that the only failure is the one the environment makes inevitable.
   * Exit 0 itself is covered by running the built tool on the real fleet, where
   * macbook-pro, macbook-air and home-hub return it — see the PR.
   */
  it("passes every check a fixture can control, failing only on ancestors it cannot", () => {
    const { pinsFile, runtimeParent } = fixture({ correct: true });
    const result = run(["--pins-file", pinsFile, "--runtime-parent", runtimeParent]);
    const failing = result.stdout.split("\n")
      .filter((line) => line.trim().startsWith("FAIL "))
      .map((line) => line.trim().replace(/^FAIL\s+/, ""));
    expect(failing).toEqual(["ancestors-durable"]);
    for (const id of ["pins-in-file", "layout-canonical", "runtime-root-managed",
      "artifact-present", "artifact-digest", "artifact-mode", "path-not-symlinked"]) {
      expect(result.stdout).toContain(`PASS  ${id}`);
    }
    expect(result.code).toBe(1);
  });

  it("exits 1 for a host deployed outside the reference layout", () => {
    // Not 0 and not 3: this host HAS agy, staged somewhere it should not be.
    const { pinsFile, runtimeParent } = fixture({ correct: false });
    const result = run(["--pins-file", pinsFile, "--runtime-parent", runtimeParent]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("agy deployment: FAIL");
    expect(result.stdout).toContain("host was not modified");
  });

  it("exits 3 when agy is not deployed, with the pins file absent", () => {
    // media-server. This is the case #397 made unreachable through the
    // documented invocation, so it is asserted through a real spawn.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seam-397-")));
    roots.push(root);
    const result = run(["--pins-file", path.join(root, "ecosystem.config.cjs")]);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("agy deployment: NOT-DEPLOYED");
    expect(result.stdout).toContain("(absent)");
  });

  it("exits 2 when invoked wrongly, without pretending to have checked anything", () => {
    const result = run([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--pins-file is required");
    expect(result.stdout).not.toContain("agy deployment:");
  });

  it("refuses --env-file by name and points at the flag that works", () => {
    // With an EXISTING file node passes the flag through, so the script is
    // reached and can say something useful to an operator following a stale
    // runbook. With a missing file node aborts first — which is the whole
    // reason the synonym is gone rather than documented.
    const { pinsFile } = fixture({ correct: true });
    const result = run(["--env-file", pinsFile]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--env-file is a node option");
    expect(result.stderr).toContain("--pins-file");
  });
});

describe("#397 no flag this tool accepts may be one node also parses", () => {
  it.each(AGY_DEPLOYMENT_FLAGS)(
    "reaches the script when %s is given a path that does not exist", (flag) => {
      // The generalising guard. A future flag colliding with a node option
      // reproduces #397 exactly, and the symptom is that the runtime answers
      // instead of the script. Pointing each flag at a missing path is what
      // makes a collision fire: node only aborts when it cannot load the file.
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seam-397-")));
      roots.push(root);
      const missing = path.join(root, "does-not-exist");
      const args = flag === "--probe" || flag === "--json"
        ? ["--pins-file", missing, flag]
        : ["--pins-file", missing, flag, missing];
      const result = run(args);
      // 9 is node's "cannot load the file I was told to load". Any appearance
      // of it means the runtime consumed one of our flags.
      expect(result.code).not.toBe(9);
      expect(result.stderr).not.toMatch(/^node: /m);
    });
});
