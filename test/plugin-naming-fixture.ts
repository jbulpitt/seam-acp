import { registerPresetCommands } from "./plugin-presets-fixture.js";
import { registerConfigUiCommands } from "./plugin-config-ui-fixture.js";
import { registerScheduleCommands } from "./plugin-schedule-fixture.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { vi } from "vitest";
import type { AgentProfile } from "@seam/adapters";
import type { Config } from "../packages/core/src/config.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { createThreadNamingPlugin } from "../packages/core/src/plugins/thread-naming/index.js";
import { DEFAULT_THREAD_NAMER_CONFIG } from "../packages/core/src/platforms/discord/thread-namer.js";
import { buildSeamCommand, buildSeamAdminCommand, buildSlashRegistrationBody } from "../packages/core/src/platforms/discord/commands.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const logger = pino({ level: "silent" });
export const NAMING_PARENT = "100000000000000001";
export function namingRegistry() {
  const plugin = createThreadNamingPlugin({ threads: {
    describeConfig: () => ({ agent: { value: "codex" }, model: { value: "gpt-6.1-sol" }, role: { value: "worker" }, disableThreadPrefix: { value: false } }),
    listSessionsByParent: () => [], getThreadName: async () => null, getThreadLiveState: async () => undefined,
    renameThread: async () => {}, logger,
  }, internal: { setNamePrefix: () => {}, get: () => undefined, all: () => [], rules: { get: () => DEFAULT_THREAD_NAMER_CONFIG, save: next => next } } });
  const host = new PluginHost(logger);
  host.slash.register(plugin.id, plugin.contributions.slash!, { logger, config: undefined });
  registerScheduleCommands(host);
  registerConfigUiCommands(host);
  registerPresetCommands(host);
  return host.slash;
}
export function namingCommands() { return buildSlashRegistrationBody(namingRegistry()); }

export async function namingFixture(options: { admins?: Set<string>; locked?: boolean; participant?: string; directory?: string; store?: SessionStore } = {}) {
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "seam-naming-"));
  const store = options.store ?? new SessionStore(path.join(directory, "seam.db"));
  const profiles = ["codex", "claude"].map(id => ({ id, displayName: id, defaultModel: id === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5.5", spawn: () => { throw new Error("unit test never starts an agent"); } } satisfies Partial<AgentProfile>)) as unknown as AgentProfile[];
  const modelCatalog = fixtureModelCatalog(profiles);
  const presetsFile = path.join(directory, "channel-presets.json");
  fs.writeFileSync(presetsFile, JSON.stringify({ channels: { [NAMING_PARENT]: { role: "worker", locked: options.locked ?? false } } }));
  const config = {
    DATA_DIR: directory, REPOS_ROOT: directory, DEFAULT_AGENT: "codex", DEFAULT_MODEL: "gpt-6.1-sol", TURN_TIMEOUT_SECONDS: 60,
    SEAM_CONFIG_ADMIN_USER_IDS: options.admins, SEAM_PARTICIPANT_USER_IDS: options.participant ? new Set([options.participant]) : undefined,
    DISCORD_ALLOWED_USER_IDS: new Set(["admin", "other"]), REPO_EMOJIS: new Map(),
    CHANNEL_PRESETS_FILE: presetsFile,
    channelPresets: new Map([[NAMING_PARENT, { role: { value: "worker" }, locked: options.locked ?? false }]]), threadPresets: new Map(), bridgePresets: new Map(),
  } as Config;
  const router = new SessionRouter({ logger, store, profiles, modelCatalog, defaultAgentId: "codex", defaultModel: "gpt-6.1-sol", channelPresets: config.channelPresets, threadPresets: config.threadPresets });
  const names = new Map<string, string>();
  const events: string[] = [];
  let componentHandler: ((event: never) => Promise<void>) | undefined;
  const renameThread = vi.fn(async (channel: { id: string }, name: string) => { events.push("rename"); names.set(channel.id, name); });
  const host = new PluginHost(logger, { storageRoot: directory, slash: [buildSeamCommand().toJSON(), buildSeamAdminCommand().toJSON()] });
  const adapter = { onMessage: () => {}, onComponent: (handler: typeof componentHandler) => { componentHandler = handler; }, getThreadName: async (channel: { id: string }) => names.get(channel.id) ?? null, getThreadLiveState: async (channel: { id: string }) => names.has(channel.id) ? ({ locked: false, archived: false }) : undefined, renameThread };
  const orchestrator = new Orchestrator({ logger, config, router, store, modelCatalog, plugins: host, adapter: adapter as never, renderer: {} as never });
  await orchestrator.loadPlugins();
  orchestrator.install();
  const create = async (id = "thread") => {
    names.set(id, "my task");
    const record = router.ensureSessionRecord({ platform: "discord", channelRef: id, parentRef: NAMING_PARENT, cwd: directory });
    await orchestrator.flushIdentityEffects(record.id);
    return store.get(record.id)!;
  };
  const slash = async (sub = "rename", values: Record<string, string | boolean> = {}, userId = "admin") => {
    const reply = vi.fn(async () => { events.push("reply"); });
    const deferReply = vi.fn(async () => { events.push("defer"); });
    const editReply = vi.fn(async () => { events.push("edit"); });
    await orchestrator.handleSlashInteraction({ commandName: "seamadmin", channelId: "thread", channel: { isThread: () => true, parentId: NAMING_PARENT },
      user: { id: userId, username: userId, displayName: userId }, options: { getSubcommand: () => sub, getSubcommandGroup: () => "naming", getString: (name: string) => typeof values[name] === "string" ? values[name] : null, getBoolean: (name: string) => typeof values[name] === "boolean" ? values[name] : null }, reply, deferReply, editReply } as never);
    return { reply, deferReply, editReply };
  };
  const close = async () => { await orchestrator.flushIdentityEffects(); await host.dispose(); if (!options.store) store.close(); if (!options.directory) fs.rmSync(directory, { recursive: true, force: true }); };
  return { host, orchestrator, store, router, config, names, renameThread, events, create, slash, close, directory, component: (event: unknown) => componentHandler!(event as never) };
}
