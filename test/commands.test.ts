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
});
