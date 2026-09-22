import { afterEach, describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve("scripts/install-macos-bridge.sh");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fakeInstallerHost(
  version: string,
  abi: string,
  relativeNode = false,
  replacement?: { version: string; abi: string },
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-macos-installer-"));
  temporaryRoots.push(root);
  const home = path.join(root, "home");
  const seamHome = path.join(home, ".seam");
  const repo = path.join(root, "repo");
  const workspace = path.join(root, "workspace");
  const fakeBin = path.join(root, "fake-bin");
  const nodeDir = relativeNode ? path.join(root, "relative-bin") : path.join(seamHome, "node", "bin");
  const pm2Log = path.join(root, "pm2.log");
  const nodeProbeState = path.join(root, "node-probed");
  for (const dir of [home, repo, workspace, fakeBin, nodeDir, path.join(seamHome, "bin"), path.join(repo, "packages/bridge/dist")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(repo, "packages/bridge/dist/index.js"), "// fixture\n");
  const node = path.join(nodeDir, "node");
  fs.writeFileSync(node, `#!/bin/sh\ncase "$1" in\n  -v|--version) if test -e '${nodeProbeState}'; then printf '%s\\n' '${replacement?.version ?? version}'; else printf '%s\\n' '${version}'; fi ;;\n  -p) if test -e '${nodeProbeState}'; then printf '%s\\n' '${replacement?.abi ?? abi}'; else : > '${nodeProbeState}'; printf '%s\\n' '${abi}'; fi ;;\n  *) exit 64 ;;\nesac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "uname"), "#!/bin/sh\ncase \"$1\" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac\n", { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "sw_vers"), "#!/bin/sh\necho 15.0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(seamHome, "bin", "pm2"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PM2_LOG\"\ncase \"$1\" in -v) echo 6.0.0; exit 0 ;; describe) exit 1 ;; *) exit 0 ;; esac\n", { mode: 0o755 });
  const relativeBin = path.relative(root, nodeDir);
  return {
    root,
    home,
    seamHome,
    repo,
    workspace,
    node,
    pm2Log,
    env: {
      ...process.env,
      HOME: home,
      SEAM_HOME: seamHome,
      PM2_LOG: pm2Log,
      PATH: `${relativeNode ? relativeBin : fakeBin}:${relativeNode ? fakeBin : "/usr/bin:/bin"}${relativeNode ? ":/usr/bin:/bin" : ""}`,
    },
  };
}

function runInstaller(fixture: ReturnType<typeof fakeInstallerHost>, pairing = true) {
  const args = [
    script,
    "--skip-deps",
    "--dir", fixture.repo,
  ];
  if (pairing) args.push(
    "--connect", "seam-bridge connect --server wss://example.invalid/bridge --id fixture --token fixture-token",
    "--cwd", fixture.workspace,
    "-y",
  );
  return spawnSync("/bin/bash", args, {
    cwd: fixture.root,
    env: fixture.env,
    encoding: "utf8",
    // A removed early preflight reaches /dev/tty and recreates the incident's
    // silent wait shape under a PTY. Keep the regression itself bounded.
    timeout: 5_000,
  });
}

describe("install-macos-bridge.sh parser", () => {
  it("passes --self-test (canonical line, Discord paste, flag order, missing token)", () => {
    const out = execFileSync("bash", [script, "--self-test"], {
      encoding: "utf8",
    });
    expect(out).toContain("all parser tests passed");
  });

  it("refuses ABI 137 before writing config or invoking PM2", () => {
    const fixture = fakeInstallerHost("v24.15.0", "137");
    const result = runInstaller(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported ABI 137");
    expect(result.stderr).toContain("refusing to create or recreate the bridge entry");
    expect(fs.existsSync(path.join(fixture.seamHome, "bridge", "ecosystem.config.cjs"))).toBe(false);
    expect(fs.existsSync(fixture.pm2Log)).toBe(false);
  });

  it("refuses an unsupported runtime before requesting pairing credentials", () => {
    const fixture = fakeInstallerHost("v24.15.0", "137");
    const result = runInstaller(fixture, false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported ABI 137");
    expect(result.stderr).not.toContain("could not find --server");
  });

  it("pins the independently allowed ABI 127 interpreter by absolute path", () => {
    const fixture = fakeInstallerHost("v22.22.2", "127");
    const result = runInstaller(fixture);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const ecosystem = fs.readFileSync(path.join(fixture.seamHome, "bridge", "ecosystem.config.cjs"), "utf8");
    expect(ecosystem).toContain(`interpreter: ${JSON.stringify(fixture.node)}`);
    expect(ecosystem).not.toContain('interpreter: "node"');
    expect(fs.readFileSync(fixture.pm2Log, "utf8")).toContain("start");
  });

  it("refuses a PATH-relative interpreter before writing config", () => {
    const fixture = fakeInstallerHost("v22.22.2", "127", true);
    const result = runInstaller(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node interpreter must be an absolute path");
    expect(fs.existsSync(path.join(fixture.seamHome, "bridge", "ecosystem.config.cjs"))).toBe(false);
  });

  it("re-probes the bound artifact immediately before the first PM2 config write", () => {
    const fixture = fakeInstallerHost("v22.22.2", "127", false, { version: "v24.15.0", abi: "137" });
    const result = runInstaller(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported ABI 137");
    expect(fs.existsSync(path.join(fixture.seamHome, "bridge", "ecosystem.config.cjs"))).toBe(false);
    expect(fs.existsSync(fixture.pm2Log)).toBe(false);
  });

  it("keeps the installer ABI allowlist aligned with the rollout contract", () => {
    const installer = fs.readFileSync(script, "utf8");
    const rollout = fs.readFileSync(path.resolve("scripts/bridge-rollout-remote.mjs"), "utf8");
    const installerAbis = installer.match(/NODE_NATIVE_PREBUILD_ABIS="([0-9 ]+)"/)?.[1].split(" ");
    const remoteLiteral = rollout.match(/NATIVE_PREBUILD_ABIS = new Set\(\[([^\]]+)\]\)/)?.[1] ?? "";
    const remoteAbis = [...remoteLiteral.matchAll(/"(\d+)"/g)].map((match) => match[1]);
    const localRollout = fs.readFileSync(path.resolve("scripts/lib/bridge-rollout.mjs"), "utf8");
    const localLiteral = localRollout.match(/NATIVE_PREBUILD_ABIS = new Set\(\[([^\]]+)\]\)/)?.[1] ?? "";
    const localAbis = [...localLiteral.matchAll(/"(\d+)"/g)].map((match) => match[1]);
    expect(installerAbis).toEqual(["108", "115", "127", "131"]);
    expect(remoteAbis).toEqual(["108", "115", "127", "131"]);
    expect(localAbis).toEqual(["108", "115", "127", "131"]);
  });
});
