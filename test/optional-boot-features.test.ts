import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configDisabledFeatures, loadBootChannelPresets, loadConfig, threadTtsDisabledReason,
} from "../packages/core/src/config.js";
import { reloadChannelPresets } from "../packages/core/src/core/config-reload.js";
import { startHealthServer } from "../packages/core/src/lib/health.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { createCardVisualsPlugin } from "../packages/core/src/plugins/card-visuals/index.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

const env = { DISCORD_BOT_TOKEN: "fixture", DISCORD_ALLOWED_USER_IDS: "123", REPOS_ROOT: os.tmpdir() };
const silent = pino({ level: "silent" });
const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("optional feature validation at boot", () => {
  it.each([
    ["SIMPLE_CARD_GIF_MANIFEST_URL", "not-a-url", "card-gifs", undefined],
    ["BRAND_ICON_BASE_URL", "not-a-url", "brand-icons", undefined],
    ["DISCORD_STATUS_THREAD_ID", "not-an-id", "server-status-card", undefined],
    ["CODEX_ENABLED", "maybe", "codex", false],
    ["SEAM_GEMINI_TTS_VOICE", "", "tts-default-voice", ""],
    ["SEAM_TEST_DRIVER_URL", "not-a-url", "test-driver", undefined],
  ] as const)("isolates %s and retains its exact cause, without a replacement default", (key, value, feature, disabled) => {
    const warnings: string[] = [];
    const input: Readonly<Record<string, string>> = Object.freeze({ ...env, [key]: value });
    const config = loadConfig({ env: input, warn: (message) => warnings.push(message) });
    expect(config[key]).toBe(disabled);
    expect(config.DISCORD_BOT_TOKEN).toBe(env.DISCORD_BOT_TOKEN);
    expect(config.CLAUDE_DEFAULT_MODEL).toBe("default");
    expect(configDisabledFeatures(config)).toEqual([{ feature, cause: expect.stringContaining(key) }]);
    const cause = configDisabledFeatures(config)[0]!.cause;
    expect(warnings).toEqual([`${feature} disabled: ${cause}`]);
    expect(input[key]).toBe(value);
  });

  it.each(["CLAUDE_PROFILES", "COPILOT_PROFILES"] as const)("drops only the bad %s entry", (key) => {
    const warnings: string[] = [];
    const config = loadConfig({ env: { ...env, [key]: "one:/tmp/one,broken,two:/tmp/two" }, warn: (message) => warnings.push(message) });
    expect(config[key]).toEqual([{ id: "one", configDir: "/tmp/one" }, { id: "two", configDir: "/tmp/two" }]);
    const cause = `${key} entry must be 'id:/abs/path' (got 'broken')`;
    expect(configDisabledFeatures(config)).toEqual([{ feature: `${key}[2]`, cause }]);
    expect(warnings).toEqual([`${key}[2] disabled: ${cause}`]);
  });

  it("keeps all valid and omitted settings unchanged", () => {
    const config = loadConfig({ env: { ...env, CODEX_ENABLED: "true", BRAND_ICON_BASE_URL: "https://icons.example/",
      SIMPLE_CARD_GIF_MANIFEST_URL: "https://gifs.example/manifest.json", DISCORD_STATUS_THREAD_ID: "456",
      SEAM_TEST_DRIVER_URL: "https://test.example/", SEAM_GEMINI_TTS_VOICE: "Aoede" } });
    expect(configDisabledFeatures(config)).toEqual([]);
    expect(config.CODEX_ENABLED).toBe(true);
    expect(config.BRAND_ICON_BASE_URL).toBe("https://icons.example/");
    expect(config.SEAM_GEMINI_TTS_VOICE).toBe("Aoede");
    const defaults = loadConfig({ env });
    expect(defaults.SIMPLE_CARD_GIF_MANIFEST_URL).toMatch(/^https:/);
    expect(defaults.BRAND_ICON_BASE_URL).toMatch(/^https:/);
    expect(defaults.SEAM_GEMINI_TTS_VOICE).toBe("Kore");
  });

  it.each([
    ["DISCORD_BOT_TOKEN", ""], ["DISCORD_ALLOWED_USER_IDS", "not-an-id"], ["REPOS_ROOT", "/missing/seam614-repos"],
    ["DISCORD_ALLOWED_CHANNEL_IDS", "not-an-id"], ["SEAM_CONFIG_ADMIN_USER_IDS", "not-an-id"],
    ["SEAM_PARTICIPANT_USER_IDS", "not-an-id"], ["DEFAULT_PERMISSION_POLICY", "not-a-policy"],
  ])("keeps required and access-policy %s fatal alongside an optional failure", (key, value) => {
    expect(() => loadConfig({ env: { ...env, SIMPLE_CARD_GIF_MANIFEST_URL: "broken", [key]: value }, warn: () => {} })).toThrow(key);
  });

  it("disables only the env TTS voice, not an explicit thread voice", () => {
    const config = loadConfig({ env: { ...env, SEAM_GEMINI_TTS_VOICE: "" }, warn: () => {} });
    expect(threadTtsDisabledReason(config, "123")).toContain("SEAM_GEMINI_TTS_VOICE");
    config.threadPresets.set("456", { tts: true, ttsVoice: "Aoede" });
    expect(threadTtsDisabledReason(config, "456")).toBeUndefined();
    expect(config.SEAM_GEMINI_TTS_VOICE).toBe("");
  });

  it("does not synthesize an enabled thread reply with the bad env voice", async () => {
    const config = loadConfig({ env: { ...env, SEAM_GEMINI_API_KEY: "fixture", SEAM_GEMINI_TTS_VOICE: "" }, warn: () => {} });
    config.threadPresets.set("123", { tts: true });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const warn = vi.fn();
    const sendFile = vi.fn();
    const host = { config, logger: { warn }, adapter: { sendFile } };
    const speak = (Orchestrator.prototype as unknown as { maybeSpeakTurn(opts: unknown): Promise<void> }).maybeSpeakTurn;
    await speak.call(host, { channel: { platform: "discord", id: "123" }, threadId: "123", prose: "An unaffected text reply.", alreadyHadAudio: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(sendFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ cause: threadTtsDisabledReason(config, "123"), threadId: "123" }, "outbound TTS disabled");
  });

  it.each(["missing", "bad-json", "bad-root"])("isolates a %s preset file without rewriting it", (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam614-boot-")); roots.push(root);
    const file = path.join(root, "presets.json");
    const raw = mode === "bad-json" ? "{ broken" : "null";
    if (mode !== "missing") fs.writeFileSync(file, raw);
    const warnings: string[] = [];
    const config = loadConfig({ env: { ...env, CHANNEL_PRESETS_FILE: file }, warn: (message) => warnings.push(message) });
    expect(config.channelPresets.size).toBe(0);
    expect(config.threadPresets.size).toBe(0);
    expect(config.bridgePresets.size).toBe(0);
    expect(config.CHANNEL_PRESETS_FILE).toBe(file);
    expect(configDisabledFeatures(config)).toEqual([{ feature: "channel-presets", cause: config.presetsDisabledReason }]);
    expect(warnings).toEqual([`channel-presets disabled: ${config.presetsDisabledReason}`]);
    if (mode === "missing") expect(fs.existsSync(file)).toBe(false);
    else expect(fs.readFileSync(file, "utf8")).toBe(raw);
    // The automatic DATA_DIR file uses the same boot-only reader.
    expect(loadBootChannelPresets(file, () => {}).presetsDisabledReason).toBe(config.presetsDisabledReason);
    fs.writeFileSync(file, JSON.stringify({ channels: { "123": { locked: true } } }));
    const originalMap = config.channelPresets;
    expect(reloadChannelPresets(config, file, silent).ok).toBe(true);
    expect(config.channelPresets).toBe(originalMap);
    expect(config.channelPresets.get("123")?.locked).toBe(true);
    expect(configDisabledFeatures(config)).toEqual([]);
    fs.writeFileSync(file, raw);
    expect(reloadChannelPresets(config, file, silent).ok).toBe(false);
    expect(config.channelPresets.get("123")?.locked).toBe(true);
    expect(configDisabledFeatures(config)).toEqual([]);
  });

  it.each(["gif", "brand"])("keeps the other card visuals working when %s config is invalid", async (bad) => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ gifs: ["https://gifs.example/proof.gif"] }) }));
    vi.stubGlobal("fetch", fetch);
    const config = loadConfig({ env: { ...env, SIMPLE_CARD_GIF_MANIFEST_URL: bad === "gif" ? "broken" : "https://gifs.example/manifest.json",
      BRAND_ICON_BASE_URL: bad === "brand" ? "broken" : "https://icons.example/" }, warn: () => {} });
    const host = new PluginHost(silent);
    cleanup.push(() => host.dispose());
    await host.loadBuiltins([{ id: "card-visuals", load: async () => createCardVisualsPlugin({ read: () => undefined, write: () => ({ ok: true }) }) }], { "card-visuals": config });
    await host.jobs.startAfterAdmission(Promise.resolve());
    await host.jobs.drain();
    const decoration = host.statusCards.decorate({ state: "Working", agentId: "codex", model: "test", style: "simple", gifOn: true });
    expect(decoration.style).toBe("simple");
    if (bad === "gif") {
      expect(decoration.icon).toBe("https://icons.example/codex.webp");
      expect(decoration.thumbnail).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    } else {
      expect(decoration.icon).toBeUndefined();
      expect(decoration.thumbnail).toBe("https://gifs.example/proof.gif");
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it("exposes actual disabled causes on /health, including late AGY/default reasons", async () => {
    const config = loadConfig({ env: { ...env, SIMPLE_CARD_GIF_MANIFEST_URL: "broken", DEFAULT_AGENT: "opencode" }, warn: () => {} });
    const health = startHealthServer(0, silent, { disabledFeatures: () => configDisabledFeatures(config) });
    cleanup.push(() => new Promise<void>((resolve, reject) => health.close((error) => error ? reject(error) : resolve())));
    await once(health, "listening");
    const address = health.address();
    if (!address || typeof address === "string") throw new Error("health did not bind a port");
    config.agyDisabledReason = "AGY executable could not be read";
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", disabledFeatures: [
      { feature: "card-gifs", cause: "SIMPLE_CARD_GIF_MANIFEST_URL: Invalid url" },
      { feature: "agy", cause: config.agyDisabledReason },
      { feature: "default-agent", cause: config.defaultAgentDisabledReason },
    ] });
    config.agyDisabledReason = undefined;
    expect((await (await fetch(`http://127.0.0.1:${address.port}/health`)).json()).disabledFeatures).toHaveLength(2);
  });
});
