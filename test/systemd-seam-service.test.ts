import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const unitPath = path.resolve("ops/systemd/seam-acp.service");
const unit = readFileSync(unitPath, "utf8");

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
});
