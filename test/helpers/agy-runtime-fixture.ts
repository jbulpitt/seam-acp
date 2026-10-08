import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeAgyNativeRuntime, makeAgyUnpinnedRuntime, type AgyNativeRuntime } from "@seam/adapters";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultSource = path.join(here, "..", "fixtures", "fake-agy-command.mjs");

export interface ManagedAgyFixture {
  runtime: AgyNativeRuntime;
  executable: string;
  runtimeRoot: string;
  sha256: string;
  cleanup(): void;
}

interface AgyFixtureOptions {
  source?: string;
  version?: string;
  credentialScope?: string;
  cwd?: string;
  baseEnv?: NodeJS.ProcessEnv;
  environment?: Readonly<Record<string, string>>;
}

function fixtureEnvironment(options: AgyFixtureOptions) {
  return { FAKE_AGY_VERSION: options.version ?? "agy-test 1.0", ...options.environment };
}

function fixtureSource(options: AgyFixtureOptions): string {
  return fs.readFileSync(options.source ?? defaultSource, "utf8").replace(/^#![^\n]*(?:\n|$)/, "");
}

export function createOrdinaryAgyFixture(options: AgyFixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-ordinary-fixture-"));
  const executable = path.join(root, "agy");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(executable, `#!${process.execPath}\nObject.assign(process.env, ${JSON.stringify(fixtureEnvironment(options))});\n${fixtureSource(options)}`, { mode: 0o700 });
  const baseEnv = options.baseEnv ?? process.env;
  const runtime = makeAgyUnpinnedRuntime({
    credentialScope: options.credentialScope ?? "antigravity-oauth:test",
    cwd: options.cwd ?? os.tmpdir(),
    baseEnv: { ...baseEnv, PATH: `${root}${path.delimiter}${baseEnv.PATH ?? ""}` },
  });
  return { runtime, executable, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export type OrdinaryAgyFixture = ReturnType<typeof createOrdinaryAgyFixture>;

export function createManagedAgyFixture(options: AgyFixtureOptions = {}): ManagedAgyFixture {
  const source = options.source ?? defaultSource;
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-runtime-fixture-"));
  let bytes = fs.readFileSync(source);
  if (bytes.subarray(0, 64).toString().startsWith("#!/usr/bin/env node\n")) {
    // Enter the same native exec route as a managed AGY artifact.
    const program = `Object.assign(process.env, ${JSON.stringify(fixtureEnvironment(options))}); await import('data:text/javascript;base64,${Buffer.from(fixtureSource(options)).toString("base64")}');`;
    const native = path.join(ownerRoot, "native-fixture");
    execFileSync("cc", ["-x", "c", "-o", native, "-"], { input: `
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
  char **args = calloc(argc + 5, sizeof(char *));
  args[0] = ${JSON.stringify(process.execPath)};
  args[1] = "--input-type=module";
  args[2] = "--eval";
  args[3] = ${JSON.stringify(program)};
  args[4] = "agy";
  for (int i = 1; i < argc; i++) args[i + 4] = argv[i];
  execv(args[0], args);
  perror("native fixture exec");
  return 1;
}
` });
    bytes = fs.readFileSync(native);
    fs.unlinkSync(native);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
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
