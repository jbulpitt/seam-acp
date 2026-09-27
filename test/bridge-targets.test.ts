import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_BRIDGE_TARGETS_RELATIVE,
  LOCAL_BRIDGE_TARGETS_RELATIVE,
  resolveBridgeTargetsFile,
} from "../scripts/lib/bridge-targets.mjs";

describe("bridge target map location", () => {
  const root = path.resolve("/fixture/seam-acp");
  const local = path.join(root, LOCAL_BRIDGE_TARGETS_RELATIVE);
  const legacy = path.join(root, LEGACY_BRIDGE_TARGETS_RELATIVE);

  it("prefers the private deployment notes", () => {
    expect(resolveBridgeTargetsFile(root, {}, (file) => file === local || file === legacy))
      .toBe(local);
  });

  it("falls back to the legacy tracked location", () => {
    expect(resolveBridgeTargetsFile(root, {}, (file) => file === legacy))
      .toBe(legacy);
  });

  it("honors an explicit relative or absolute path", () => {
    expect(resolveBridgeTargetsFile(root, { SEAM_BRIDGE_TARGETS_FILE: "operator/targets.json" }, () => true))
      .toBe(path.join(root, "operator/targets.json"));
    expect(resolveBridgeTargetsFile(root, { SEAM_BRIDGE_TARGETS_FILE: "/etc/seam/targets.json" }, () => true))
      .toBe("/etc/seam/targets.json");
  });

  it("explains how to create a missing map", () => {
    expect(() => resolveBridgeTargetsFile(root, {}, () => false))
      .toThrow(/docs\/local\/bridge-targets\.json.*targets\.example\.json/);
  });
});
