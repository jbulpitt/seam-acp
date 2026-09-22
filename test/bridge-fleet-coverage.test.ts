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
    expect(fleet.rolloutManaged).toEqual(["fhr-server", "home-hub", "macbook-air", "macbook-pro", "media-server", "plex-server", "rhc-server"]);
    expect(fleet.rolloutExcluded.map((row) => row.id)).toEqual([
      "alaina-laptop", "allie-laptop", "jennifer-laptop",
    ]);
    expect(formatFleetCoverage(fleet, "media-server")).toContain("fleet_rollout_managed=7 of 10");
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
    expect(fleet.rolloutExcluded).toEqual([
      {
        id: "alaina-laptop",
        reason: "pm2 seam-bridge runs as alaina uid 502; SSH user jessebulpitt cannot write that home and rollout does not elevate (#494)",
      },
      {
        id: "allie-laptop",
        reason: "pm2 seam-bridge runs as alliebulpitt uid 502; SSH user jessebulpitt cannot write that home and rollout does not elevate (#494)",
      },
      {
        id: "jennifer-laptop",
        reason: "agy-only pm2 host has no passwordless sudo; its Aug 21 bridge ignores runtime pins, so a rollout would take it dark (#388)",
      },
    ]);
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
      execFileSync(process.execPath, [path.join(root, "scripts/bridge-rollout.mjs"), "--target", "jennifer-laptop"], {
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
      execFileSync(process.execPath, [path.join(root, "scripts/bridge-rollout.mjs"), "--target", "jennifer-laptop"], {
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
    expect(stdout).toContain("fleet_rollout_managed=7 of 10");
    expect(stdout).toContain("fleet_excluded=jennifer-laptop: agy-only pm2 host has no passwordless sudo; its Aug 21 bridge ignores runtime pins, so a rollout would take it dark (#388)");
    expect(stdout).toContain("fleet_excluded=allie-laptop: pm2 seam-bridge runs as alliebulpitt uid 502; SSH user jessebulpitt cannot write that home and rollout does not elevate (#494)");
    expect(stdout).toContain("fleet_excluded=alaina-laptop: pm2 seam-bridge runs as alaina uid 502; SSH user jessebulpitt cannot write that home and rollout does not elevate (#494)");
    expect(stderr).toMatch(/jennifer-laptop is explicitly excluded.*#388/);
  });
});
