import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { buildChannelPresetMaps, PresetsFileSchema } from "../packages/core/src/config.js";
import { reloadChannelPresets } from "../packages/core/src/core/config-reload.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { handleBridgeSlash } from "../packages/core/src/platforms/discord/bridge.js";

describe("durable host quota opt-in", () => {
  it("the boot and hot reload path preserve separate tracking in the existing preset document", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-tracking-"));
    const file = path.join(dir, "presets.json"), input = { quotaTracking: { "codex@worker": "separate" } };
    try {
      fs.writeFileSync(file, JSON.stringify(input));
      expect(PresetsFileSchema.parse(input)).toMatchObject(input);
      const live = buildChannelPresetMaps(file) as ReturnType<typeof buildChannelPresetMaps> & { quotaTracking: Map<string, string> };
      expect(live.quotaTracking?.get("codex@worker")).toBe("separate");
      fs.writeFileSync(file, JSON.stringify({ quotaTracking: {} }));
      expect(reloadChannelPresets(live, file, pino({ level: "silent" }) as never).ok).toBe(true);
      expect(live.quotaTracking?.size).toBe(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("the real admin surface persists, reloads and audits the setting without changing session config", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-tracking-admin-"));
    const store = new SessionStore(path.join(dir, "seam.db")), file = path.join(dir, "presets.json"), logger = pino({ level: "silent" });
    fs.writeFileSync(file, JSON.stringify({ bridges: { worker: { tokenHash: "a".repeat(64) } } }));
    const live = buildChannelPresetMaps(file), refresh = vi.fn(async () => {}), replies: unknown[] = [];
    const mutation = new ConfigMutationService({ store, presetsFile: file, tierCEnabled: true, logger,
      describeConfig: () => { throw new Error("session configuration must not be involved"); }, modelCatalog: {} as never,
      reloadPresets: () => reloadChannelPresets(live, file, logger as never), reschedule: () => {}, defaultTimezone: "UTC" } as never);
    const run = async (tracking: string) => handleBridgeSlash({ options: { getSubcommand: () => "quota", getString: (key: string) => ({ name: "worker", agent: "codex", tracking })[key as "name" | "agent" | "tracking"] ?? null },
      user: { id: "operator", username: "Operator" }, replied: false, deferred: false, reply: async (value: unknown) => { replies.push(value); } } as never,
      { config: live, mutation, hub: { get: () => ({ capabilities: { accountUsage: true } }) }, logger, publicWsUrl: "", refreshQuotaBindings: refresh } as never);
    try {
      await run("separate");
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ quotaTracking: { "codex@worker": "separate" } });
      expect((live as typeof live & { quotaTracking: Map<string, string> }).quotaTracking?.get("codex@worker")).toBe("separate");
      expect(refresh).toHaveBeenCalledOnce();
      expect(store.listConfigMutations().filter(entry => entry.scope === "quota:codex@worker")).toHaveLength(1);
      await run("global");
      expect(JSON.parse(fs.readFileSync(file, "utf8")).quotaTracking).not.toHaveProperty("codex@worker");
    } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
