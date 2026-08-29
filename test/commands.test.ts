import { describe, it, expect } from "vitest";
import { buildSeamCommand } from "../packages/core/src/platforms/discord/commands.js";

// Discord ApplicationCommandOptionType
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;
const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;

type Opt = {
  name: string;
  type: number;
  required?: boolean;
  autocomplete?: boolean;
  options?: Opt[];
  choices?: { name: string; value: string }[];
};

function built(): { options?: Opt[] } {
  return buildSeamCommand().toJSON() as { options?: Opt[] };
}

function commandStringSize(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + commandStringSize(item), 0);
  if (value && typeof value === "object") {
    return Object.values(value).reduce<number>((sum, item) => sum + commandStringSize(item), 0);
  }
  return 0;
}

// Regression guard: the whole feature build-out (workflows/steer/project/…) once
// pushed /seam to 28 top-level options and Discord's 25-cap made the bot crash
// at boot (registerSlashCommands -> validateMaxOptionsLength). tsc + unit tests
// were all green because nothing exercised the real command builder. This does.
describe("/seam slash command", () => {
  it("builds without throwing — this is exactly what registration does at boot", () => {
    expect(() => buildSeamCommand().toJSON()).not.toThrow();
  });

  it("registers exactly 15 top-level slots (6 subcommands + 9 groups)", () => {
    const json = built();
    expect(json.options?.length ?? 0).toBe(15);
    expect(json.options?.length ?? 0).toBeLessThanOrEqual(25);
  });

  it("stays below Discord's 8,000-character application-command limit", () => {
    expect(commandStringSize(buildSeamCommand().toJSON())).toBeLessThanOrEqual(7_900);
  });

  it("top-level names include rebuild plus the existing commands and 9 groups", () => {
    const names = (built().options ?? []).map((o) => o.name);
    expect(names).toEqual([
      "cancel",
      "steer",
      "new",
      "workflows",
      "queue",
      "rebuild",
      "config",
      "info",
      "schedule",
      "preset",
      "project",
      "upload",
      "bridge",
      "debug",
      "voice",
    ]);
    expect(names).not.toContain("attach");
  });

  it("voice group exposes the seven-command V2 hard cutover", () => {
    const voice = built().options?.find((o) => o.name === "voice");
    expect(voice?.type).toBe(SUB_COMMAND_GROUP);
    expect((voice?.options ?? []).map((o) => o.name)).toEqual([
      "start", "add", "remove", "configure", "console", "status", "stop",
    ]);
    const stop = voice?.options?.find((o) => o.name === "stop");
    const discard = stop?.options?.find((o) => o.name === "discard-pending");
    expect(discard?.type).toBe(BOOLEAN);
    expect(discard?.required ?? false).toBe(false);
  });

  it("/seam rebuild has optional agent and model strings", () => {
    const rebuild = built().options?.find((o) => o.name === "rebuild");
    expect(rebuild?.type).toBe(SUB_COMMAND);
    expect((rebuild?.options ?? []).map((o) => o.name)).toEqual(["agent", "model"]);
    for (const option of rebuild?.options ?? []) {
      expect(option.type).toBe(STRING);
      expect(option.required ?? false).toBe(false);
    }
  });

  it("each group stays within Discord's 25-option-per-group cap", () => {
    for (const opt of built().options ?? []) {
      if (opt.type === SUB_COMMAND_GROUP) {
        expect(opt.options?.length ?? 0, opt.name).toBeLessThanOrEqual(25);
      }
    }
  });

  it("config group has the 17 config leaves including card, gif, detach, tts, and edit", () => {
    const config = built().options?.find((o) => o.name === "config");
    expect(config?.type).toBe(SUB_COMMAND_GROUP);
    const names = (config?.options ?? []).map((o) => o.name);
    expect(names).toEqual([
      "model",
      "effort",
      "agent",
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
    expect(names).toHaveLength(17);
    const gif = (config?.options ?? []).find((o) => o.name === "gif");
    expect(gif?.options?.find((o) => o.name === "state")?.required ?? false).toBe(false);
    const detach = (config?.options ?? []).find((o) => o.name === "detach");
    const state = detach?.options?.find((o) => o.name === "state");
    expect(state?.type).toBe(STRING);
    expect(state?.required).toBe(true);
    const tts = (config?.options ?? []).find((o) => o.name === "tts");
    const ttsState = tts?.options?.find((o) => o.name === "state");
    expect(ttsState?.type).toBe(STRING);
    expect(ttsState?.required ?? false).toBe(false);
    const ttsVoice = tts?.options?.find((o) => o.name === "voice");
    expect(ttsVoice?.type).toBe(STRING);
    expect(ttsVoice?.required ?? false).toBe(false);
    expect(ttsVoice?.autocomplete).toBe(true);
    expect((tts?.options ?? []).map((o) => o.name)).toEqual(["state", "voice", "pace", "style"]);
    const repo = (config?.options ?? []).find((o) => o.name === "repo");
    expect((repo?.options ?? []).map((o) => o.name)).toEqual(["path", "scope"]);
    const repoScope = repo?.options?.find((o) => o.name === "scope");
    expect(repoScope?.type).toBe(STRING);
    expect(repoScope?.required ?? false).toBe(false);
    expect(repoScope?.choices?.map((c) => c.value)).toEqual(["session", "thread", "channel"]);
    const card = (config?.options ?? []).find((o) => o.name === "card");
    expect((card?.options ?? []).map((o) => o.name)).toEqual(["style", "scope"]);
    const scope = card?.options?.find((o) => o.name === "scope");
    expect(scope?.type).toBe(STRING);
    expect(scope?.required ?? false).toBe(false);
    expect(scope?.choices?.map((c) => c.value)).toEqual(["session", "thread", "channel"]);
  });

  it("info group has 6 leaves (sessions/repos moved in; config-audit moved out)", () => {
    const info = built().options?.find((o) => o.name === "info");
    expect(info?.type).toBe(SUB_COMMAND_GROUP);
    const names = (info?.options ?? []).map((o) => o.name);
    expect(names).toEqual(["whoami", "usage", "avatar", "help", "sessions", "repos"]);
    expect(names).toHaveLength(6);
    expect(names).not.toContain("config-audit");
  });

  it("bridge group has add/rotate/list/remove; debug has tail/exec/status/voice-ping/voice-capture/voice-live", () => {
    const json = built();
    const bridge = json.options?.find((o) => o.name === "bridge");
    expect(bridge?.type).toBe(SUB_COMMAND_GROUP);
    expect((bridge?.options ?? []).map((o) => o.name)).toEqual(["add", "rotate", "list", "remove"]);
    const debug = json.options?.find((o) => o.name === "debug");
    expect(debug?.type).toBe(SUB_COMMAND_GROUP);
    expect((debug?.options ?? []).map((o) => o.name)).toEqual([
      "tail",
      "exec",
      "status",
      "voice-ping",
      "voice-capture",
      "voice-live",
    ]);
    const add = (bridge?.options ?? []).find((o) => o.name === "add");
    const addNames = (add?.options ?? []).map((o) => o.name);
    expect(addNames[0]).toBe("name");
    expect(add?.options?.[0]?.required).toBe(true);
  });

  it("schedule/project group sizes are unchanged; preset has thread; upload has pull/push/secret", () => {
    const json = built();
    const count = (name: string) =>
      json.options?.find((o) => o.name === name)?.options?.length ?? 0;
    expect(count("schedule")).toBe(7);
    expect(count("preset")).toBe(7);
    expect(count("project")).toBe(3);
    const upload = json.options?.find((o) => o.name === "upload");
    expect(upload?.type).toBe(SUB_COMMAND_GROUP);
    expect((upload?.options ?? []).map((o) => o.name)).toEqual(["pull", "push", "secret"]);
  });

  it("/seam preset thread has required preset first, optional name second", () => {
    const preset = built().options?.find((o) => o.name === "preset");
    expect(preset?.type).toBe(SUB_COMMAND_GROUP);
    const names = (preset?.options ?? []).map((o) => o.name);
    expect(names).toEqual(["list", "create", "apply", "delete", "show", "edit", "thread"]);
    const thread = (preset?.options ?? []).find((o) => o.name === "thread");
    const opts = thread?.options ?? [];
    expect(opts.map((o) => o.name)).toEqual(["preset", "name", "quantity"]);
    expect(opts[0]?.type).toBe(STRING);
    expect(opts[0]?.required).toBe(true);
    expect(opts[0]?.autocomplete).toBe(true);
    expect(opts[1]?.type).toBe(STRING);
    expect(opts[1]?.required ?? false).toBe(false);
    expect(opts[1]?.autocomplete ?? false).toBe(false);
    expect(opts[2]?.type).toBe(INTEGER);
    expect(opts[2]?.required ?? false).toBe(false);
    expect((opts[2] as Opt & { min_value?: number }).min_value).toBe(1);
    expect((opts[2] as Opt & { max_value?: number }).max_value).toBe(9);
    for (const leaf of ["apply", "delete", "show", "edit"]) {
      const sub = (preset?.options ?? []).find((o) => o.name === leaf);
      const nameOpt = (sub?.options ?? []).find((o) => o.name === "name");
      expect(nameOpt?.required, leaf).toBe(true);
      expect(nameOpt?.autocomplete, leaf).toBe(true);
    }
    const create = (preset?.options ?? []).find((o) => o.name === "create");
    expect((create?.options ?? []).find((o) => o.name === "name")).toBeUndefined();
  });

  it("removed image/abort/kill and old top-level config leaves", () => {
    const top = new Set((built().options ?? []).map((o) => o.name));
    for (const gone of [
      "image",
      "abort",
      "kill",
      "attach",
      "model",
      "effort",
      "agent",
      "mode",
      "repo",
      "tools",
      "approve",
      "reset",
      "init",
      "config-set",
      "sessions",
      "repos",
    ]) {
      expect(top.has(gone), gone).toBe(false);
    }
    // `config` remains, but as a GROUP not a leaf
    expect(built().options?.find((o) => o.name === "config")?.type).toBe(SUB_COMMAND_GROUP);
  });

  // #63: the human-inbox two-tier lives as an OPTION on the existing `steer`
  // subcommand (options are free — they don't count toward the 25), so adding it
  // must NOT introduce a new top-level command and must leave the cap green.
  it("adds `now` as an option on `steer` — not a new top-level command", () => {
    const json = built();
    const steer = json.options?.find((o) => o.name === "steer");
    expect(steer?.type).toBe(SUB_COMMAND);
    const now = steer?.options?.find((o) => o.name === "now");
    expect(now).toBeTruthy();
    expect(now?.type).toBe(BOOLEAN);
    expect(now?.required ?? false).toBe(false);
    const thread = steer?.options?.find((o) => o.name === "thread");
    expect(thread?.type).toBe(STRING);
    expect(thread?.required ?? false).toBe(false);
    expect(thread?.autocomplete).toBe(true);
  });

  it("enables autocomplete on bounded free-form ids (not on enum addChoices)", () => {
    const json = built();
    const config = json.options?.find((o) => o.name === "config");
    const cfg = (name: string) => (config?.options ?? []).find((o) => o.name === name);
    expect(cfg("model")?.options?.find((o) => o.name === "id")?.autocomplete).toBe(true);
    expect(cfg("agent")?.options?.find((o) => o.name === "id")?.autocomplete).toBe(true);
    expect(cfg("mode")?.options?.find((o) => o.name === "id")?.autocomplete).toBe(true);
    expect(cfg("repo")?.options?.find((o) => o.name === "path")?.autocomplete).toBe(true);
    expect(cfg("effort")?.options?.find((o) => o.name === "level")?.autocomplete ?? false).toBe(false);
    expect(cfg("repo")?.options?.find((o) => o.name === "scope")?.autocomplete ?? false).toBe(false);

    const schedule = json.options?.find((o) => o.name === "schedule");
    for (const leaf of ["remove", "toggle", "addfile", "removefile", "edit"]) {
      const sub = (schedule?.options ?? []).find((o) => o.name === leaf);
      expect(sub?.options?.find((o) => o.name === "id")?.autocomplete, leaf).toBe(true);
    }
    const removefile = (schedule?.options ?? []).find((o) => o.name === "removefile");
    expect(removefile?.options?.find((o) => o.name === "filename")?.autocomplete).toBe(true);

    const workflows = json.options?.find((o) => o.name === "workflows");
    for (const name of ["cancel-wake", "cancel-watch", "cancel-choice", "cancel-ingest", "cancel-live"]) {
      expect(workflows?.options?.find((o) => o.name === name)?.autocomplete, name).toBe(true);
    }
  });

  it("config repo path is optional so omitting it opens the picker", () => {
    const config = built().options?.find((o) => o.name === "config");
    const repo = (config?.options ?? []).find((o) => o.name === "repo");
    const pathOpt = repo?.options?.find((o) => o.name === "path");
    expect(pathOpt?.type).toBe(STRING);
    expect(pathOpt?.required ?? false).toBe(false);
  });

  it("queue is a top-level subcommand with required prompt (#89)", () => {
    const queue = built().options?.find((o) => o.name === "queue");
    expect(queue?.type).toBe(SUB_COMMAND);
    const names = (queue?.options ?? []).map((o) => o.name);
    expect(names).toEqual(["prompt"]);
    expect(queue?.options?.[0]?.required).toBe(true);
    expect(queue?.options?.[0]?.type).toBe(STRING);
  });

  it("steer lists required prompt before optional thread/now (Discord option order)", () => {
    const steer = built().options?.find((o) => o.name === "steer");
    const names = (steer?.options ?? []).map((o) => o.name);
    expect(names).toEqual(["prompt", "thread", "now"]);
    expect(steer?.options?.[0]?.required).toBe(true);
    expect(steer?.options?.[1]?.required ?? false).toBe(false);
    expect(steer?.options?.[2]?.required ?? false).toBe(false);
  });

  it("every leaf keeps required options before optional ones", () => {
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
    walk(built().options, "/seam");
    expect(failures).toEqual([]);
  });

  it("cancel absorbs abort+kill via force/scope options, not new keywords", () => {
    const cancel = built().options?.find((o) => o.name === "cancel");
    expect(cancel?.type).toBe(SUB_COMMAND);
    const force = cancel?.options?.find((o) => o.name === "force");
    const scope = cancel?.options?.find((o) => o.name === "scope");
    expect(force?.type).toBe(BOOLEAN);
    expect(force?.required ?? false).toBe(false);
    expect(scope?.type).toBe(STRING);
    expect(scope?.required ?? false).toBe(false);
  });
});
