import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { PresetUi, createPresetPlugin } from "../packages/core/src/plugins/presets/index.js";
import { PresetRepository } from "../packages/core/src/plugins/presets/repository.js";
import type { Preset } from "../packages/core/src/core/types.js";

const logger = pino({ level: "silent" });
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("preset plugin storage compatibility", () => {
  it("keeps existing rows and lets plugin and kernel callers see each other's changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-presets-plugin-")); directories.push(dir);
    const file = path.join(dir, "seam.db");
    const store = new SessionStore(file);
    const row: Preset = {
      id: "pre_existing", name: "reviewer", projectRef: "project", description: "existing data", agentId: "claude", model: "model",
      effort: "low", repoPath: "/repo", role: "qa", disableThreadPrefix: true, permission: "always", toolsAllow: ["Read"], toolsExclude: ["Write"],
      instructions: "Original opening prompt.", statusCardStyle: "simple", createdBy: "owner", createdUtc: "2026-09-01T00:00:00Z", updatedUtc: "2026-09-02T00:00:00Z",
    };
    store.upsertPreset(row);
    const db = new Database(file);
    const before = db.prepare("SELECT * FROM presets ORDER BY id").all();
    const host = new PluginHost(logger, { storageRoot: dir, storageAliases: { presets: { "presets.sqlite": file } } });
    const ui = new PresetUi({ repository: store.presets } as never);
    await host.loadBuiltins([{ id: "presets", load: async () => createPresetPlugin(ui) }]);
    expect(db.prepare("SELECT * FROM presets ORDER BY id").all()).toEqual(before);
    expect(ui.repository.getPresetByNameScoped("REVIEWER", "project")).toEqual(row);
    ui.repository.upsertPreset({ ...row, effort: "high" });
    expect(store.getPreset(row.id)?.effort).toBe("high");
    expect(store.getPreset(row.id)?.createdUtc).toBe(row.createdUtc);
    expect(fs.existsSync(path.join(dir, "plugins", "presets", "presets.sqlite"))).toBe(false);
    await host.dispose();
    expect(store.getPreset(row.id)?.instructions).toBe(row.instructions);
    store.presets.deletePreset(row.id);
    expect(store.getPresetByNameScoped("reviewer", "project")).toBeNull();
    db.close(); store.close();
  });

  it("retains legacy global presets when the plugin repository owns their schema upgrades", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE presets (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, agent_id TEXT,
      model TEXT, effort TEXT, repo_path TEXT, permission TEXT, tools_json TEXT, instructions TEXT,
      created_by TEXT NOT NULL, created_utc TEXT NOT NULL, updated_utc TEXT NOT NULL);
      INSERT INTO presets VALUES ('legacy', 'global', 'old description', 'claude', 'old-model', 'low', '/old/repo',
      'ask', '{"allow":["Read"],"exclude":["Write"]}', 'Old identity.', 'owner', 'created', 'updated');`);
    const repository = new PresetRepository(db);
    const old = repository.getPresetByNameScoped("GLOBAL", "project")!;
    expect(old).toMatchObject({ id: "legacy", projectRef: null, description: "old description", model: "old-model", repoPath: "/old/repo",
      toolsAllow: ["Read"], toolsExclude: ["Write"], instructions: "Old identity.", createdUtc: "created", updatedUtc: "updated" });
    repository.upsertPreset({ ...old, id: "project", projectRef: "project", model: "project-model" });
    expect(repository.getPresetByNameScoped("global", "project")?.model).toBe("project-model");
    expect(repository.getPresetByNameScoped("global", "other")?.model).toBe("old-model");
    db.close();
  });
});
