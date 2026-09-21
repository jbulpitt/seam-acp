/**
 * #483 — systemd activation uses the same stub the PM2 path already swaps.
 *
 * The launcher does `import(pathToFileURL(bridgePath))` of the stable
 * checkout entrypoint. If that import follows a symlink, activation is the
 * existing atomic stub plus SIGUSR2; Restart=always brings the unit back
 * without sudo.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeSshCommand, validateTargetMap } from "../scripts/lib/bridge-rollout.mjs";

const root = path.resolve(import.meta.dirname, "..");
const configured = JSON.parse(fs.readFileSync(path.join(root, "ops/bridge/targets.json"), "utf8"));
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

const systemdFixture = {
  rolloutEnabled: true,
  launcher: "systemd",
  sshAlias: "plex-server",
  pm2App: "seam-bridge",
  launcherPath: "/home/mediaserver/.local/libexec/seam-bridge-launch.mjs",
  verifyAgent: "grok",
  expectedUid: 1000,
  checkoutPath: "/home/mediaserver/.seam/seam-acp",
  entrypointPath: "/home/mediaserver/.seam/seam-acp/packages/bridge/dist/index.js",
  nodePath: "/home/mediaserver/.seam/node-v22.22.2/bin/node",
  workspaceArg: "/home/mediaserver/Projects",
  devMode: false,
  releaseRoot: "/home/mediaserver/.seam/bridge-rollouts",
};

describe("#483 systemd target identity", () => {
  it("accepts a systemd target without a PM2 module", () => {
    const targets = validateTargetMap({ schemaVersion: 3, targets: { "plex-server": systemdFixture } });
    const plex = targets.get("plex-server");
    expect(plex?.launcher).toBe("systemd");
    expect(plex?.launcherPath).toBe(systemdFixture.launcherPath);
    expect(plex?.pm2App).toBe("seam-bridge");
    expect(plex?.pm2ModulePath).toBeUndefined();
  });

  it("refuses a systemd target that still names a PM2 module", () => {
    expect(() => validateTargetMap({
      schemaVersion: 3,
      targets: { "plex-server": { ...systemdFixture, pm2ModulePath: "/home/mediaserver/.seam/lib/node_modules/pm2" } },
    })).toThrow(/must not declare a PM2 module/);
  });

  it("refuses a PM2 target that declares a systemd launcher path", () => {
    expect(() => validateTargetMap({
      schemaVersion: 3,
      targets: {
        "fixture-host": {
          rolloutEnabled: true, sshAlias: "fixture-host", pm2App: "fixture-bridge", verifyAgent: "grok",
          expectedUid: 501, checkoutPath: "/fixture/checkout",
          entrypointPath: "/fixture/checkout/packages/bridge/dist/index.js",
          nodePath: "/fixture/node", pm2ModulePath: "/fixture/pm2",
          releaseRoot: "/fixture/releases", workspaceArg: null, devMode: false,
          launcherPath: "/fixture/launch.mjs",
        },
      },
    })).toThrow(/must not declare a systemd launcher path/);
  });

  it("rollback onto an enrolled baseline proves supervisor identity without assuming PM2", () => {
    const remote = fs.readFileSync(path.join(root, "scripts/bridge-rollout-remote.mjs"), "utf8");
    const start = remote.indexOf("async function rollbackToEnrolledBaseline");
    const end = remote.indexOf("\nasync function rollback()");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = remote.slice(start, end);
    expect(body).toContain("processManagerSnapshot(after)");
    expect(body).not.toMatch(/after\.pm2\b/);
    expect(body).toContain('launcherKind === "systemd" ? launcherPath : entrypointPath');
  });

  it("streams launcher=systemd and the launcher path as remote identity args", () => {
    const targets = validateTargetMap({ schemaVersion: 3, targets: { "plex-server": systemdFixture } });
    const command = makeSshCommand(targets.get("plex-server")!, ["preflight"], "script");
    expect(command.args).toContain("systemd");
    expect(command.args).toContain(systemdFixture.launcherPath);
    expect(command.args).not.toContain("systemctl restart");
  });

  it("pins both live systemd hosts in the operator map", () => {
    const targets = validateTargetMap(configured);
    expect(targets.get("plex-server")).toMatchObject({
      launcher: "systemd",
      pm2App: "seam-bridge",
      expectedUid: 1000,
      nodePath: "/home/mediaserver/.seam/node-v22.22.2/bin/node",
    });
    expect(targets.get("fhr-server")).toMatchObject({
      launcher: "systemd",
      pm2App: "seam-bridge",
      expectedUid: 1000,
      devMode: true,
      nodePath: "/home/jessebulpitt/.nvm/versions/node/v22.22.2/bin/node",
    });
  });
});

describe("#483 the launcher import follows a release stub", () => {
  it("loads the symlink target, not a snapshot of the checkout file", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "seam-483-stub-"));
    dirs.push(dir);
    const target = path.join(dir, "releases", "deadbeef", "packages/bridge/dist/index.js");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const marker = `export const marker = ${JSON.stringify(dir)};\n`;
    await fsp.writeFile(target, marker);
    const stub = path.join(dir, "checkout", "packages/bridge/dist/index.js");
    await fsp.mkdir(path.dirname(stub), { recursive: true });
    await fsp.symlink(target, stub);
    const loaded = await import(pathToFileURL(stub).href);
    expect(loaded.marker).toBe(dir);
  });
});
