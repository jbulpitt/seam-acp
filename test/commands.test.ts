import { describe, it, expect } from "vitest";
import { buildSeamCommand } from "../packages/core/src/platforms/discord/commands.js";

// Discord ApplicationCommandOptionType
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;
const STRING = 3;
const BOOLEAN = 5;

type Opt = {
  name: string;
  type: number;
  required?: boolean;
  autocomplete?: boolean;
  options?: Opt[];
};

function built(): { options?: Opt[] } {
  return buildSeamCommand().toJSON() as { options?: Opt[] };
}

// Regression guard: the whole feature build-out (workflows/steer/project/…) once
// pushed /seam to 28 top-level options and Discord's 25-cap made the bot crash
// at boot (registerSlashCommands -> validateMaxOptionsLength). tsc + unit tests
// were all green because nothing exercised the real command builder. This does.
describe("/seam slash command", () => {
  it("builds without throwing — this is exactly what registration does at boot", () => {
    expect(() => buildSeamCommand().toJSON()).not.toThrow();
  });

  it("registers exactly 13 top-level slots (5 subcommands + 8 groups)", () => {
    const json = built();
    expect(json.options?.length ?? 0).toBe(13);
    expect(json.options?.length ?? 0).toBeLessThanOrEqual(25);
  });

  it("top-level names are cancel/steer/new/workflows/queue + 8 groups", () => {
    const names = (built().options ?? []).map((o) => o.name);
    expect(names).toEqual([
      "cancel",
      "steer",
      "new",
      "workflows",
      "queue",
      "config",
      "info",
      "schedule",
      "preset",
      "project",
      "upload",
      "bridge",
      "debug",
    ]);
    expect(names).not.toContain("attach");
  });

  it("each group stays within Discord's 25-option-per-group cap", () => {
    for (const opt of built().options ?? []) {
      if (opt.type === SUB_COMMAND_GROUP) {
        expect(opt.options?.length ?? 0, opt.name).toBeLessThanOrEqual(25);
      }
    }
  });

  it("config group has the 15 config leaves including detach, tts, and edit", () => {
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
    expect(names).toHaveLength(15);
    const detach = (config?.options ?? []).find((o) => o.name === "detach");
    const state = detach?.options?.find((o) => o.name === "state");
    expect(state?.type).toBe(STRING);
    expect(state?.required).toBe(true);
    const tts = (config?.options ?? []).find((o) => o.name === "tts");
    const ttsState = tts?.options?.find((o) => o.name === "state");
    expect(ttsState?.type).toBe(STRING);
    expect(ttsState?.required).toBe(true);
    const ttsVoice = tts?.options?.find((o) => o.name === "voice");
    expect(ttsVoice?.type).toBe(STRING);
    expect(ttsVoice?.required ?? false).toBe(false);
    expect(ttsVoice?.autocomplete).toBe(true);
  });

  it("info group has 6 leaves (sessions/repos moved in; config-audit moved out)", () => {
    const info = built().options?.find((o) => o.name === "info");
    expect(info?.type).toBe(SUB_COMMAND_GROUP);
    const names = (info?.options ?? []).map((o) => o.name);
    expect(names).toEqual(["whoami", "usage", "avatar", "help", "sessions", "repos"]);
    expect(names).toHaveLength(6);
    expect(names).not.toContain("config-audit");
  });

  it("bridge group has add/rotate/list/remove; debug has tail/exec/status", () => {
    const json = built();
    const bridge = json.options?.find((o) => o.name === "bridge");
    expect(bridge?.type).toBe(SUB_COMMAND_GROUP);
    expect((bridge?.options ?? []).map((o) => o.name)).toEqual(["add", "rotate", "list", "remove"]);
    const debug = json.options?.find((o) => o.name === "debug");
    expect(debug?.type).toBe(SUB_COMMAND_GROUP);
    expect((debug?.options ?? []).map((o) => o.name)).toEqual(["tail", "exec", "status"]);
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

  it("/seam preset thread has required name + autocompleted preset (#93)", () => {
    const preset = built().options?.find((o) => o.name === "preset");
    expect(preset?.type).toBe(SUB_COMMAND_GROUP);
    const names = (preset?.options ?? []).map((o) => o.name);
    expect(names).toEqual(["list", "create", "apply", "delete", "show", "edit", "thread"]);
    const thread = (preset?.options ?? []).find((o) => o.name === "thread");
    const opts = thread?.options ?? [];
    expect(opts.map((o) => o.name)).toEqual(["name", "preset"]);
    expect(opts[0]?.type).toBe(STRING);
    expect(opts[0]?.required).toBe(true);
    expect(opts[0]?.autocomplete ?? false).toBe(false);
    expect(opts[1]?.type).toBe(STRING);
    expect(opts[1]?.required).toBe(true);
    expect(opts[1]?.autocomplete).toBe(true);
    // Existing name-typed leaves stay free-form (no autocomplete).
    for (const leaf of ["apply", "delete", "show", "edit"]) {
      const sub = (preset?.options ?? []).find((o) => o.name === leaf);
      const nameOpt = (sub?.options ?? []).find((o) => o.name === "name");
      expect(nameOpt?.autocomplete ?? false, leaf).toBe(false);
    }
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
