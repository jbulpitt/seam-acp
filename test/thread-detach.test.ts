import { describe, it, expect } from "vitest";
import { isThreadDetached, PresetsFileSchema } from "../src/config.js";
import type { ThreadPreset } from "../src/config.js";

describe("isThreadDetached (#80)", () => {
  it("returns false when threadId is missing", () => {
    expect(isThreadDetached({ threadPresets: new Map() }, undefined)).toBe(false);
  });

  it("returns false when the thread has no preset entry", () => {
    expect(isThreadDetached({ threadPresets: new Map() }, "111")).toBe(false);
  });

  it("returns false when detached is absent or false", () => {
    const absent = new Map<string, ThreadPreset>([["111", { rider: { value: "x" } }]]);
    const explicitFalse = new Map<string, ThreadPreset>([["111", { detached: false }]]);
    expect(isThreadDetached({ threadPresets: absent }, "111")).toBe(false);
    expect(isThreadDetached({ threadPresets: explicitFalse }, "111")).toBe(false);
  });

  it("returns true when the thread preset has detached: true", () => {
    const presets = new Map<string, ThreadPreset>([["111", { detached: true }]]);
    expect(isThreadDetached({ threadPresets: presets }, "111")).toBe(true);
  });
});

describe("PresetsFileSchema detached (#80)", () => {
  it("accepts a thread entry with only {detached:true}", () => {
    const parsed = PresetsFileSchema.safeParse({
      threads: { "111111111111111111": { detached: true } },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.threads["111111111111111111"].detached).toBe(true);
  });

  it("still validates a file with no detached keys (default false)", () => {
    const parsed = PresetsFileSchema.safeParse({
      channels: { "111111111111111111": { locked: true } },
      threads: { "222222222222222222": { rider: { value: "homework" } } },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.threads["222222222222222222"].detached).toBe(false);
  });

  it("rejects a CHANNEL entry with detached (must not silently mute a school channel)", () => {
    const parsed = PresetsFileSchema.safeParse({
      channels: { "111111111111111111": { locked: true, detached: true } },
    });
    expect(parsed.success).toBe(false);
  });
});
