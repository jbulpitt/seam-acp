import { describe, it, expect } from "vitest";
import { buildSeamCommand } from "../src/platforms/discord/commands.js";

// Regression guard: the whole feature build-out (workflows/steer/project/…) once
// pushed /seam to 28 top-level options and Discord's 25-cap made the bot crash
// at boot (registerSlashCommands -> validateMaxOptionsLength). tsc + unit tests
// were all green because nothing exercised the real command builder. This does.
describe("/seam slash command", () => {
  it("builds without throwing — this is exactly what registration does at boot", () => {
    expect(() => buildSeamCommand().toJSON()).not.toThrow();
  });

  it("stays within Discord's 25 top-level-option cap", () => {
    const json = buildSeamCommand().toJSON();
    expect(json.options?.length ?? 0).toBeLessThanOrEqual(25);
  });

  // #63: the human-inbox two-tier lives as an OPTION on the existing `steer`
  // subcommand (options are free — they don't count toward the 25), so adding it
  // must NOT introduce a new top-level command and must leave the cap green.
  it("adds `now` as an option on `steer` — not a new top-level command", () => {
    const json = buildSeamCommand().toJSON();
    const steer = json.options?.find((o) => o.name === "steer") as
      | { options?: Array<{ name: string; type: number; required?: boolean }> }
      | undefined;
    expect(steer).toBeTruthy();
    const now = steer?.options?.find((o) => o.name === "now");
    expect(now).toBeTruthy();
    // Boolean option type is 5; optional so the default (cooperative) path holds.
    expect(now?.type).toBe(5);
    expect(now?.required ?? false).toBe(false);
  });
});
