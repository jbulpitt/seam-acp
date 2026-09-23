import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertTargetRegistered, describeTargetFleet, formatFleetCoverage, validateBridgeRegistry } from "../scripts/lib/bridge-fleet.mjs";
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
  it("reconciles all nine registered hosts and names every rollout exclusion", () => {
    const registered = validateBridgeRegistry(registeredShape);
    const fleet = describeTargetFleet(targetMap, registered);
    expect(fleet.registered).toHaveLength(9);
    expect(fleet.rolloutManaged).toEqual(["fhr-server", "macbook-air", "macbook-pro", "media-server", "plex-server", "rhc-server"]);
    expect(fleet.rolloutExcluded.map((row) => row.id)).toEqual([
      "alaina-laptop", "allie-laptop", "jennifer-laptop",
    ]);
    expect(formatFleetCoverage(fleet, "media-server")).toContain("fleet_rollout_managed=6 of 9");
    expect(formatFleetCoverage(fleet, "media-server")).toContain("operation_scope=1 of 9 registered hosts: media-server");
  });

  it("narrows to the divergent host when a live registered bridge has no rollout record", () => {
    // #413 needed divergence to be LOUD, not to stop the fleet. Refusing all
    // ten hosts because one diverged punished nine healthy machines for an
    // ordinary state (a retired box, an unreachable laptop). It is reported,
    // excluded from managed scope, and named in the coverage line instead.
    const missing = structuredClone(configured);
    delete missing.targets["plex-server"];
    const fleet = describeTargetFleet(validateTargetMap(missing), validateBridgeRegistry(registeredShape));
    expect(fleet.diverged.map((d) => d.id)).toEqual(["plex-server"]);
    expect(fleet.rolloutManaged).not.toContain("plex-server");
    expect(formatFleetCoverage(fleet)).toContain("plex-server");
    // …and the coverage claim shrinks with it, so a run can never overstate.
    expect(fleet.rolloutManaged.length).toBeLessThan(fleet.registered.length);
  });

  it("still refuses when the host you are operating on is the divergent one", () => {
    // The protection #413 actually needed: you cannot act on a host whose
    // registration you do not understand.
    const missing = structuredClone(configured);
    delete missing.targets["plex-server"];
    const fleet = describeTargetFleet(validateTargetMap(missing), validateBridgeRegistry(registeredShape));
    expect(() => assertTargetRegistered(fleet, "plex-server"))
      .toThrow(/registry divergence for plex-server/);
    // Every other host stays operable.
    expect(() => assertTargetRegistered(fleet, "media-server")).not.toThrow();
  });

  it("narrows a stale rollout target that is no longer registered", () => {
    const stale = structuredClone(configured);
    stale.targets["retired-host"] = {
      sshAlias: null,
      pm2App: null,
      verifyAgent: null,
      rolloutEnabled: false,
      unmanagedReason: "retired fixture",
    };
    const fleet = describeTargetFleet(validateTargetMap(stale), validateBridgeRegistry(registeredShape));
    expect(fleet.diverged.map((d) => d.id)).toEqual(["retired-host"]);
    expect(fleet.rolloutManaged).not.toContain("retired-host");
    expect(() => assertTargetRegistered(fleet, "retired-host")).toThrow(/registry divergence/);
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
    // An unrelated divergent host no longer stops this run. It is reported in
    // coverage and excluded; the command then stops at the ordinary refusal for
    // the target actually selected. Never reaching SSH is still the boundary.
    expect(stderr).not.toContain("ssh:");
    expect(stderr).toMatch(/jennifer-laptop/);
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
    expect(stdout).toContain("fleet_registered=9");
    expect(stdout).toContain("fleet_rollout_managed=6 of 9");
    expect(stdout).toContain("fleet_excluded=jennifer-laptop: agy-only pm2 host has no passwordless sudo; its Aug 21 bridge ignores runtime pins, so a rollout would take it dark (#388)");
    expect(stdout).toContain("fleet_excluded=allie-laptop: pm2 seam-bridge runs as alliebulpitt uid 502; SSH user jessebulpitt cannot write that home and rollout does not elevate (#494)");
    expect(stdout).toContain("fleet_excluded=alaina-laptop: pm2 seam-bridge runs as alaina uid 502; SSH user jessebulpitt cannot write that home and rollout does not elevate (#494)");
    expect(stderr).toMatch(/jennifer-laptop is explicitly excluded.*#388/);
  });
});
