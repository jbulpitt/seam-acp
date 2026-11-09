import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createResumeRecorder } from "../packages/bridge/src/adapter-child-resume.js";
import type { AdapterChildBootstrap } from "../packages/bridge/src/adapter-child-protocol.js";
import type { EffortDescriptor } from "../packages/adapters/src/agent-profile.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("native Codex resume mode acknowledgement", () => {
  it("records only accepted modes and updates an in-flight resume record", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-mode-resume-"));
    roots.push(root);
    const file = path.join(root, "5.json");
    const bootstrap: AdapterChildBootstrap = { v: 1, type: "bootstrap", slot: 5,
      copilotCmd: "unused", localCwd: root, config: { agentId: "codex", cwd: root } };
    const recorder = createResumeRecorder(file, bootstrap);
    const input = (id: number, method: string, params: unknown) => recorder.observeInput(JSON.stringify({ id, method, params }));
    const output = (message: unknown) => recorder.observeOutput(JSON.stringify(message));
    const recovery = { submissionId: "sub-5", acpSessionId: "s1", continuation: "continue", originalRequestId: 7 };
    const mode = () => JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(file, "utf8")).initialStdinBase64, "base64").toString()).resume.modeId;
    input(1, "initialize", { protocolVersion: 1 });
    input(2, "session/new", { cwd: root, mcpServers: [] });
    output({ id: 2, result: { sessionId: "s1", modes: { currentModeId: "agent" } } });
    recorder.record(recovery);
    expect(mode()).toBe("agent");
    input(3, "session/set_mode", { sessionId: "s1", modeId: "agent-full-access" });
    output({ id: 3, error: { code: -32000, message: "refused" } });
    recorder.record(recovery);
    expect(mode()).toBe("agent");
    input(4, "session/set_mode", { sessionId: "s1", modeId: "agent-full-access" });
    output({ id: 4, result: {} });
    recorder.record(recovery);
    expect(mode()).toBe("agent-full-access");
    input(5, "session/set_config_option", { sessionId: "s1", configId: "mode", value: "agent" });
    output({ id: 5, result: {} });
    recorder.record(recovery);
    expect(mode()).toBe("agent");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    recorder.clear();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("acknowledged model and effort on host resume", () => {
  function fixture(effort: EffortDescriptor = { mechanism: "configOption", configId: "thought_level", levels: [] }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-selection-resume-"));
    roots.push(root);
    const file = path.join(root, "5.json");
    const bootstrap: AdapterChildBootstrap = { v: 1, type: "bootstrap", slot: 5,
      copilotCmd: "unused", localCwd: root, config: { agentId: "agy", cwd: root } };
    const recorder = createResumeRecorder(file, bootstrap, effort);
    const input = (id: number, method: string, params: unknown) => recorder.observeInput(JSON.stringify({ id, method, params }));
    const output = (message: unknown) => recorder.observeOutput(JSON.stringify(message));
    const recovery = { submissionId: "sub-5", acpSessionId: "s1", continuation: "continue", originalRequestId: 7 };
    const saved = () => {
      recorder.record(recovery);
      return JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(file, "utf8")).initialStdinBase64, "base64").toString()).resume;
    };
    input(1, "initialize", { protocolVersion: 1 });
    input(2, "session/new", { cwd: root, mcpServers: [] });
    return { input, output, saved };
  }
  const options = (model: string, effort?: string) => [
    { id: "model", category: "model", type: "select", currentValue: model },
    ...(effort ? [{ id: "thought_level", type: "select", currentValue: effort }] : []),
  ];

  it("saves readbacks, not requested, pending or rejected values, while the turn is in flight", () => {
    const { input, output, saved } = fixture();
    output({ id: 2, result: { sessionId: "s1", configOptions: options("flash", "low") } });
    expect(saved().configOptions).toEqual({ model: { configId: "model", value: "flash" }, effort: { configId: "thought_level", value: "low" } });
    input(3, "session/set_config_option", { sessionId: "s1", configId: "model", value: "requested" });
    output({ id: 3, result: { configOptions: options("accepted", "high") } });
    input(4, "session/set_config_option", { sessionId: "s1", configId: "thought_level", value: "pending" });
    input(5, "session/set_config_option", { sessionId: "s1", configId: "thought_level", value: "rejected" });
    output({ id: 5, error: { code: -32602, message: "not supported" } });
    expect(saved().configOptions).toEqual({ model: { configId: "model", value: "accepted" }, effort: { configId: "thought_level", value: "high" } });
    output({ id: 4, result: {} });
    expect(saved().configOptions.effort.value).toBe("high");
  });

  it("drops the previous model's effort when the accepted snapshot has no selector", () => {
    const { input, output, saved } = fixture();
    output({ id: 2, result: { sessionId: "s1", configOptions: options("flash", "high") } });
    saved();
    input(3, "session/set_config_option", { sessionId: "s1", configId: "model", value: "fixed" });
    output({ id: 3, result: { configOptions: options("fixed") } });
    expect(saved().configOptions).toEqual({ model: { configId: "model", value: "fixed" } });
  });

  it("does not attach another session's selections to the interrupted session", () => {
    const { input, output, saved } = fixture();
    output({ id: 2, result: { sessionId: "s1", configOptions: options("flash", "high") } });
    saved();
    input(3, "session/load", { sessionId: "s2", cwd: "/fixture", mcpServers: [] });
    output({ id: 3, result: { configOptions: options("other", "low") } });
    expect(saved().configOptions).toBeUndefined();
  });

  it("leaves legacy model-baked resume records unchanged", () => {
    const { output, saved } = fixture({ mechanism: "modelBaked", levels: [] });
    output({ id: 2, result: { sessionId: "s1", configOptions: options("flash-high", "high") } });
    expect(saved().configOptions).toBeUndefined();
  });
});
