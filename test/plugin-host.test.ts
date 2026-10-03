import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { BUILTIN_PLUGINS } from "../packages/core/src/plugins/builtins.js";
import type { FenceInvocation, Plugin } from "../packages/core/src/plugins/types.js";
import { harnessPreamble } from "../packages/core/src/core/agent-conventions.js";

function host() {
  const logs: any[] = [];
  const logger = pino({ level: "info" }, new Writable({ write(chunk, _encoding, done) { logs.push(JSON.parse(String(chunk))); done(); } }));
  return { plugins: new PluginHost(logger), logs };
}

function plugin(id: string, tag = id): Plugin {
  return { id, apiVersion: 1, builtin: true, contributions: { fences: [{ tag, instruction: `Use ${tag}`, handle: async ({ output }) => output.sendText(id) }] } };
}

function invocation(lang: string, content = "body", notice?: string): FenceInvocation {
  return { fence: { lang, content }, counter: 3, notice, output: { sendText: vi.fn(async () => {}), fallback: vi.fn(async () => {}) } };
}

describe("plugin host isolation", () => {
  it("rejects duplicate ids and aliases atomically, preserving other plugins", async () => {
    const { plugins, logs } = host();
    const collision = plugin("collision", "unique");
    collision.contributions.fences = [...collision.contributions.fences, { ...plugin("unused", "FIRST").contributions.fences[0]! }];
    await plugins.loadBuiltins([
      { id: "first", load: async () => plugin("first") },
      { id: "first", load: async () => plugin("first") },
      { id: "collision", load: async () => collision },
      { id: "last", load: async () => plugin("last") },
    ]);
    expect(logs.filter(log => log.msg === "plugin disabled").map(log => log.err.message)).toEqual([
      "duplicate plugin id first", "plugin collision: duplicate fence tag first (owner: first)",
    ]);
    expect(plugins.fences.instructions).toEqual(["Use first", "Use last"]);
    expect(await plugins.fences.render(invocation("unique"))).toBe(false);
    const input = invocation("last");
    expect(await plugins.fences.render(input)).toBe(true);
    expect(input.output.sendText).toHaveBeenCalledWith("last");
    await plugins.dispose();
  });

  it("isolates load, config and activation failures; supplies only scoped config and logger", async () => {
    const { plugins, logs } = host();
    const cleanup = vi.fn();
    const badConfig = { ...plugin("config"), validateConfig: () => { throw new Error("bad plugin config"); } };
    const badActivation = { ...plugin("activation"), activate: () => { throw new Error("native engine unavailable"); }, dispose: cleanup };
    const activated: string[] = [];
    const healthy = { ...plugin("healthy"), validateConfig: (config: unknown) => config, activate: (context: any) => {
      expect(Object.keys(context).sort()).toEqual(["config", "logger"]);
      expect(context.config).toEqual({ color: "blue" });
      context.logger.info("scoped activation");
      activated.push("healthy");
    } };
    await plugins.loadBuiltins([
      { id: "load", load: async () => { throw new Error("module not found"); } },
      { id: "config", load: async () => badConfig },
      { id: "activation", load: async () => badActivation },
      { id: "healthy", load: async () => healthy },
    ], { healthy: { color: "blue" } });
    expect(activated).toEqual(["healthy"]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(plugins.fences.instructions).toEqual(["Use healthy"]);
    expect(logs.filter(log => log.msg === "plugin disabled").map(log => [log.plugin, log.err.message])).toEqual([
      ["load", "module not found"], ["config", "bad plugin config"], ["activation", "native engine unavailable"],
    ]);
    expect(logs.find(log => log.msg === "scoped activation").plugin).toBe("healthy");
    await plugins.dispose();
  });

  it("logs a throwing handler's cause and falls back with the original notice", async () => {
    const { plugins, logs } = host();
    const bad = plugin("bad");
    bad.contributions.fences[0]!.handle = async () => { throw new Error("renderer exploded"); };
    await plugins.loadBuiltins([{ id: "bad", load: async () => bad }, { id: "healthy", load: async () => plugin("healthy") }]);
    const input = invocation("bad", "source", "watchdog notice");
    expect(await plugins.fences.render(input)).toBe(true);
    expect(input.output.fallback).toHaveBeenCalledWith("watchdog notice");
    expect(logs.find(log => log.msg === "plugin fence handler failed; emitting source").err.message).toBe("renderer exploded");
    expect(await plugins.fences.render(invocation("healthy"))).toBe(true);
    await plugins.dispose();
  });

  it("drains an active fence before disposal and isolates a dispose failure", async () => {
    const { plugins, logs } = host();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const disposed: string[] = [];
    const slow = { ...plugin("slow"), dispose: () => { disposed.push("slow"); } };
    slow.contributions.fences[0]!.handle = async ({ output }) => { await pending; await output.sendText("finished"); };
    const broken = { ...plugin("broken"), dispose: () => { throw new Error("dispose failed"); } };
    await plugins.loadBuiltins([{ id: "slow", load: async () => slow }, { id: "broken", load: async () => broken }]);
    const input = invocation("slow");
    const render = plugins.fences.render(input);
    const dispose = plugins.dispose();
    expect(disposed).toEqual([]);
    expect(await plugins.fences.render(invocation("slow"))).toBe(false);
    release();
    await render;
    await dispose;
    expect(input.output.sendText).toHaveBeenCalledWith("finished");
    expect(disposed).toEqual(["slow"]);
    expect(logs.find(log => log.msg === "plugin disposal failed").err.message).toBe("dispose failed");
  });
});

describe("built-in math contribution", () => {
  it.each(["latex", "math", "tex", "katex", " LaTeX "])("renders alias %s using the same registered handler", async tag => {
    const { plugins } = host();
    await plugins.loadBuiltins(BUILTIN_PLUGINS);
    const input = invocation(tag, "e^{i\\pi}+1=0", "original notice");
    const files: Buffer[] = [];
    input.output.sendFile = async file => { expect(file.filename).toBe("math-3.png"); files.push(file.data); };
    expect(await plugins.fences.render(input)).toBe(true);
    expect(files[0]!.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(input.output.sendText).toHaveBeenCalledWith("original notice");
    expect(input.output.fallback).not.toHaveBeenCalled();
    expect(harnessPreamble([], undefined, { fenceInstructions: plugins.fences.instructions })).toContain("`katex`");
    await plugins.dispose();
    expect(harnessPreamble([], undefined, { fenceInstructions: plugins.fences.instructions })).not.toContain("typeset");
  }, 20_000);

  it("preserves the source and unfinished notice on invalid TeX or unavailable upload", async () => {
    const { plugins } = host();
    await plugins.loadBuiltins(BUILTIN_PLUGINS);
    const invalid = invocation("tex", "\\notARealMacro{", "unclosed fence");
    invalid.output.sendFile = vi.fn();
    await plugins.fences.render(invalid);
    expect(invalid.output.fallback).toHaveBeenCalledWith("unclosed fence\n_(couldn't render latex)_");
    const unavailable = invocation("math", "x=1", "watchdog notice");
    await plugins.fences.render(unavailable);
    expect(unavailable.output.fallback).toHaveBeenCalledWith("watchdog notice");
    expect(await plugins.fences.render(invocation("python"))).toBe(false);
    await plugins.dispose();
  });
});
