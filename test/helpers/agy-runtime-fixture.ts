import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeAgyNativeRuntime, type AgyNativeRuntime } from "@seam/adapters";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultSource = path.join(here, "..", "fixtures", "fake-agy-command.mjs");

export interface ManagedAgyFixture {
  runtime: AgyNativeRuntime;
  executable: string;
  runtimeRoot: string;
  sha256: string;
  cleanup(): void;
}

export function createManagedAgyFixture(options: {
  source?: string;
  version?: string;
  credentialScope?: string;
  cwd?: string;
  baseEnv?: NodeJS.ProcessEnv;
  approvedEnvironment?: Readonly<Record<string, string>>;
} = {}): ManagedAgyFixture {
  const source = options.source ?? defaultSource;
  const bytes = fs.readFileSync(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-runtime-fixture-"));
  const runtimeRoot = path.join(ownerRoot, "runtime");
  const releaseDir = path.join(runtimeRoot, sha256);
  const executable = path.join(releaseDir, process.platform === "win32" ? "agy.exe" : "agy");
  fs.mkdirSync(releaseDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(executable, bytes, { mode: 0o500 });
  fs.chmodSync(executable, 0o500);
  fs.chmodSync(releaseDir, 0o500);
  fs.chmodSync(runtimeRoot, 0o500);
  const runtime = makeAgyNativeRuntime({
    executable,
    runtimeRoot,
    version: options.version ?? "agy-test 1.0",
    sha256,
    credentialScope: options.credentialScope ?? "antigravity-oauth:test",
    cwd: options.cwd ?? os.tmpdir(),
    baseEnv: options.baseEnv ?? process.env,
    approvedEnvironment: {
      ...((options.version ?? "agy-test 1.0") !== "agy-test 1.0"
        ? { FAKE_AGY_VERSION: options.version! }
        : {}),
      ...(options.approvedEnvironment ?? {}),
    },
  });
  return {
    runtime,
    executable,
    runtimeRoot,
    sha256,
    cleanup() {
      fs.chmodSync(runtimeRoot, 0o700);
      fs.chmodSync(releaseDir, 0o700);
      fs.chmodSync(executable, 0o700);
      fs.rmSync(ownerRoot, { recursive: true, force: true });
    },
  };
}
