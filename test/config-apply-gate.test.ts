import { describe, it, expect } from "vitest";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

// Durable Apply gates are composed in durable-action-cards.test.ts.

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
    expect(Orchestrator.isParticipantSlashRefused(c, "help", STUDENT, { group: "info" })).toBe(false);
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

/** Detach mutates the thread; only listed admins bypass channel locks. */
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

/** Creating a preset thread retains the same mutation gate as apply/new. */
describe("preset thread slash gates (#93)", () => {
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

  it("restricted participant is refused (unlocked channel)", () => {
    expect(Orchestrator.isParticipantSlashRefused(participants, "thread", STUDENT)).toBe(true);
    expect(Orchestrator.isParticipantSlashRefused(participants, "apply", STUDENT)).toBe(true);
    expect(Orchestrator.isParticipantSlashRefused(participants, "new", STUDENT)).toBe(true);
  });

  it("admin is not participant-refused", () => {
    expect(Orchestrator.isParticipantSlashRefused(participants, "thread", ADMIN)).toBe(false);
  });

  it("admin OK in a locked channel (#71 immunity)", () => {
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "thread", ADMIN)).toBe(
      false
    );
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "apply", ADMIN)).toBe(
      false
    );
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "new", ADMIN)).toBe(false);
  });

  it("non-admin refused in a locked channel", () => {
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "thread", STUDENT)).toBe(
      true
    );
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "new", STUDENT)).toBe(true);
  });
});
