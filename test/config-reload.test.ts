import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { buildChannelPresetMaps } from "../packages/core/src/config.js";
import { reloadChannelPresets, type PresetMaps } from "../packages/core/src/core/config-reload.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

function writePresets(file: string, obj: unknown): void {
  fs.writeFileSync(file, JSON.stringify(obj), "utf8");
}

describe("channel-presets hot-reload (#58 P0)", () => {
  let dir: string;
  let file: string;
  let live: PresetMaps;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-presets-"));
    file = path.join(dir, "channel-presets.json");
    writePresets(file, {
      channels: { "111": { model: { value: "claude-sonnet-4.5" }, locked: true } },
      threads: { "222": { agent: { value: "claude" } } },
    });
    // Seed the live maps the way loadConfig would — these are the SAME objects
    // the router/orchestrator would hold, so an in-place swap reaches them.
    live = buildChannelPresetMaps(file);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads the initial file into the live maps", () => {
    expect(live.channelPresets.get("111")?.model?.value).toBe("claude-sonnet-4.5");
    expect(live.channelPresets.get("111")?.locked).toBe(true);
    expect(live.threadPresets.get("222")?.agent?.value).toBe("claude");
  });

  it("a valid edit is applied on reload, mutating the SAME map objects", () => {
    const chanRef = live.channelPresets;
    const threadRef = live.threadPresets;

    writePresets(file, {
      channels: { "111": { model: { value: "claude-opus-4.6" }, locked: false } },
      threads: { "333": { cwd: { value: "/tmp/new-thread" } } },
    });
    const res = reloadChannelPresets(live, file, silent);

    expect(res.ok).toBe(true);
    // Same Map identities — the swap is in place, so every holder sees it.
    expect(live.channelPresets).toBe(chanRef);
    expect(live.threadPresets).toBe(threadRef);
    // New values applied.
    expect(live.channelPresets.get("111")?.model?.value).toBe("claude-opus-4.6");
    expect(live.channelPresets.get("111")?.locked).toBe(false);
    // Removed thread key is gone; added key present (cwd resolved to absolute).
    expect(live.threadPresets.has("222")).toBe(false);
    expect(live.threadPresets.get("333")?.cwd?.value).toBe(path.resolve("/tmp/new-thread"));
  });

  it("a schema-invalid edit is rejected and the previous good config is kept", () => {
    // Non-numeric channel key violates PresetsFileSchema.
    writePresets(file, { channels: { "not-a-number": { locked: true } } });
    const res = reloadChannelPresets(live, file, silent);

    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    // Untouched: the previously-loaded good config still serves.
    expect(live.channelPresets.get("111")?.model?.value).toBe("claude-sonnet-4.5");
    expect(live.channelPresets.get("111")?.locked).toBe(true);
    expect(live.threadPresets.get("222")?.agent?.value).toBe("claude");
  });

  it("a syntactically invalid (non-JSON) edit is rejected and prior config kept", () => {
    fs.writeFileSync(file, "{ this is not json", "utf8");
    const res = reloadChannelPresets(live, file, silent);

    expect(res.ok).toBe(false);
    expect(live.channelPresets.get("111")?.model?.value).toBe("claude-sonnet-4.5");
    expect(live.threadPresets.get("222")?.agent?.value).toBe("claude");
  });

  it("an unreadable (deleted) file is rejected and prior config kept", () => {
    fs.rmSync(file);
    const res = reloadChannelPresets(live, file, silent);

    expect(res.ok).toBe(false);
    expect(live.channelPresets.get("111")?.model?.value).toBe("claude-sonnet-4.5");
  });
});
