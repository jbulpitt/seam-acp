import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeTargetFleet, formatFleetCoverage, validateBridgeRegistry } from "../scripts/lib/bridge-fleet.mjs";
import { validateTargetMap } from "../scripts/lib/bridge-rollout.mjs";

const root = path.resolve(import.meta.dirname, "..");
const configured = JSON.parse(fs.readFileSync(path.join(root, "ops/bridge/targets.json"), "utf8"));
const targetMap = validateTargetMap(configured);
const registeredShape = {
  bridges: Object.fromEntries(Object.keys(configured.targets).map((id) => [id, { workspaceRoot: `/fixture/${id}` }])),
};
const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRegistry(shape = registeredShape): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-fleet-413-"));
  roots.push(dir);
  const file = path.join(dir, "channel-presets.json");
  fs.writeFileSync(file, JSON.stringify(shape));
  return file;
}

describe("#413 bridge fleet accounting", () => {
  it("reconciles all ten registered hosts and names every rollout exclusion", () => {
    const registered = validateBridgeRegistry(registeredShape);
    const fleet = describeTargetFleet(targetMap, registered);
    expect(fleet.registered).toHaveLength(10);
    expect(fleet.rolloutManaged).toEqual(["home-hub", "macbook-air", "macbook-pro", "media-server", "rhc-server"]);
    expect(fleet.rolloutExcluded.map((row) => row.id)).toEqual([
      "alaina-laptop", "allie-laptop", "fhr-server", "jennifer-laptop", "plex-server",
    ]);
    expect(fleet.rolloutExcluded.find((row) => row.id === "plex-server")?.reason).toMatch(/systemd.*dedicated/i);
    expect(formatFleetCoverage(fleet, "media-server")).toContain("fleet_rollout_managed=5 of 10");
    expect(formatFleetCoverage(fleet, "media-server")).toContain("operation_scope=1 of 10 registered hosts: media-server");
  });

  it("refuses a fleet claim when a live registered bridge has no rollout record", () => {
    const missing = structuredClone(configured);
    delete missing.targets["plex-server"];
    expect(() => describeTargetFleet(validateTargetMap(missing), validateBridgeRegistry(registeredShape)))
      .toThrow(/registered bridge.*absent from targets\.json: plex-server/);
  });

  it("refuses a stale rollout target that is no longer registered", () => {
    const stale = structuredClone(configured);
    stale.targets["retired-host"] = {
      sshAlias: null,
      pm2App: null,
      verifyAgent: null,
      rolloutEnabled: false,
      unmanagedReason: "retired fixture",
    };
    expect(() => describeTargetFleet(validateTargetMap(stale), validateBridgeRegistry(registeredShape)))
      .toThrow(/targets\.json host.*absent from the bridge registry: retired-host/);
  });

  it("keeps offline and deliberately excluded hosts in the denominator", () => {
    const fleet = describeTargetFleet(targetMap, validateBridgeRegistry(registeredShape));
    expect(fleet.registered).toContain("jennifer-laptop");
    expect(fleet.rolloutExcluded).toContainEqual(expect.objectContaining({
      id: "jennifer-laptop",
      reason: expect.stringMatching(/outside the PM2 bridge rollout contract/),
    }));
  });

  it("runs reconciliation in the real rollout CLI before any host command", () => {
    const divergent = structuredClone(registeredShape);
    divergent.bridges["unlisted-live-host"] = { workspaceRoot: "/fixture/unlisted" };
    const registry = tempRegistry(divergent);
    let stderr = "";
    try {
      // Select an excluded target so even a mutation removing reconciliation
      // cannot cross the test boundary into SSH; it will stop at the ordinary
      // target refusal instead.
      execFileSync(process.execPath, [path.join(root, "scripts/bridge-rollout.mjs"), "--target", "plex-server"], {
        cwd: root,
        env: { ...process.env, CHANNEL_PRESETS_FILE: registry },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
    } catch (error) {
      stderr = (error as { stderr?: string }).stderr ?? "";
    }
    expect(stderr).toMatch(/registry divergence.*unlisted-live-host/);
    expect(stderr).not.toContain("ssh:");
  });

  it("prints the complete denominator before refusing an explicitly excluded target", () => {
    const registry = tempRegistry();
    let stdout = "";
    let stderr = "";
    try {
      execFileSync(process.execPath, [path.join(root, "scripts/bridge-rollout.mjs"), "--target", "plex-server"], {
        cwd: root,
        env: { ...process.env, CHANNEL_PRESETS_FILE: registry },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }
    expect(stdout).toContain("fleet_registered=10");
    expect(stdout).toContain("fleet_rollout_managed=5 of 10");
    expect(stdout).toContain("fleet_excluded=plex-server: systemd launcher needs a dedicated activation and rollback contract");
    expect(stderr).toMatch(/plex-server is explicitly excluded.*systemd launcher/);
  });
});
