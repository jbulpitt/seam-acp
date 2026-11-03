import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isAgentLocationDenied,
  parseAgentLocationDeny,
} from "../packages/core/src/core/location.js";

const MAIN_PRESETS = "/home/operator/Projects/seam-acp/data/channel-presets.json";

/** Measured 2026-09-20: 15 explicit copilot thread presets, 14 on remote-a. */
const FHR_COPILOT_THREADS = [
  "1538909622981627996",
  "1541667810021875843",
  "1544403629841322024",
  "1541579247645102202",
  "1544403627886649374",
  "1544349405317038080",
  "1541664456059129926",
  "1525144372801306665",
  "1496216001203798188",
  "1498394632382451853",
  "1496212130112733375",
  "1516913670267994313",
  "1519304338072145970",
  "1519304621523337427",
] as const;
const LOCAL_COPILOT_THREAD = "1516911271272779776";

describe("#474 prove the outcome against real channel-presets.json", () => {
  const deny = parseAgentLocationDeny("copilot@local");

  it.skipIf(!fs.existsSync(MAIN_PRESETS))(
    "live file: 14 remote-a copilot presets stay allowed; local copilot is denied",
    () => {
    const data = JSON.parse(fs.readFileSync(MAIN_PRESETS, "utf8")) as {
      threads?: Record<string, { agent?: { value?: string }; location?: string }>;
    };
    const threads = data.threads ?? {};
    const explicitCopilot = Object.entries(threads).filter(
      ([, t]) => t.agent?.value === "copilot",
    );
    const fhr = explicitCopilot.filter(([, t]) => t.location === "remote-a");
    const local = explicitCopilot.filter(([, t]) => !t.location || t.location === "local");
    expect(fhr.length, "remote-a copilot presets").toBe(14);
    expect(local.length, "local copilot presets").toBe(1);
    for (const [, t] of fhr) {
      expect(isAgentLocationDenied("copilot", t.location, deny)).toBe(false);
    }
    for (const [, t] of local) {
      expect(isAgentLocationDenied("copilot", t.location ?? "local", deny)).toBe(true);
    }
    expect(explicitCopilot.map(([id]) => id).sort()).toEqual(
      [...FHR_COPILOT_THREADS, LOCAL_COPILOT_THREAD].slice().sort(),
    );
  });
});
