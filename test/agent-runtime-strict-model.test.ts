import { describe, it, expect } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { classifyCodexError, type AgentProfile } from "@seam/adapters";
import type { Logger } from "../packages/core/src/lib/logger.js";

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
