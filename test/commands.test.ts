import { describe, it, expect } from "vitest";
import { PermissionFlagsBits, InteractionContextType } from "discord.js";
import {
  SEAM_ADMIN_COMMAND_NAME,
  SEAM_COMMAND_NAME,
  buildSeamAdminCommand,
  buildSeamCommand,
  buildSlashRegistrationBody,
} from "../packages/core/src/platforms/discord/commands.js";

// Discord ApplicationCommandOptionType
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;
const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;

type Opt = {
  name: string;
  type: number;
  description?: string;
  required?: boolean;
  autocomplete?: boolean;
  options?: Opt[];
  choices?: { name: string; value: string }[];
};

type Built = {
  name?: string;
  options?: Opt[];
  default_member_permissions?: string | null;
  contexts?: number[] | null;
  dm_permission?: boolean;
};

const seam = (): Built => buildSeamCommand().toJSON() as Built;
const admin = (): Built => buildSeamAdminCommand().toJSON() as Built;

const slot = (cmd: Built, name: string): Opt | undefined =>
  cmd.options?.find((o) => o.name === name);
const leafNames = (cmd: Built, group: string): string[] =>
  (slot(cmd, group)?.options ?? []).map((o) => o.name);

/**
 * Discord counts a command's size as the sum of EVERY string in the payload —
 * names, descriptions, and choice values across the whole tree. This mirrors
 * that, because the failure is not graceful: over 8,000 and Discord rejects
 * registration of the entire command at boot.
 */
function commandStringSize(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + commandStringSize(item), 0);
  if (value && typeof value === "object") {
    return Object.values(value).reduce<number>((sum, item) => sum + commandStringSize(item), 0);
  }
  return 0;
}

/** Every leaf must list required options before optional ones, or Discord
 *  rejects the whole PUT with APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID. */
function requiredOrderFailures(cmd: Built, label: string): string[] {
  const failures: string[] = [];
  const walk = (opts: Opt[] | undefined, path: string): void => {
    if (!opts) return;
    let seenOptional = false;
    for (const opt of opts) {
      if (opt.type === SUB_COMMAND || opt.type === SUB_COMMAND_GROUP) {
        walk(opt.options, `${path}/${opt.name}`);
        continue;
      }
      const required = opt.required ?? false;
      if (required && seenOptional) {
        failures.push(`${path}: required "${opt.name}" follows an optional option`);
      }
      if (!required) seenOptional = true;
      walk(opt.options, `${path}/${opt.name}`);
    }
  };
  walk(cmd.options, label);
  return failures;
}

/** Sibling names must be unique at every level — Discord rejects duplicates. */
function duplicateSiblings(cmd: Built, label: string): string[] {
  const dupes: string[] = [];
  const walk = (opts: Opt[] | undefined, path: string): void => {
    if (!opts) return;
    const seen = new Set<string>();
    for (const opt of opts) {
      if (seen.has(opt.name)) dupes.push(`${path}: duplicate "${opt.name}"`);
      seen.add(opt.name);
      walk(opt.options, `${path}/${opt.name}`);
    }
  };
  walk(cmd.options, label);
  return dupes;
}

// Regression guard: the whole feature build-out (workflows/steer/project/…) once
// pushed /seam to 28 top-level options and Discord's 25-cap made the bot crash
// at boot (registerSlashCommands -> validateMaxOptionsLength). tsc + unit tests
// were all green because nothing exercised the real command builder. This does —
// and since #151 there are TWO builders, so both are exercised here.
describe("/seam — everyday surface", () => {
  it("builds without throwing — this is exactly what registration does at boot", () => {
    expect(() => buildSeamCommand().toJSON()).not.toThrow();
  });

  it("registers exactly 8 top-level slots (5 subcommands + 3 groups)", () => {
    const json = seam();
    expect(json.options?.length ?? 0).toBe(8);
    expect(json.options?.length ?? 0).toBeLessThanOrEqual(25);
  });

  it("stays below Discord's 8,000-character application-command limit", () => {
    // Was 7,885/8,000 before the split — fifteen characters of headroom, which
    // is why #150 had to delete help text to land one option.
    expect(commandStringSize(seam())).toBeLessThanOrEqual(7_900);
  });

  it("lists exactly the everyday top-level names — no admin verbs", () => {
    const names = (seam().options ?? []).map((o) => o.name);
    expect(names).toEqual(["cancel", "steer", "new", "workflows", "queue", "config", "info", "preset"]);
    for (const moved of [
      "rebuild", "compact-thread", "schedule", "project", "upload", "bridge", "debug", "voice", "naming",
    ]) {
      expect(names, moved).not.toContain(moved);
    }
    expect(names).not.toContain("attach");
  });

  it("carries no Discord permission gate — it is the everyday surface", () => {
    const json = seam();
    expect(json.default_member_permissions ?? null).toBeNull();
  });

  it("config group has 18 leaves — rename and namer moved to /seamadmin naming", () => {
    const json = seam();
    const config = slot(json, "config");
    expect(config?.type).toBe(SUB_COMMAND_GROUP);
    const names = leafNames(json, "config");
    expect(names).toEqual([
      "model",
      "effort",
      "agent",
      "role",
      "mode",
      "repo",
      "tools",
      "card",
      "gif",
      "approve",
      "reset",
      "init",
      "detach",
      "tts",
      "show",
      "edit",
      "set",
      "audit",
    ]);
    expect(names).toHaveLength(18);
    expect(names).not.toContain("rename");
    expect(names).not.toContain("namer");

    const gif = config?.options?.find((o) => o.name === "gif");
    expect(gif?.options?.find((o) => o.name === "state")?.required ?? false).toBe(false);
    const detach = config?.options?.find((o) => o.name === "detach");
    const state = detach?.options?.find((o) => o.name === "state");
    expect(state?.type).toBe(STRING);
    expect(state?.required).toBe(true);
    const tts = config?.options?.find((o) => o.name === "tts");
    expect((tts?.options ?? []).map((o) => o.name)).toEqual(["state", "voice", "pace", "style"]);
    const ttsVoice = tts?.options?.find((o) => o.name === "voice");
    expect(ttsVoice?.autocomplete).toBe(true);
    const repo = config?.options?.find((o) => o.name === "repo");
    expect((repo?.options ?? []).map((o) => o.name)).toEqual(["path", "scope"]);
    expect(repo?.options?.find((o) => o.name === "scope")?.choices?.map((c) => c.value)).toEqual([
      "session",
      "thread",
      "channel",
    ]);
    const card = config?.options?.find((o) => o.name === "card");
    expect((card?.options ?? []).map((o) => o.name)).toEqual(["style", "scope"]);
    expect(card?.options?.find((o) => o.name === "scope")?.choices?.map((c) => c.value)).toEqual([
      "session",
      "thread",
      "channel",
    ]);
    const set = config?.options?.find((o) => o.name === "set");
    expect((set?.options ?? []).map((o) => o.name)).toEqual([
      "json",
      "agent",
      "model",
      "effort",
      "repo",
      "role",
      "permissions",
      "card",
      "gif",
      "rebuild",
    ]);
    expect(set?.options?.find((o) => o.name === "json")?.required ?? false).toBe(false);
    for (const name of ["agent", "model", "effort", "repo", "role", "permissions", "card", "gif"]) {
      expect(set?.options?.find((o) => o.name === name)?.autocomplete, name).toBe(true);
    }
    const rebuild = set?.options?.find((o) => o.name === "rebuild");
    expect(rebuild?.type).toBe(BOOLEAN);
    expect(rebuild?.required ?? false).toBe(false);
    expect(rebuild?.description).toMatch(/Rebuild session from Discord after applying/);
  });

  it("info group has 6 leaves", () => {
    const json = seam();
    expect(slot(json, "info")?.type).toBe(SUB_COMMAND_GROUP);
    expect(leafNames(json, "info")).toEqual([
      "whoami",
      "usage",
      "avatar",
      "help",
      "sessions",
      "repos",
    ]);
  });

  it("preset thread has required preset first, optional name second", () => {
    const json = seam();
    expect(slot(json, "preset")?.type).toBe(SUB_COMMAND_GROUP);
    expect(leafNames(json, "preset")).toEqual([
      "list",
      "create",
      "apply",
      "delete",
      "show",
      "edit",
      "thread",
    ]);
    const preset = slot(json, "preset");
    const thread = preset?.options?.find((o) => o.name === "thread");
    const opts = thread?.options ?? [];
    expect(opts.map((o) => o.name)).toEqual(["preset", "name", "quantity"]);
    expect(opts[0]?.required).toBe(true);
    expect(opts[0]?.autocomplete).toBe(true);
    expect(opts[1]?.required ?? false).toBe(false);
    expect(opts[2]?.type).toBe(INTEGER);
    expect((opts[2] as Opt & { min_value?: number }).min_value).toBe(1);
    for (const leaf of ["apply", "delete", "show", "edit"]) {
      const sub = preset?.options?.find((o) => o.name === leaf);
      const nameOpt = sub?.options?.find((o) => o.name === "name");
      expect(nameOpt?.required, leaf).toBe(true);
      expect(nameOpt?.autocomplete, leaf).toBe(true);
    }
    expect(preset?.options?.find((o) => o.name === "create")?.options?.find((o) => o.name === "name"))
      .toBeUndefined();
  });

  it("cancel absorbs abort+kill via force/scope options, not new keywords", () => {
    const cancel = slot(seam(), "cancel");
    expect(cancel?.type).toBe(SUB_COMMAND);
    expect(cancel?.options?.find((o) => o.name === "force")?.type).toBe(BOOLEAN);
    expect(cancel?.options?.find((o) => o.name === "scope")?.type).toBe(STRING);
  });

  // #63: the human-inbox two-tier lives as an OPTION on `steer` (options are
  // free — they don't count toward the 25), so it must not add a top-level slot.
  it("steer lists required prompt before optional thread/now", () => {
    const steer = slot(seam(), "steer");
    expect(steer?.type).toBe(SUB_COMMAND);
    expect((steer?.options ?? []).map((o) => o.name)).toEqual(["prompt", "thread", "now"]);
    expect(steer?.options?.[0]?.required).toBe(true);
    expect(steer?.options?.[1]?.required ?? false).toBe(false);
    expect(steer?.options?.[1]?.autocomplete).toBe(true);
    expect(steer?.options?.[2]?.type).toBe(BOOLEAN);
    expect(steer?.options?.[2]?.required ?? false).toBe(false);
  });

  it("queue is a top-level subcommand with required prompt (#89)", () => {
    const queue = slot(seam(), "queue");
    expect(queue?.type).toBe(SUB_COMMAND);
    expect((queue?.options ?? []).map((o) => o.name)).toEqual(["prompt"]);
    expect(queue?.options?.[0]?.required).toBe(true);
  });

  it("enables autocomplete on bounded free-form ids (not on enum addChoices)", () => {
    const json = seam();
    const config = slot(json, "config");
    const cfg = (name: string) => config?.options?.find((o) => o.name === name);
    expect(cfg("model")?.options?.find((o) => o.name === "id")?.autocomplete).toBe(true);
    expect(cfg("agent")?.options?.find((o) => o.name === "id")?.autocomplete).toBe(true);
    expect(cfg("mode")?.options?.find((o) => o.name === "id")?.autocomplete).toBe(true);
    expect(cfg("repo")?.options?.find((o) => o.name === "path")?.autocomplete).toBe(true);
    expect(cfg("effort")?.options?.find((o) => o.name === "level")?.autocomplete ?? false).toBe(false);
    expect(cfg("repo")?.options?.find((o) => o.name === "scope")?.autocomplete ?? false).toBe(false);

    const workflows = slot(json, "workflows");
    for (const name of ["cancel-wake", "cancel-watch", "cancel-choice", "cancel-ingest", "cancel-live"]) {
      expect(workflows?.options?.find((o) => o.name === name)?.autocomplete, name).toBe(true);
    }
  });

  it("config repo path is optional so omitting it opens the picker", () => {
    const repo = slot(seam(), "config")?.options?.find((o) => o.name === "repo");
    expect(repo?.options?.find((o) => o.name === "path")?.required ?? false).toBe(false);
  });

  it("removed image/abort/kill and old top-level config leaves", () => {
    const top = new Set((seam().options ?? []).map((o) => o.name));
    for (const gone of [
      "image", "abort", "kill", "attach", "model", "effort", "agent", "mode",
      "repo", "tools", "approve", "reset", "init", "config-set", "sessions", "repos",
    ]) {
      expect(top.has(gone), gone).toBe(false);
    }
    expect(slot(seam(), "config")?.type).toBe(SUB_COMMAND_GROUP);
  });
});

describe("/seamadmin — operator surface (#151)", () => {
  it("builds without throwing — registration does this at boot too", () => {
    expect(() => buildSeamAdminCommand().toJSON()).not.toThrow();
  });

  it("registers exactly 10 top-level slots (3 subcommands + 7 groups)", () => {
    const json = admin();
    expect(json.options?.length ?? 0).toBe(10);
    expect(json.options?.length ?? 0).toBeLessThanOrEqual(25);
  });

  it("gets its own fresh 8,000-character budget — the entire point of the split", () => {
    expect(commandStringSize(admin())).toBeLessThanOrEqual(7_900);
  });

  it("lists exactly the operator slots", () => {
    expect((admin().options ?? []).map((o) => o.name)).toEqual([
      "rebuild",
      "compact-thread",
      "recover",
      "schedule",
      "project",
      "upload",
      "bridge",
      "debug",
      "voice",
      "naming",
    ]);
  });

  it("declares the exact ManageGuild permission and Guild-only context", () => {
    const json = admin();
    // Serialized as a decimal STRING bitfield, not a number — assert the exact
    // value so a widened permission (or a dropped one) fails loudly.
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
    expect(json.default_member_permissions).toBe("32");
    // setContexts, NOT the deprecated setDMPermission.
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
    expect(json.contexts).toEqual([0]);
    expect(json.dm_permission).toBeUndefined();
  });

  it("naming group wraps rename + namer with the descriptions #150 deleted", () => {
    const json = admin();
    expect(slot(json, "naming")?.type).toBe(SUB_COMMAND_GROUP);
    expect(leafNames(json, "naming")).toEqual(["rename", "namer"]);
    const rename = slot(json, "naming")?.options?.find((o) => o.name === "rename");
    expect(rename?.description).toBe("Refresh/migrate names");
    expect(rename?.options?.map((o) => o.name)).toEqual(["scope", "migrate-legacy", "role-name"]);
    expect(rename?.options?.find((o) => o.name === "scope")?.description).toBe("Rename scope");
    expect(rename?.options?.find((o) => o.name === "migrate-legacy")?.description).toBe(
      "Migrate legacy prefix"
    );
    expect(rename?.options?.find((o) => o.name === "migrate-legacy")?.type).toBe(BOOLEAN);
    expect(rename?.options?.find((o) => o.name === "role-name")?.type).toBe(BOOLEAN);
  });

  it("schedule has 5 leaves — addfile/removefile removed by #158", () => {
    expect(leafNames(admin(), "schedule")).toEqual([
      "add",
      "list",
      "remove",
      "toggle",
      "edit",
    ]);
  });

  it("keeps schedule-id autocomplete working from its new /seamadmin home", () => {
    const schedule = slot(admin(), "schedule");
    for (const leaf of ["remove", "toggle", "edit"]) {
      const sub = schedule?.options?.find((o) => o.name === leaf);
      const id = sub?.options?.find((o) => o.name === "id");
      expect(id?.type, leaf).toBe(STRING);
      expect(id?.required, leaf).toBe(true);
      expect(id?.autocomplete, leaf).toBe(true);
    }
  });

  it("project/upload/bridge/debug/voice keep their leaves", () => {
    const json = admin();
    expect(leafNames(json, "project")).toEqual(["new", "list", "remove"]);
    expect(leafNames(json, "upload")).toEqual(["pull", "push", "secret"]);
    expect(leafNames(json, "bridge")).toEqual(["add", "rotate", "list", "remove", "restart"]);
    expect(leafNames(json, "debug")).toEqual([
      "tail",
      "exec",
      "status",
      "voice-ping",
      "voice-capture",
      "voice-live",
    ]);
    expect(leafNames(json, "voice")).toEqual([
      "start",
      "add",
      "remove",
      "configure",
      "console",
      "status",
      "stop",
    ]);
    const stop = slot(json, "voice")?.options?.find((o) => o.name === "stop");
    const discard = stop?.options?.find((o) => o.name === "discard-pending");
    expect(discard?.type).toBe(BOOLEAN);
    expect(discard?.required ?? false).toBe(false);
    const bridgeAdd = slot(json, "bridge")?.options?.find((o) => o.name === "add");
    expect(bridgeAdd?.options?.[0]?.name).toBe("name");
    expect(bridgeAdd?.options?.[0]?.required).toBe(true);
  });

  it("rebuild is the deterministic reconstruction command with no model options", () => {
    const rebuild = slot(admin(), "rebuild");
    expect(rebuild?.type).toBe(SUB_COMMAND);
    expect(rebuild?.description).toMatch(/Deterministic/i);
    expect(rebuild?.description).toMatch(/60%/);
    expect(rebuild?.description).not.toMatch(/lossless/i);
    expect(rebuild?.description?.length ?? 0).toBeLessThanOrEqual(100);
    expect(rebuild?.options ?? []).toEqual([]);
  });

  it("compact-thread is the former model-assisted rebuild with optional agent and model", () => {
    const compact = slot(admin(), "compact-thread");
    expect(compact?.type).toBe(SUB_COMMAND);
    expect(compact?.description).toMatch(/Model-assisted/i);
    expect(compact?.description).not.toMatch(/lossless/i);
    expect((compact?.options ?? []).map((o) => o.name)).toEqual(["agent", "model"]);
    for (const option of compact?.options ?? []) {
      expect(option.type).toBe(STRING);
      expect(option.required ?? false).toBe(false);
    }
  });

  it("exposes localized queue recovery and explicit restart modes (#180)", () => {
    const recover = slot(admin(), "recover");
    expect(recover?.type).toBe(SUB_COMMAND);
    expect(recover?.options?.map((o) => o.name)).toEqual(["thread", "mode"]);
    expect(recover?.options?.[0]).toMatchObject({ required: true, autocomplete: true });
    expect(recover?.options?.[1]?.choices?.map((choice) => choice.value)).toEqual([
      "auto",
      "force",
    ]);

    const restart = slot(admin(), "bridge")?.options?.find((o) => o.name === "restart");
    expect(restart?.options?.map((o) => o.name)).toEqual(["mode", "confirm"]);
    expect(restart?.options?.[0]?.choices?.map((choice) => choice.value)).toEqual([
      "drain",
      "force",
    ]);
    expect(restart?.options?.[1]?.type).toBe(BOOLEAN);
  });
});

describe("the split as a whole", () => {
  it("registers BOTH commands — a body missing one silently unregisters it", () => {
    // Discord replaces the full command set on PUT, so shipping only /seam here
    // would delete /seamadmin from the guild.
    const body = buildSlashRegistrationBody();
    expect(body.map((c) => c.name)).toEqual([SEAM_COMMAND_NAME, SEAM_ADMIN_COMMAND_NAME]);
    expect(body.map((c) => c.name)).toEqual(["seam", "seamadmin"]);
    expect(body).toHaveLength(2);
  });

  it("has no overlapping top-level names across the two commands", () => {
    const a = new Set((seam().options ?? []).map((o) => o.name));
    const overlap = (admin().options ?? []).map((o) => o.name).filter((n) => a.has(n));
    expect(overlap).toEqual([]);
  });

  it("has no duplicate sibling names anywhere in either tree", () => {
    expect(duplicateSiblings(seam(), "/seam")).toEqual([]);
    expect(duplicateSiblings(admin(), "/seamadmin")).toEqual([]);
  });

  it("keeps required options before optional ones in every leaf of both trees", () => {
    expect(requiredOrderFailures(seam(), "/seam")).toEqual([]);
    expect(requiredOrderFailures(admin(), "/seamadmin")).toEqual([]);
  });

  it("keeps every group within Discord's 25-option-per-group cap", () => {
    for (const cmd of [seam(), admin()]) {
      for (const opt of cmd.options ?? []) {
        if (opt.type === SUB_COMMAND_GROUP) {
          expect(opt.options?.length ?? 0, `${cmd.name}/${opt.name}`).toBeLessThanOrEqual(25);
        }
      }
    }
  });

  it("moved every operator verb — none is reachable from /seam any more", () => {
    const seamTop = new Set((seam().options ?? []).map((o) => o.name));
    const adminTop = new Set((admin().options ?? []).map((o) => o.name));
    for (const moved of [
      "rebuild", "compact-thread", "schedule", "project", "upload", "bridge", "debug", "voice", "naming",
    ]) {
      expect(seamTop.has(moved), `/seam still has ${moved}`).toBe(false);
      expect(adminTop.has(moved), `/seamadmin is missing ${moved}`).toBe(true);
    }
  });
});
