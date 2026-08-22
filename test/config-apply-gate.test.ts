import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

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

function makeOrch(
  adminIds: ReadonlySet<string> | undefined,
  extra?: {
    participantIds?: ReadonlySet<string>;
    allowedIds?: ReadonlySet<string>;
  }
) {
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
      SEAM_PARTICIPANT_USER_IDS: extra?.participantIds,
      DISCORD_ALLOWED_USER_IDS: extra?.allowedIds ?? new Set(["1"]),
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

  it("when admin set is unset, still excludes restricted participants from Apply", async () => {
    const ADMIN = "1487094572696867019";
    const STUDENT = "1534937951044112505";
    const allowed = new Set([ADMIN, STUDENT]);
    const { orch, calls } = makeOrch(undefined, {
      participantIds: new Set([STUDENT]),
      allowedIds: allowed,
    });
    const out = await orch.proposeConfig(record(), { session: { model: "claude-opus-4.8" } });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const passed = calls[0]?.authorizedUserIds;
    expect(passed).toBeDefined();
    expect(passed?.has(STUDENT)).toBe(false);
    expect(passed?.has(ADMIN)).toBe(true);
  });

  it("when admin set is configured, Apply stays admin-only (participants excluded even if overlapping)", async () => {
    const ADMIN = "1487094572696867019";
    const STUDENT = "1534937951044112505";
    const admins = new Set([ADMIN]);
    const { orch, calls } = makeOrch(admins, {
      participantIds: new Set([ADMIN, STUDENT]),
      allowedIds: new Set([ADMIN, STUDENT]),
    });
    const out = await orch.proposeConfig(record(), { session: { model: "claude-opus-4.8" } });
    expect(out.ok).toBe(true);
    expect(calls[0]?.authorizedUserIds).toBe(admins);
    expect(calls[0]?.authorizedUserIds?.has(STUDENT)).toBe(false);
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

  it("allows lock-exempt /seam queue for anyone (#89 D10)", () => {
    expect(
      Orchestrator.isLockedSlashRefused(cfg(new Set([ADMIN]), true), "channel-1", "queue", "student-9")
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

/**
 * PARTICIPANT slash gate (#74). Lives ALONGSIDE `isLockedSlashRefused` — a
 * different question. A restricted participant is refused even in an UNLOCKED
 * channel; help/cancel still work. steer is lock-exempt but NOT
 * participant-allowed. Admin-who-is-also-participant is not refused.
 */
describe("participant slash gate (#74)", () => {
  const ADMIN = "1487094572696867019";
  const STUDENT = "1534937951044112505";
  const OPERATOR = "111";
  const cfg = (participantIds: ReadonlySet<string> | undefined, adminIds?: ReadonlySet<string>) =>
    ({
      SEAM_PARTICIPANT_USER_IDS: participantIds,
      SEAM_CONFIG_ADMIN_USER_IDS: adminIds,
    }) as any;

  it("refuses a participant any config subcommand in an UNLOCKED channel", () => {
    expect(Orchestrator.isParticipantSlashRefused(cfg(new Set([STUDENT])), "model", STUDENT)).toBe(
      true
    );
    expect(Orchestrator.isParticipantSlashRefused(cfg(new Set([STUDENT])), "preset", STUDENT)).toBe(
      true
    );
    expect(Orchestrator.isParticipantSlashRefused(cfg(new Set([STUDENT])), "agent", STUDENT)).toBe(
      true
    );
  });

  it("allows a participant help / cancel / queue (NOT steer)", () => {
    const c = cfg(new Set([STUDENT]));
    expect(Orchestrator.isParticipantSlashRefused(c, "help", STUDENT)).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(c, "cancel", STUDENT)).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(c, "queue", STUDENT)).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(c, "steer", STUDENT)).toBe(true);
  });

  it("does not refuse an operator or an admin", () => {
    const c = cfg(new Set([STUDENT]), new Set([ADMIN]));
    expect(Orchestrator.isParticipantSlashRefused(c, "model", OPERATOR)).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(c, "model", ADMIN)).toBe(false);
  });

  it("an id in BOTH sets resolves to admin (not refused)", () => {
    expect(
      Orchestrator.isParticipantSlashRefused(
        cfg(new Set([ADMIN, STUDENT]), new Set([ADMIN])),
        "model",
        ADMIN
      )
    ).toBe(false);
    expect(
      Orchestrator.isParticipantSlashRefused(
        cfg(new Set([ADMIN, STUDENT]), new Set([ADMIN])),
        "model",
        STUDENT
      )
    ).toBe(true);
  });

  it("with the participant set unset, nobody is refused (byte-identical to today)", () => {
    expect(Orchestrator.isParticipantSlashRefused(cfg(undefined), "model", STUDENT)).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(cfg(undefined, new Set([ADMIN])), "model", STUDENT)).toBe(
      false
    );
  });

  it("steer is lock-exempt but still participant-refused (the two constants must not be reused)", () => {
    const locked = {
      channelPresets: new Map([["channel-1", { locked: true }]]),
      threadPresets: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
      SEAM_PARTICIPANT_USER_IDS: new Set([STUDENT]),
    } as any;
    expect(Orchestrator.isLockedSlashRefused(locked, "channel-1", "steer", STUDENT)).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(locked, "steer", STUDENT)).toBe(true);
  });
});

/**
 * #78: consolidating abort+kill into `cancel` options would silently widen
 * both gates if they keyed only on the bare subcommand name. `cancel scope:all`
 * is the old privileged `kill` and must stay refused for non-admins /
 * participants. Plain `cancel` (and `force:true`) stays allowed (self-unstick).
 */
describe("option-aware cancel gates (#78)", () => {
  const ADMIN = "1487094572696867019";
  const STUDENT = "1534937951044112505";
  const locked = (adminIds: ReadonlySet<string> | undefined) =>
    ({
      channelPresets: new Map([["channel-1", { locked: true }]]),
      threadPresets: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: adminIds,
    }) as any;
  const participants = (participantIds: ReadonlySet<string>, adminIds?: ReadonlySet<string>) =>
    ({
      SEAM_PARTICIPANT_USER_IDS: participantIds,
      SEAM_CONFIG_ADMIN_USER_IDS: adminIds,
    }) as any;

  it("isCancelScopeAll is true only for cancel + scope:all", () => {
    expect(Orchestrator.isCancelScopeAll("cancel", { scope: "all" })).toBe(true);
    expect(Orchestrator.isCancelScopeAll("cancel", { scope: null })).toBe(false);
    expect(Orchestrator.isCancelScopeAll("cancel", undefined)).toBe(false);
    expect(Orchestrator.isCancelScopeAll("steer", { scope: "all" })).toBe(false);
  });

  it("non-admin in a locked channel is refused cancel scope:all but allowed plain cancel", () => {
    const cfg = locked(new Set([ADMIN]));
    expect(Orchestrator.isLockedSlashRefused(cfg, "channel-1", "cancel", STUDENT)).toBe(false);
    expect(
      Orchestrator.isLockedSlashRefused(cfg, "channel-1", "cancel", STUDENT, { scope: null })
    ).toBe(false);
    // force:true is still this-thread (old abort) — stays lock-exempt
    expect(
      Orchestrator.isLockedSlashRefused(cfg, "channel-1", "cancel", STUDENT, { scope: undefined })
    ).toBe(false);
    expect(
      Orchestrator.isLockedSlashRefused(cfg, "channel-1", "cancel", STUDENT, { scope: "all" })
    ).toBe(true);
  });

  it("admin in a locked channel may still run cancel scope:all (admin immunity)", () => {
    const cfg = locked(new Set([ADMIN]));
    expect(
      Orchestrator.isLockedSlashRefused(cfg, "channel-1", "cancel", ADMIN, { scope: "all" })
    ).toBe(false);
  });

  it("participant is refused cancel scope:all but allowed plain cancel (and force:true)", () => {
    const c = participants(new Set([STUDENT]));
    expect(Orchestrator.isParticipantSlashRefused(c, "cancel", STUDENT)).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(c, "cancel", STUDENT, { scope: null })).toBe(
      false
    );
    expect(Orchestrator.isParticipantSlashRefused(c, "cancel", STUDENT, { scope: "all" })).toBe(
      true
    );
    // config leaves stay refused
    expect(Orchestrator.isParticipantSlashRefused(c, "model", STUDENT)).toBe(true);
  });

  it("participant who is also admin is not refused cancel scope:all", () => {
    const c = participants(new Set([ADMIN, STUDENT]), new Set([ADMIN]));
    expect(Orchestrator.isParticipantSlashRefused(c, "cancel", ADMIN, { scope: "all" })).toBe(
      false
    );
    expect(Orchestrator.isParticipantSlashRefused(c, "cancel", STUDENT, { scope: "all" })).toBe(
      true
    );
  });
});

/**
 * #80: `/seam config detach` is a config subcommand. Do NOT add `detach` to
 * LOCK_EXEMPT_SUBCOMMANDS or PARTICIPANT_ALLOWED_SUBCOMMANDS to make these
 * pass — admin immunity is the school-channel lever; kids must not mute
 * homework threads.
 */
describe("detach slash gates (#80)", () => {
  const ADMIN = "1487094572696867019";
  const STUDENT = "1534937951044112505";
  const lockedSchool = {
    channelPresets: new Map([["channel-1", { locked: true }]]),
    threadPresets: new Map(),
    SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    SEAM_PARTICIPANT_USER_IDS: new Set([STUDENT]),
  } as any;
  const participants = {
    SEAM_PARTICIPANT_USER_IDS: new Set([STUDENT]),
    SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
  } as any;

  it("isParticipantSlashRefused('detach', studentId) === true", () => {
    expect(Orchestrator.isParticipantSlashRefused(participants, "detach", STUDENT)).toBe(true);
  });

  it("isLockedSlashRefused(locked school, 'detach', adminId) === false", () => {
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "detach", ADMIN)).toBe(
      false
    );
  });

  it("isLockedSlashRefused(locked school, 'detach', studentId) === true", () => {
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "detach", STUDENT)).toBe(
      true
    );
  });

  it("cmdInit refuses while the thread is detached", () => {
    const detached = {
      threadPresets: new Map([["thread-1", { detached: true }]]),
    } as any;
    expect(Orchestrator.isInitRefusedWhileDetached(detached, "thread-1")).toBe(true);
    expect(Orchestrator.isInitRefusedWhileDetached(detached, "other-thread")).toBe(false);
    expect(Orchestrator.isInitRefusedWhileDetached({ threadPresets: new Map() } as any, "thread-1")).toBe(
      false
    );
    expect(Orchestrator.isInitRefusedWhileDetached(detached, undefined)).toBe(false);
  });
});
