import { describe, it, expect } from "vitest";
import {
  isBridgeAdminRefused,
  isStampedConfigAdmin,
} from "../packages/core/src/platforms/discord/admin-gate.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

const ADMIN = "1487094572696867019";
const STUDENT = "1534937951044112505";
const OPERATOR = "1111111111111111111";

describe("bridge/debug admin gate (#83)", () => {
  it("refuses a participant", () => {
    const cfg = {
      SPEAKER_IDENTITY_ENABLED: true,
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    };
    expect(isBridgeAdminRefused(cfg, STUDENT)).toBe(true);
    expect(isStampedConfigAdmin(cfg, STUDENT).reason).toBe("not-admin");
  });

  it("refuses a non-admin operator", () => {
    const cfg = {
      SPEAKER_IDENTITY_ENABLED: true,
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    };
    expect(isBridgeAdminRefused(cfg, OPERATOR)).toBe(true);
    expect(isStampedConfigAdmin(cfg, OPERATOR).allowed).toBe(false);
  });

  it("allows a stamped admin", () => {
    const cfg = {
      SPEAKER_IDENTITY_ENABLED: true,
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    };
    expect(isBridgeAdminRefused(cfg, ADMIN)).toBe(false);
    expect(isStampedConfigAdmin(cfg, ADMIN).allowed).toBe(true);
    expect(isStampedConfigAdmin(cfg, ADMIN).speakerId).toBe(ADMIN);
  });

  it("fails closed when SPEAKER_IDENTITY_ENABLED is false (even for an admin id)", () => {
    const cfg = {
      SPEAKER_IDENTITY_ENABLED: false,
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    };
    expect(isBridgeAdminRefused(cfg, ADMIN)).toBe(true);
    expect(isStampedConfigAdmin(cfg, ADMIN).reason).toBe("speaker-identity-off");
    expect(isStampedConfigAdmin(cfg, ADMIN).speakerId).toBe(ADMIN);
  });

  it("fails closed when there is no stamped speaker id", () => {
    const cfg = {
      SPEAKER_IDENTITY_ENABLED: true,
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    };
    expect(isBridgeAdminRefused(cfg, undefined)).toBe(true);
    expect(isStampedConfigAdmin(cfg, undefined).reason).toBe("no-stamped-id");
  });

  it("fails closed when the admin set is unset", () => {
    const cfg = {
      SPEAKER_IDENTITY_ENABLED: true,
      SEAM_CONFIG_ADMIN_USER_IDS: undefined,
    };
    expect(isBridgeAdminRefused(cfg, ADMIN)).toBe(true);
    expect(isStampedConfigAdmin(cfg, ADMIN).reason).toBe("not-admin");
  });
});

describe("bridge/debug stay out of lock-exempt and participant-allowed lists", () => {
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

  it("LOCK_EXEMPT_SUBCOMMANDS is cancel/steer/queue", () => {
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "cancel", STUDENT)).toBe(
      false
    );
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "steer", STUDENT)).toBe(
      false
    );
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "queue", STUDENT)).toBe(
      false
    );
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "add", STUDENT)).toBe(true);
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "exec", STUDENT)).toBe(true);
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "rotate", STUDENT)).toBe(
      true
    );
  });

  it("admin is immune in a locked channel (same posture as detach/upload)", () => {
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "add", ADMIN)).toBe(false);
    expect(Orchestrator.isLockedSlashRefused(lockedSchool, "channel-1", "exec", ADMIN)).toBe(false);
  });

  it("PARTICIPANT_ALLOWED_SUBCOMMANDS is help/cancel/queue", () => {
    expect(Orchestrator.isParticipantSlashRefused(participants, "help", STUDENT)).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(participants, "cancel", STUDENT)).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(participants, "queue", STUDENT)).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(participants, "add", STUDENT)).toBe(true);
    expect(Orchestrator.isParticipantSlashRefused(participants, "exec", STUDENT)).toBe(true);
    expect(Orchestrator.isParticipantSlashRefused(participants, "steer", STUDENT)).toBe(true);
  });
});
