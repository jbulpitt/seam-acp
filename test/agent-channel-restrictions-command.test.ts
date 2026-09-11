import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { MessageFlags } from "discord.js";
import type { AgentProfile } from "@seam/adapters";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const ADMIN = "1487094572696867019";
const CHANNEL = "111111111111111111";
const silent = pino({ level: "silent" }) as unknown as Logger;
let dir: string;
let store: SessionStore;

const copilot = {
  id: "copilot",
  displayName: "Copilot",
  defaultModel: "gpt-5.4",
  staticModels: [{ modelId: "gpt-5.4", name: "GPT-5.4" }],
  effort: { mechanism: "none", levels: [] },
} as unknown as AgentProfile;

function orch(adminIds = new Set([ADMIN])) {
  const router = new SessionRouter({
    logger: silent,
    store,
    profiles: [copilot],
    modelCatalog: fixtureModelCatalog([copilot]),
    defaultAgentId: "copilot",
    defaultModel: "gpt-5.4",
  });
  return new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_AGENT: "copilot",
      DEFAULT_MODEL: "gpt-5.4",
      CHANNEL_PRESETS_FILE: undefined,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      channelPresets: new Map(),
      threadPresets: new Map(),
      bridgePresets: new Map(),
      REPO_EMOJIS: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: adminIds,
    } as any,
    adapter: {} as any,
    router,
    store,
    renderer: {} as any,
    modelCatalog: fixtureModelCatalog([copilot]),
  });
}

function interaction(sub: "set" | "list" | "clear", values: Record<string, string> = {}, userId = ADMIN) {
  const replies: Array<{ content?: string; flags?: number }> = [];
  return {
    replies,
    value: {
      options: {
        getSubcommand: () => sub,
        getString: (name: string) => values[name] ?? null,
      },
      user: { id: userId, username: "Jesse" },
      reply: async (payload: { content?: string; flags?: number }) => { replies.push(payload); },
    },
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agent-restriction-command-"));
  store = new SessionStore(path.join(dir, "seam.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("/seamadmin restrictions (#308)", () => {
  it("sets, lists, and clears a rule immediately through the stamped config-admin surface", async () => {
    const subject = orch();
    const set = interaction("set", { agent: "copilot", channels: `<#${CHANNEL}>, ${CHANNEL}` });
    await (subject as any).cmdAgentChannelRestrictions(set.value);
    expect(set.replies[0]).toMatchObject({ flags: MessageFlags.Ephemeral });
    expect(set.replies[0]?.content).toContain("copilot");
    expect(store.getAgentChannelRestriction("copilot")).toEqual({
      agentId: "copilot",
      allowedChannelIds: [CHANNEL],
    });

    const list = interaction("list");
    await (subject as any).cmdAgentChannelRestrictions(list.value);
    expect(list.replies[0]?.content).toContain(`<#${CHANNEL}>`);

    const clear = interaction("clear", { agent: "copilot" });
    await (subject as any).cmdAgentChannelRestrictions(clear.value);
    expect(clear.replies[0]?.content).toContain("Cleared");
    expect(store.getAgentChannelRestriction("copilot")).toBeNull();
    expect(store.listConfigMutations(2).every((entry) => entry.tier === "agent-channel-restriction")).toBe(true);
  });

  it("refuses an unstamped speaker before it can mutate a rule", async () => {
    const subject = orch(new Set([ADMIN]));
    const denied = interaction("set", { agent: "copilot", channels: CHANNEL }, "not-allowlisted");
    await (subject as any).cmdAgentChannelRestrictions(denied.value);
    expect(denied.replies[0]).toEqual({
      content: "🔒 `/seamadmin restrictions` is config-admin-only.",
      flags: MessageFlags.Ephemeral,
    });
    expect(store.getAgentChannelRestriction("copilot")).toBeNull();
  });
});
