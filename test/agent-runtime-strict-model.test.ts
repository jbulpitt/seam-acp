import { describe, it, expect } from "vitest";
import { RequestError, PROTOCOL_VERSION, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { classifyCodexError, type AgentProfile, type CatalogEffort } from "@seam/adapters";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { finished } from "node:stream/promises";

const fakeProfile = { id: "claude" } as unknown as AgentProfile;

type WarnCall = { obj: unknown; msg: string };

function makeLogger() {
  const warns: WarnCall[] = [];
  const logger = {
    child() {
      return this;
    },
    warn(obj: unknown, msg?: string) {
      warns.push({ obj, msg: msg ?? String(obj) });
    },
    error() {},
    info() {},
    debug() {},
  };
  return { logger: logger as unknown as Logger, warns };
}

class FakeConn {
  setModelShouldReject = false;
  setModelError?: Error;
  setModelCalls = 0;
  initialConfigOptions: unknown = null;
  nextConfigOptions: unknown = null;

  async newSession() {
    return { sessionId: "fresh-session", configOptions: this.initialConfigOptions, modes: null };
  }
  async loadSession(params: { sessionId: string }) {
    return { sessionId: params.sessionId, configOptions: this.initialConfigOptions, modes: null };
  }
  async prompt() {
    return { stopReason: "end_turn" };
  }
  async cancel() {}
  async setSessionMode() {}
  async setSessionConfigOption() {
    this.setModelCalls += 1;
    if (this.setModelError) throw this.setModelError;
    if (this.setModelShouldReject) {
      throw new Error("Invalid value for config option model: claude-opus-5");
    }
    return { configOptions: this.nextConfigOptions };
  }
}

function makeRuntime(profile = fakeProfile) {
  const { logger, warns } = makeLogger();
  const rt = new AgentRuntime({ profile, logger, spawnFn: () => { throw new Error("unused"); } });
  const conn = new FakeConn();
  (rt as unknown as { connection: unknown }).connection = conn;
  (rt as unknown as { promptCapabilities: unknown }).promptCapabilities = {};
  return { rt, conn, warns };
}

describe("AgentRuntime strictModel", () => {
  it.each(["newSession", "loadSession"] as const)("surfaces the real Codex model rejection and continued selection once from %s", async method => {
    const { rt, conn } = makeRuntime({ ...fakeProfile, id: "codex", classifyError: classifyCodexError });
    conn.setModelError = new RequestError(-32602, "Invalid params", null);
    conn.initialConfigOptions = [{
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: "gpt-6-astra", options: [{ name: "GPT 6", value: "gpt-6-astra" }],
    }];
    const events: Array<{ kind: string; message?: string }> = [];
    rt.onEvent(event => { events.push(event); });
    const input = { cwd: "/tmp", model: "seam-629-not-a-model" };
    const info = method === "newSession" ? await rt.newSession(input)
      : await rt.loadSession({ ...input, sessionId: "existing-session" });
    expect(info.currentModelId).toBe("gpt-6-astra");
    expect(conn.setModelCalls).toBe(1);
    expect(events).toEqual([]);
    await rt.prompt("first prompt");
    await rt.prompt("second prompt");
    const notices = events.filter(event => event.kind === "recovery");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain("seam-629-not-a-model");
    expect(notices[0]!.message).toContain("Invalid params");
    expect(notices[0]!.message).toContain("-32602");
    expect(notices[0]!.message).toContain("gpt-6-astra");
  });

  it("throws from newSession when strictModel is true and setModel rejects", async () => {
    const { rt, conn } = makeRuntime();
    conn.setModelShouldReject = true;
    await expect(
      rt.newSession({ cwd: "/tmp", model: "claude-opus-5", strictModel: true })
    ).rejects.toThrow(/failed to set initial model "claude-opus-5"/);
    expect(conn.setModelCalls).toBe(1);
  });

  it("warns and continues from newSession when strictModel is omitted (live default)", async () => {
    const { rt, conn, warns } = makeRuntime();
    conn.setModelShouldReject = true;
    const info = await rt.newSession({ cwd: "/tmp", model: "claude-opus-5" });
    expect(info.sessionId).toBe("fresh-session");
    expect(conn.setModelCalls).toBe(1);
    expect(warns.some((w) => w.msg === "failed to set initial model")).toBe(true);
  });

  it("throws from loadSession when strictModel is true and setModel rejects", async () => {
    const { rt, conn } = makeRuntime();
    conn.setModelShouldReject = true;
    await expect(
      rt.loadSession({
        sessionId: "s1",
        cwd: "/tmp",
        model: "claude-opus-5",
        strictModel: true,
      })
    ).rejects.toThrow(/failed to re-apply model "claude-opus-5"/);
    expect(conn.setModelCalls).toBe(1);
  });

  it("succeeds when setModel is accepted even with strictModel", async () => {
    const { rt, conn } = makeRuntime();
    const info = await rt.newSession({
      cwd: "/tmp",
      model: "default",
      strictModel: true,
    });
    expect(info.sessionId).toBe("fresh-session");
    expect(info.currentModelId).toBe("default");
    expect(conn.setModelCalls).toBe(1);
  });

  it("tracks live select values from session creation and config-option updates", async () => {
    const { rt, conn } = makeRuntime();
    const option = (values: string[]) => ({
      id: "reasoning_effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: values[0],
      options: values.map((value) => ({ name: value, value })),
    });
    conn.initialConfigOptions = [option(["low", "high"])];
    conn.nextConfigOptions = [option(["none", "low", "high", "xhigh", "max"])];

    await rt.newSession({ cwd: "/tmp" });
    expect(rt.getConfigSelectValues("reasoning_effort")).toEqual(["low", "high"]);

    await rt.setConfigOption("reasoning_effort", "high");
    expect(rt.getConfigSelectValues("reasoning_effort")).toEqual([
      "none",
      "low",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

type CacheFlowSettlement<T> = { ok: true; value: T } | { ok: false; error: unknown };

function retainCacheFlow<T>(job: Promise<T>): Promise<CacheFlowSettlement<T>> {
  return job.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

async function cacheFlowWithin<T>(job: Promise<T>, deadline: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([job, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`cache-flow ${phase} did not settle`)), Math.max(0, deadline - Date.now()));
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function cacheFlowOptions(model: string, effort: string): SessionConfigOption[] {
  return [
    { id: "model", name: "Model", type: "select", currentValue: model, options: [
      { value: "fixture-model-before", name: "Before" },
      { value: "fixture-model-requested", name: "Requested" },
    ] },
    { id: "thought_level", name: "Thought level", type: "select", currentValue: effort, options: [
      { value: "medium", name: "Medium" }, { value: "high", name: "High" },
    ] },
  ];
}

function cacheFlowPeer(paired: boolean) {
  const initial = cacheFlowOptions("fixture-model-before", "medium");
  const earlier = cacheFlowOptions("fixture-model-requested", "medium");
  const final = cacheFlowOptions("fixture-model-requested", "high");
  type Request = { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> };
  const requests: Request[] = [];
  const chunks: Array<{ frames: unknown[]; bytes: Buffer; accepted: boolean }> = [];
  const peerErrors: unknown[] = [];
  const stdout = new PassThrough(), stderr = new PassThrough();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const write = (frames: unknown[]) => {
    const bytes = Buffer.from(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n", "utf8");
    chunks.push({ frames, bytes, accepted: stdout.write(bytes) });
  };
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    try {
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line) as Request;
        requests.push(request);
        if (request.method === "session/cancel") continue;
        const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
        switch (request.method) {
          case "initialize":
            write([reply({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} })]);
            break;
          case "session/new":
            write([reply({ sessionId: "cache-flow-owned-session", configOptions: initial })]);
            break;
          case "session/set_config_option":
            if (request.params?.configId === "model") {
              write([reply({ configOptions: earlier })]);
            } else if (request.params?.configId === "thought_level") {
              const ack = reply({ configOptions: final });
              write(paired ? [
                { jsonrpc: "2.0", method: "session/update", params: { sessionId: "cache-flow-owned-session",
                  update: { sessionUpdate: "config_option_update", configOptions: earlier } } },
                ack,
              ] : [ack]);
            } else throw new Error("unexpected synthetic config option");
            break;
          default: throw new Error("unexpected synthetic peer request");
        }
      }
      callback();
    } catch (error) {
      peerErrors.push(error);
      callback(error instanceof Error ? error : new Error("synthetic peer write failed", { cause: error }));
    }
  } });
  const completion = retainCacheFlow(finished(stdin, { cleanup: true }));
  const childEvents = new EventEmitter();
  const child = Object.assign(childEvents, {
    stdin, stdout, stderr, pid: undefined, killed: false,
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill() {
      if (!this.killed) {
        this.killed = true;
        this.exitCode = 0;
        stdout.end(); stderr.end();
        childEvents.emit("exit", 0, null);
      }
      return true;
    },
  });
  return { child, requests, chunks, earlier, peerErrors, completion,
    async close() {
      try {
        if (!stdin.writableEnded) stdin.end();
        child.kill();
        const result = await completion;
        if (!result.ok) throw result.error;
      } finally {
        stdin.destroy(); stdout.destroy(); stderr.destroy();
      }
    },
  };
}

async function runCacheFlowCase(paired: boolean) {
  const peer = cacheFlowPeer(paired);
  const { logger } = makeLogger();
  let spawns = 0;
  const profile = { id: "agy-acp", defaultModel: "fixture-model-before" } as unknown as AgentProfile;
  const descriptor: CatalogEffort = { mechanism: "configOption", configId: "thought_level",
    choices: [{ id: "medium", raw: "medium" }, { id: "high", raw: "high" }], selectionDefault: "medium" };
  const runtime = new AgentRuntime({ profile, logger, effortDescriptor: descriptor,
    spawnFn: () => { spawns++; return peer.child as never; } });
  const readback = () => ({ model: runtime.getConfigCurrentValue("model"), effort: runtime.getConfigCurrentValue("thought_level") });
  type Readback = ReturnType<typeof readback>;
  type Observation = { options: unknown; getters: Readback };
  const configEvents: Observation[] = [];
  const boundaries: string[] = [];
  const observerErrors: unknown[] = [];
  let fulfill!: (value: Observation | undefined) => void;
  const observed = new Promise<Observation | undefined>(resolve => { fulfill = resolve; });
  // This identical observer records synchronously in both cases; it never asserts or awaits.
  runtime.onEvent(event => {
    if (event.kind !== "config-options") return;
    try {
      const observation = { options: event.options, getters: readback() };
      configEvents.push(observation);
      boundaries.push("config-options");
      fulfill(observation);
    } catch (error) {
      observerErrors.push(error);
      fulfill(undefined);
    }
  });
  let atReturn: Readback | undefined, afterBoth: Readback | undefined;
  const originals: Array<{ phase: string; result: Promise<CacheFlowSettlement<unknown>> }> = [];
  function own<T>(phase: string, job: Promise<T>): Promise<T> {
    originals.push({ phase, result: retainCacheFlow(job) });
    return job;
  }
  let primary: { error: unknown } | undefined;
  const cleanupOutcomes: Array<{ phase: string; error: unknown }> = [];
  const bodyDeadline = Date.now() + 1_000;
  const body = retainCacheFlow((async () => {
    await own("start", runtime.start());
    const info = await own("new-session", runtime.newSession({ cwd: "/tmp", model: "fixture-model-requested",
      effort: "high", strictModel: true }));
    atReturn = readback();
    boundaries.push("newSession-return");
    const event = paired ? await observed : undefined;
    afterBoth = readback();
    boundaries.push(paired ? "return-and-event-joined" : "setter-only-return");
    if (observerErrors.length) throw observerErrors[0];
    if (paired && !event) throw new Error("paired config-options evidence was not observed");

    expect(info.sessionId).toBe("cache-flow-owned-session");
    expect(spawns).toBe(1);
    expect(peer.requests.map(request => request.method)).toEqual([
      "initialize", "session/new", "session/set_config_option", "session/set_config_option",
    ]);
    expect(peer.requests.slice(2).map(request => request.params)).toEqual([
      { sessionId: "cache-flow-owned-session", configId: "model", value: "fixture-model-requested" },
      { sessionId: "cache-flow-owned-session", configId: "thought_level", value: "high" },
    ]);
    expect(new Set(peer.requests.map(request => `${typeof request.id}:${request.id}`)).size).toBe(4);
    for (const request of peer.requests) expect(["string", "number"]).toContain(typeof request.id);
    expect(peer.chunks.map(chunk => chunk.frames.length)).toEqual(paired ? [1, 1, 1, 2] : [1, 1, 1, 1]);
    expect(peer.chunks.map(chunk => (chunk.frames.at(-1) as { id: unknown }).id)).toEqual(peer.requests.map(request => request.id));
    const last = peer.chunks[3]!;
    expect(last.bytes.toString("utf8").split("\n").filter(Boolean)).toHaveLength(paired ? 2 : 1);
    const ack = last.frames.at(-1) as { jsonrpc: string; id: unknown; result: { configOptions: SessionConfigOption[] } };
    expect(ack.jsonrpc).toBe("2.0");
    expect(ack.id).toBe(peer.requests[3]!.id);
    expect(ack.result.configOptions.map(option => [option.id, option.currentValue])).toEqual([
      ["model", "fixture-model-requested"], ["thought_level", "high"],
    ]);
    if (paired) {
      expect(last.frames[0]).toMatchObject({ jsonrpc: "2.0", method: "session/update",
        params: { sessionId: "cache-flow-owned-session", update: { sessionUpdate: "config_option_update" } } });
      expect(configEvents).toHaveLength(1);
      expect(event!.options).toEqual([
        { id: "model", name: "Model", type: "select", currentValue: "fixture-model-requested", options: [
          { value: "fixture-model-before", name: "Before" }, { value: "fixture-model-requested", name: "Requested" },
        ] },
        { id: "thought_level", name: "Thought level", type: "select", currentValue: "medium", options: [
          { value: "medium", name: "Medium" }, { value: "high", name: "High" },
        ] },
      ]);
      // Desired values apply after BOTH boundaries. Callback-time getters are diagnostic.
      expect(afterBoth.model).toBe("fixture-model-requested");
      expect(afterBoth.effort).toBe("high");
    } else {
      expect(configEvents).toEqual([]);
      expect(atReturn.model).toBe("fixture-model-requested");
      expect(atReturn.effort).toBe("high");
    }
  })());
  try {
    const result = await cacheFlowWithin(Promise.race([body, peer.completion.then(result => {
      if (!result.ok) throw result.error;
      throw new Error("synthetic peer ended before the body settled");
    })]), bodyDeadline, "body");
    if (!result.ok) throw result.error;
  } catch (error) { primary = { error }; }

  // One short closeout window; deadlines bound waits, not dispatch scheduling.
  const cleanupDeadline = Date.now() + 1_000;
  async function attempt(phase: string, work: () => Promise<unknown> | void) {
    try { await cacheFlowWithin(Promise.resolve(work()), cleanupDeadline, phase); }
    catch (error) { cleanupOutcomes.push({ phase, error }); }
  }
  const eventJoin = paired ? attempt("expected-event", async () => {
    if (!await observed) throw new Error("required config-options event absent at closeout");
  }) : Promise.resolve();
  await attempt("runtime-dispose", () => own("runtime-dispose", runtime.dispose()));
  await attempt("peer-close", () => own("peer-close", peer.close()));
  fulfill(undefined); // Also releases a missing-event body on every failure path.
  await Promise.all([eventJoin,
    attempt("body-join", async () => {
      const result = await body;
      if (!result.ok) {
        if (primary === undefined) primary = { error: result.error };
        else if (!Object.is(primary.error, result.error)) throw result.error;
      }
    }),
    attempt("event-join", () => observed),
    attempt("peer-join", async () => { const result = await peer.completion; if (!result.ok) throw result.error; }),
    attempt("runtime-update-join", () => own("runtime-update-join", runtime.idle())),
  ]);
  await Promise.all(originals.map(original => attempt(`original-${original.phase}`, async () => {
    const result = await original.result;
    if (!result.ok && (primary === undefined || !Object.is(primary.error, result.error))) throw result.error;
  })));
  await attempt("owned-peer-retirement", () => {
    expect(peer.child.killed).toBe(true);
    expect(peer.child.exitCode).toBe(0);
    expect(peer.child.stdin.destroyed).toBe(true);
    expect(peer.child.stdout.destroyed).toBe(true);
    expect(peer.child.stderr.destroyed).toBe(true);
    expect(peer.peerErrors).toEqual([]);
    expect(observerErrors).toEqual([]);
  });
  await attempt("observation-report", () => {
    console.info("SELECTOR_CACHE_FLOW_OBSERVATIONS", JSON.stringify({ paired, atReturn, afterBoth, boundaries,
      configEvents, requestMethods: peer.requests.map(request => request.method),
      frameCounts: peer.chunks.map(chunk => chunk.frames.length), cleanupPhases: cleanupOutcomes.map(outcome => outcome.phase) }));
  });
  if (primary !== undefined) {
    if (cleanupOutcomes.length) throw Object.assign(new AggregateError(
      [primary.error, ...cleanupOutcomes.map(outcome => outcome.error)],
      "Cache-flow body and cleanup outcomes", { cause: primary.error },
    ), { cleanupOutcomes });
    throw primary.error;
  }
  if (cleanupOutcomes.length) throw Object.assign(new AggregateError(
    cleanupOutcomes.map(outcome => outcome.error), "Cache-flow cleanup outcomes",
  ), { cleanupOutcomes });
}

describe("AgentRuntime selector cache flow over SDK NDJSON", () => {
  it("retains both requested selectors from setter-only acknowledgements", async () => {
    await runCacheFlowCase(false);
  });

  it("retains both final selectors after an earlier update and final reply share one write", async () => {
    await runCacheFlowCase(true);
  });
});

type CacheFlowControl = "later-full-update" | "backlog-reentrant-rpc";

function cacheFlowControlPeer(control: CacheFlowControl) {
  type Request = { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> };
  const requests: Request[] = [];
  const chunks: Array<{ frames: unknown[]; bytes: Buffer; accepted: boolean }> = [];
  const peerErrors: unknown[] = [];
  const stdout = new PassThrough(), stderr = new PassThrough();
  const decoder = new StringDecoder("utf8");
  let pending = "", effortRequests = 0;
  let consumerRequest: Request | undefined, consumerReplied = false;
  let fulfillConsumer!: (value: Request | undefined) => void;
  const consumerSeen = new Promise<Request | undefined>(resolve => { fulfillConsumer = resolve; });
  const write = (frames: unknown[]) => {
    const bytes = Buffer.from(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n", "utf8");
    chunks.push({ frames, bytes, accepted: stdout.write(bytes) });
  };
  const update = (model: string, effort: string) => ({ jsonrpc: "2.0", method: "session/update",
    params: { sessionId: "cache-flow-control-session", update: {
      sessionUpdate: "config_option_update", configOptions: cacheFlowOptions(model, effort),
    } } });
  const releaseConsumer = () => {
    if (consumerRequest && !consumerReplied) {
      consumerReplied = true;
      write([{ jsonrpc: "2.0", id: consumerRequest.id, result: { phase: "consumer-released" } }]);
    }
  };
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    try {
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line) as Request;
        requests.push(request);
        if (request.method === "session/cancel") continue;
        const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
        switch (request.method) {
          case "initialize":
            write([reply({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} })]);
            break;
          case "session/new":
            write([reply({ sessionId: "cache-flow-control-session",
              configOptions: cacheFlowOptions("fixture-model-before", "medium") })]);
            break;
          case "session/set_config_option":
            if (request.params?.configId === "model") {
              write([reply({ configOptions: cacheFlowOptions("fixture-model-requested", "medium") })]);
            } else if (request.params?.configId === "thought_level") {
              effortRequests++;
              const ack = reply({ configOptions: cacheFlowOptions("fixture-model-requested", "high") });
              if (effortRequests === 1) write([ack]);
              else if (control === "backlog-reentrant-rpc" && effortRequests === 2) {
                write([ack]);
              } else throw new Error("unexpected control effort request");
            } else throw new Error("unexpected control config option");
            break;
          case "_fixture/cache_flow_begin":
            write([reply({ phase: "begin-ack" }), control === "later-full-update"
              ? update("fixture-model-before", "medium")
              : update("fixture-model-requested", "medium")]);
            break;
          case "_fixture/cache_flow_snapshot":
            write([update("fixture-model-before", "medium"), reply({ phase: "snapshot-ack" })]);
            break;
          case "_fixture/cache_flow_consumer":
            if (control !== "backlog-reentrant-rpc" || consumerRequest) {
              throw new Error("unexpected control consumer request");
            }
            consumerRequest = request;
            fulfillConsumer(request);
            break;
          default: throw new Error("unexpected control peer request");
        }
      }
      callback();
    } catch (error) {
      peerErrors.push(error);
      callback(error instanceof Error ? error : new Error("control peer write failed", { cause: error }));
    }
  } });
  const completion = retainCacheFlow(finished(stdin, { cleanup: true }));
  const childEvents = new EventEmitter();
  const child = Object.assign(childEvents, {
    stdin, stdout, stderr, pid: undefined, killed: false,
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill() {
      if (!this.killed) {
        this.killed = true;
        this.exitCode = 0;
        stdout.end(); stderr.end();
        childEvents.emit("exit", 0, null);
      }
      return true;
    },
  });
  return { child, requests, chunks, peerErrors, completion, consumerSeen, releaseConsumer,
    async close() {
      try {
        releaseConsumer();
        fulfillConsumer(undefined);
        if (!stdin.writableEnded) stdin.end();
        child.kill();
        const result = await completion;
        if (!result.ok) throw result.error;
      } finally {
        stdin.destroy(); stdout.destroy(); stderr.destroy();
      }
    },
  };
}

async function runCacheFlowControl(control: CacheFlowControl) {
  const peer = cacheFlowControlPeer(control);
  const { logger } = makeLogger();
  const originals: Array<{ phase: string; result: Promise<CacheFlowSettlement<unknown>> }> = [];
  function own<T>(phase: string, job: Promise<T>): Promise<T> {
    originals.push({ phase, result: retainCacheFlow(job) });
    return job;
  }
  let spawns = 0;
  const profile = { id: "agy-acp", defaultModel: "fixture-model-before" } as unknown as AgentProfile;
  const descriptor: CatalogEffort = { mechanism: "configOption", configId: "thought_level",
    choices: [{ id: "medium", raw: "medium" }, { id: "high", raw: "high" }], selectionDefault: "medium" };
  const runtime = new AgentRuntime({ profile, logger, effortDescriptor: descriptor,
    spawnFn: () => { spawns++; return peer.child as never; } });
  const readback = () => ({ model: runtime.getConfigCurrentValue("model"),
    effort: runtime.getConfigCurrentValue("thought_level") });
  type Observation = { options: unknown; getters: ReturnType<typeof readback> };
  const configEvents: Observation[] = [];
  const boundaries: string[] = [];
  const observerErrors: unknown[] = [];
  let consumerResult: unknown, consumerSettled = false;
  let fulfillEvents!: (value: Observation | undefined) => void;
  const observed = new Promise<Observation | undefined>(resolve => { fulfillEvents = resolve; });
  const expectedEvents = control === "later-full-update" ? 1 : 2;
  runtime.onEvent(event => {
    if (event.kind !== "config-options") return;
    const job = (async () => {
      try {
        const observation = { options: event.options, getters: readback() };
        configEvents.push(observation);
        const ordinal = configEvents.length;
        boundaries.push(`config-${ordinal}-enter`);
        if (control === "backlog-reentrant-rpc" && ordinal === 1) {
          consumerResult = await own("consumer-rpc", runtime.request("_fixture/cache_flow_consumer", {
            sessionId: "cache-flow-control-session",
          }));
          consumerSettled = true;
          boundaries.push("consumer-rpc-return");
        }
        boundaries.push(`config-${ordinal}-exit`);
        if (ordinal === expectedEvents) fulfillEvents(observation);
      } catch (error) {
        observerErrors.push(error);
        fulfillEvents(undefined);
      }
    })();
    return own(`observer-${configEvents.length}`, job);
  });
  let atSelectionReturn: ReturnType<typeof readback> | undefined;
  type BlockedObservation = { getters: ReturnType<typeof readback>; eventCount: number; consumerSettled: boolean };
  let snapshotWhileBlocked: BlockedObservation | undefined, whileBlocked: BlockedObservation | undefined;
  let snapshotReply: unknown;
  let afterDrain: ReturnType<typeof readback> | undefined;
  let primary: { error: unknown } | undefined;
  const cleanupOutcomes: Array<{ phase: string; error: unknown }> = [];
  const bodyDeadline = Date.now() + 1_000;
  const body = retainCacheFlow((async () => {
    await own("start", runtime.start());
    const info = await own("new-session", runtime.newSession({ cwd: "/tmp", model: "fixture-model-requested",
      effort: "high", strictModel: true }));
    atSelectionReturn = readback();
    boundaries.push("newSession-return");
    const begin = await own("begin-rpc", runtime.request("_fixture/cache_flow_begin", {
      sessionId: "cache-flow-control-session",
    }));
    boundaries.push("begin-rpc-return");
    if (control === "backlog-reentrant-rpc") {
      const request = await own("consumer-request-observed", peer.consumerSeen);
      if (!request) throw new Error("control consumer request was not observed");
      snapshotReply = await own("snapshot-rpc", runtime.request("_fixture/cache_flow_snapshot", {
        sessionId: "cache-flow-control-session",
      }));
      snapshotWhileBlocked = { getters: readback(), eventCount: configEvents.length, consumerSettled };
      boundaries.push("snapshot-rpc-return-with-consumer-held");
      await own("backlogged-setter", runtime.setConfigOption("thought_level", "high"));
      whileBlocked = { getters: readback(), eventCount: configEvents.length, consumerSettled };
      boundaries.push("setter-return-with-consumer-held");
      peer.releaseConsumer();
      boundaries.push("consumer-peer-released");
    }
    const lastEvent = await own("expected-events", observed);
    if (observerErrors.length) throw observerErrors[0];
    if (!lastEvent) throw new Error("control config-options evidence was not observed");
    await own("runtime-event-drain", runtime.idle());
    afterDrain = readback();
    boundaries.push("events-and-public-operations-drained");
    if (observerErrors.length) throw observerErrors[0];

    expect(info.sessionId).toBe("cache-flow-control-session");
    expect(spawns).toBe(1);
    expect(atSelectionReturn).toEqual({ model: "fixture-model-requested", effort: "high" });
    expect(begin).toEqual({ phase: "begin-ack" });
    expect(peer.requests.map(request => request.method)).toEqual(control === "later-full-update" ? [
      "initialize", "session/new", "session/set_config_option", "session/set_config_option", "_fixture/cache_flow_begin",
    ] : [
      "initialize", "session/new", "session/set_config_option", "session/set_config_option", "_fixture/cache_flow_begin",
      "_fixture/cache_flow_consumer", "_fixture/cache_flow_snapshot", "session/set_config_option",
    ]);
    expect(peer.requests.slice(2, 4).map(request => request.params)).toEqual([
      { sessionId: "cache-flow-control-session", configId: "model", value: "fixture-model-requested" },
      { sessionId: "cache-flow-control-session", configId: "thought_level", value: "high" },
    ]);
    const responses = peer.chunks.flatMap(chunk => chunk.frames).filter(
      (frame): frame is { id: string | number } => typeof frame === "object" && frame !== null && "id" in frame,
    );
    expect(new Set(peer.requests.map(request => `${typeof request.id}:${request.id}`)).size).toBe(peer.requests.length);
    for (const request of peer.requests) {
      expect(["string", "number"]).toContain(typeof request.id);
      expect(responses.filter(response => typeof response.id === typeof request.id && response.id === request.id)).toHaveLength(1);
    }
    const finalSelectionReply = peer.chunks[3]!.frames[0] as { result: { configOptions: SessionConfigOption[] } };
    expect(finalSelectionReply.result.configOptions.map(option => [option.id, option.currentValue])).toEqual([
      ["model", "fixture-model-requested"], ["thought_level", "high"],
    ]);
    expect(configEvents).toHaveLength(expectedEvents);
    // Independent complete parsed-event literals, not cache-derived expectations.
    const laterOptions = [
      { id: "model", name: "Model", type: "select", currentValue: "fixture-model-before", options: [
        { value: "fixture-model-before", name: "Before" }, { value: "fixture-model-requested", name: "Requested" },
      ] },
      { id: "thought_level", name: "Thought level", type: "select", currentValue: "medium", options: [
        { value: "medium", name: "Medium" }, { value: "high", name: "High" },
      ] },
    ];
    if (control === "later-full-update") {
      expect(configEvents[0]!.options).toEqual(laterOptions);
      expect(afterDrain).toEqual({ model: "fixture-model-before", effort: "medium" });
      expect(peer.chunks.map(chunk => chunk.frames.length)).toEqual([1, 1, 1, 1, 2]);
      expect(peer.chunks[4]!.frames[0]).toMatchObject({ id: peer.requests[4]!.id, result: { phase: "begin-ack" } });
      expect(peer.chunks[4]!.frames[1]).toMatchObject({ method: "session/update",
        params: { update: { sessionUpdate: "config_option_update", configOptions: laterOptions } } });
      expect(boundaries.indexOf("newSession-return")).toBeLessThan(boundaries.indexOf("config-1-enter"));
    } else {
      expect(configEvents[0]!.options).toEqual([
        { id: "model", name: "Model", type: "select", currentValue: "fixture-model-requested", options: [
          { value: "fixture-model-before", name: "Before" }, { value: "fixture-model-requested", name: "Requested" },
        ] },
        { id: "thought_level", name: "Thought level", type: "select", currentValue: "medium", options: [
          { value: "medium", name: "Medium" }, { value: "high", name: "High" },
        ] },
      ]);
      expect(configEvents[1]!.options).toEqual(laterOptions);
      expect(snapshotReply).toEqual({ phase: "snapshot-ack" });
      expect(snapshotWhileBlocked).toEqual({ getters: { model: "fixture-model-before", effort: "medium" },
        eventCount: 1, consumerSettled: false });
      expect(whileBlocked).toEqual({ getters: { model: "fixture-model-requested", effort: "high" },
        eventCount: 1, consumerSettled: false });
      expect(consumerResult).toEqual({ phase: "consumer-released" });
      expect(consumerSettled).toBe(true);
      expect(afterDrain).toEqual({ model: "fixture-model-requested", effort: "high" });
      expect(peer.requests[5]!.params).toEqual({ sessionId: "cache-flow-control-session" });
      expect(peer.requests[6]!.params).toEqual({ sessionId: "cache-flow-control-session" });
      expect(peer.requests[7]!.params).toEqual({ sessionId: "cache-flow-control-session", configId: "thought_level", value: "high" });
      expect(peer.chunks.map(chunk => chunk.frames.length)).toEqual([1, 1, 1, 1, 2, 2, 1, 1]);
      expect(peer.chunks[5]!.frames[0]).toMatchObject({ method: "session/update",
        params: { update: { sessionUpdate: "config_option_update", configOptions: laterOptions } } });
      expect(peer.chunks[5]!.frames[1]).toMatchObject({ id: peer.requests[6]!.id, result: { phase: "snapshot-ack" } });
      expect(peer.chunks[6]!.frames[0]).toMatchObject({ id: peer.requests[7]!.id,
        result: { configOptions: [
          { id: "model", currentValue: "fixture-model-requested" }, { id: "thought_level", currentValue: "high" },
        ] } });
      expect(boundaries.filter(boundary => boundary.startsWith("config-"))).toEqual([
        "config-1-enter", "config-1-exit", "config-2-enter", "config-2-exit",
      ]);
      expect(boundaries.indexOf("setter-return-with-consumer-held")).toBeLessThan(boundaries.indexOf("consumer-rpc-return"));
      expect(boundaries.indexOf("consumer-peer-released")).toBeLessThan(boundaries.indexOf("consumer-rpc-return"));
      expect(boundaries.indexOf("consumer-rpc-return")).toBeLessThan(boundaries.indexOf("config-2-enter"));
    }
  })());
  try {
    const result = await cacheFlowWithin(Promise.race([body, peer.completion.then(result => {
      if (!result.ok) throw result.error;
      throw new Error("control peer ended before the body settled");
    })]), bodyDeadline, "control-body");
    if (!result.ok) throw result.error;
  } catch (error) { primary = { error }; }

  const cleanupDeadline = Date.now() + 1_000;
  async function attempt(phase: string, work: () => Promise<unknown> | void) {
    try { await cacheFlowWithin(Promise.resolve(work()), cleanupDeadline, phase); }
    catch (error) { cleanupOutcomes.push({ phase, error }); }
  }
  await attempt("consumer-release", () => peer.releaseConsumer());
  await attempt("runtime-dispose", () => own("runtime-dispose", runtime.dispose()));
  await attempt("peer-close", () => own("peer-close", peer.close()));
  fulfillEvents(undefined);
  await Promise.all([
    attempt("body-join", async () => {
      const result = await body;
      if (!result.ok) {
        if (primary === undefined) primary = { error: result.error };
        else if (!Object.is(primary.error, result.error)) throw result.error;
      }
    }),
    attempt("event-join", () => observed),
    attempt("peer-consumer-join", () => peer.consumerSeen),
    attempt("peer-join", async () => { const result = await peer.completion; if (!result.ok) throw result.error; }),
    attempt("runtime-update-join", () => own("runtime-update-join", runtime.idle())),
  ]);
  await Promise.all(originals.map(original => attempt(`original-${original.phase}`, async () => {
    const result = await original.result;
    if (!result.ok && (primary === undefined || !Object.is(primary.error, result.error))) throw result.error;
  })));
  await Promise.all(observerErrors.map((error, index) => attempt(`observer-error-${index}`, () => {
    if (primary === undefined || !Object.is(primary.error, error)) throw error;
  })));
  await attempt("owned-peer-retirement", () => {
    expect(peer.child.killed).toBe(true);
    expect(peer.child.exitCode).toBe(0);
    expect(peer.child.stdin.destroyed).toBe(true);
    expect(peer.child.stdout.destroyed).toBe(true);
    expect(peer.child.stderr.destroyed).toBe(true);
    if (peer.peerErrors.length) throw peer.peerErrors[0];
  });
  await attempt("observation-report", () => {
    console.info("SELECTOR_CACHE_FLOW_CONTROL_OBSERVATIONS", JSON.stringify({ control, atSelectionReturn,
      snapshotWhileBlocked, snapshotReply, whileBlocked, afterDrain, configEvents, boundaries, consumerSettled, consumerResult,
      requestMethods: peer.requests.map(request => request.method),
      frameCounts: peer.chunks.map(chunk => chunk.frames.length), cleanupPhases: cleanupOutcomes.map(outcome => outcome.phase) }));
  });
  if (primary !== undefined) {
    if (cleanupOutcomes.length) throw Object.assign(new AggregateError(
      [primary.error, ...cleanupOutcomes.map(outcome => outcome.error)],
      "Cache-flow control body and cleanup outcomes", { cause: primary.error },
    ), { cleanupOutcomes });
    throw primary.error;
  }
  if (cleanupOutcomes.length) throw Object.assign(new AggregateError(
    cleanupOutcomes.map(outcome => outcome.error), "Cache-flow control cleanup outcomes",
  ), { cleanupOutcomes });
}

describe("AgentRuntime live snapshot intake controls over SDK NDJSON", () => {
  it("consumes a later complete update changing both selectors after the final selection ACK", async () => {
    await runCacheFlowControl("later-full-update");
  });

  it("keeps live cache and ordinary RPC replies progressing behind a reentrant event consumer (CF-FV1)", async () => {
    await runCacheFlowControl("backlog-reentrant-rpc");
  });
});
