import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../src/platforms/discord/orchestrator.js";
import { SessionStore } from "../src/core/session-store.js";
import type { Logger } from "../src/lib/logger.js";
import type { SessionRecord } from "../src/core/types.js";

/**
 * APPLY gate (#71). orchestrator.proposeConfig must pass SEAM_CONFIG_ADMIN_USER_IDS
 * to the confirm card as authorizedUserIds when configured, so only config admins
 * can click Apply — in locked AND unlocked channels. Unset ⇒ pass nothing, so the
 * adapter falls back to DISCORD_ALLOWED_USER_IDS (byte-identical to today).
 */

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-1",
  platform: "discord",
  channelRef: "thread-1",
  parentRef: "channel-1",
  agentId: "claude",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: new Date().toISOString(),
  updatedUtc: new Date().toISOString(),
  ...over,
});

function makeOrch(adminIds: ReadonlySet<string> | undefined) {
  // Capture the opts postConfirmation is called with; keep the decision pending
  // so the background apply() never runs during the test.
  const calls: Array<{ authorizedUserIds?: ReadonlySet<string> } | undefined> = [];
  const adapter = {
    postConfirmation: async (
      _channel: unknown,
      _card: unknown,
      opts?: { authorizedUserIds?: ReadonlySet<string> }
    ) => {
      calls.push(opts);
      return { decision: new Promise<never>(() => {}) };
    },
  };
  const router = { listProfiles: () => [], describeConfig: () => ({}) };
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      DEFAULT_MODEL: "claude-opus-4.8",
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      SEAM_CONFIG_ADMIN_USER_IDS: adminIds,
      channelPresets: new Map(),
      threadPresets: new Map(),
    } as any,
    adapter: adapter as any,
    router: router as any,
    store,
    renderer: {} as any,
  });
  // Bypass the (heavy) real proposal builder — the APPLY gate is orthogonal to
  // which tier was proposed. A canned ok proposal is enough to reach the card.
  (orch as any).configMutation.buildProposal = () => ({
    ok: true,
    proposal: {
      id: "prop-1",
      tier: "session",
      scope: "thread-1",
      title: "Session config for this thread",
      fields: [{ label: "model", before: "gpt-5.4", after: "claude-opus-4.8" }],
      warnings: [],
      restartsSession: true,
      apply: () => ({ ok: true, message: "applied", auditId: "a1" }),
    },
  });
  return { orch, calls };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-apply-gate-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("config apply gate (#71)", () => {
  it("passes the admin set as authorizedUserIds when configured", async () => {
    const admins = new Set(["1487094572696867019"]);
    const { orch, calls } = makeOrch(admins);
    const out = await orch.proposeConfig(record(), { session: { model: "claude-opus-4.8" } });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorizedUserIds).toBe(admins);
  });

  it("passes NO authorizedUserIds when the admin set is unset (falls back to DISCORD_ALLOWED_USER_IDS)", async () => {
    const { orch, calls } = makeOrch(undefined);
    const out = await orch.proposeConfig(record(), { session: { model: "claude-opus-4.8" } });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorizedUserIds).toBeUndefined();
  });
});

/**
 * PROPOSE gate — the HUMAN `/seam` slash surface (#71 admin-immunity extends
 * here too, not only the agent-facing config_propose tool). `isLockedSlashRefused`
 * is the pure predicate `handleSlashInteraction` gates on: a config admin may run
 * config subcommands in a locked channel; everyone else is still refused.
 */
describe("locked-channel slash gate admin-immunity (#71)", () => {
  const ADMIN = "1487094572696867019";
  const cfg = (adminIds: ReadonlySet<string> | undefined, locked: boolean) =>
    ({
      channelPresets: new Map(locked ? [["channel-1", { locked: true }]] : []),
      threadPresets: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: adminIds,
    }) as any;

  it("refuses a non-admin config subcommand in a locked channel", () => {
    expect(
      Orchestrator.isLockedSlashRefused(cfg(new Set([ADMIN]), true), "channel-1", "preset", "student-9")
    ).toBe(true);
  });

  it("allows an admin the same subcommand WITHOUT unlocking", () => {
    expect(
      Orchestrator.isLockedSlashRefused(cfg(new Set([ADMIN]), true), "channel-1", "preset", ADMIN)
    ).toBe(false);
  });

  it("allows a lock-exempt subcommand (steer) for anyone", () => {
    expect(
      Orchestrator.isLockedSlashRefused(cfg(new Set([ADMIN]), true), "channel-1", "steer", "student-9")
    ).toBe(false);
  });

  it("never refuses in an unlocked channel", () => {
    expect(
      Orchestrator.isLockedSlashRefused(cfg(new Set([ADMIN]), false), "channel-1", "preset", "student-9")
    ).toBe(false);
  });

  it("with the admin set unset, a locked channel still refuses everyone (byte-identical to today)", () => {
    expect(
      Orchestrator.isLockedSlashRefused(cfg(undefined, true), "channel-1", "preset", ADMIN)
    ).toBe(true);
  });
});
