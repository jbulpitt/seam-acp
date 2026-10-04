import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createResumeRecorder } from "../packages/bridge/src/adapter-child-resume.js";
import type { AdapterChildBootstrap } from "../packages/bridge/src/adapter-child-protocol.js";

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
