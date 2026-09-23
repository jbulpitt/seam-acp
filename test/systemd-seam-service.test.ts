import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const unitPath = path.resolve("ops/systemd/seam-acp.service");
const unit = readFileSync(unitPath, "utf8");
const localBridgeUnit = readFileSync(path.resolve("ops/systemd/seam-local-bridge.service"), "utf8");
const sessiondUnit = readFileSync(path.resolve("ops/systemd/seam-sessiond.service"), "utf8");

function directive(name: string): string[] {
  return [...unit.matchAll(new RegExp(`^${name}=(.+)$`, "gm"))].map((match) => match[1]!);
}

describe("seam-acp systemd supervisor policy", () => {
  it("signals the main process first and pins final cgroup cleanup", () => {
    expect(directive("KillSignal")).toEqual(["SIGTERM"]);
    expect(directive("KillMode")).toEqual(["mixed"]);
    expect(directive("FinalKillSignal")).toEqual(["SIGKILL"]);
    expect(directive("SendSIGKILL")).toEqual(["yes"]);
  });

  it("keeps the existing production stop and restart bounds", () => {
    expect(directive("TimeoutStopSec")).toEqual(["120s"]);
    expect(directive("Restart")).toEqual(["always"]);
    expect(directive("RestartSec")).toEqual(["5s"]);
  });

  it("runs the local bridge and descriptor owner outside seam-acp's cgroup", () => {
    expect(unit).toContain("Wants=network-online.target seam-local-bridge.service");
    expect(localBridgeUnit).toContain("Requires=seam-sessiond.service");
    expect(localBridgeUnit).toContain("--id local");
    expect(localBridgeUnit).toContain("--token-file ${DATA_DIR}/local-bridge/token");
    expect(localBridgeUnit).not.toContain("--token ${");
    expect(sessiondUnit).toContain("packages/bridge/dist/sessiond.js");
    expect(localBridgeUnit).not.toContain("PartOf=seam-acp.service");
    expect(sessiondUnit).not.toContain("PartOf=seam-local-bridge.service");
  });
});
