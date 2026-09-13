import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, type McpServer } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import { buildProjectMcpServers } from "../packages/core/src/mcp.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

let dir: string;
const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const logger = { ...logs, child() { return this; } } as unknown as Logger;
const token = "synthetic-project-secret-$&-${DO_NOT_EXPAND}";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-mcp-env-"));
  vi.stubEnv("SEAM_TEST_MCP_TOKEN", token);
  vi.stubEnv("SEAM_TEST_MCP_MISSING", undefined);
  vi.stubEnv("SEAM_TEST_MCP_EMPTY", "");
  vi.clearAllMocks();
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });
function write(servers: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
}
const sentry = {
  type: "http", url: "https://mcp.example.invalid/mcp/test-org",
  headers: { Authorization: "Sentry-Bearer ${SEAM_TEST_MCP_TOKEN}" },
};
const expectedSentry = {
  name: "sentry", type: "http", url: "https://mcp.example.invalid/mcp/test-org",
  headers: [{ name: "Authorization", value: "Sentry-Bearer synthetic-project-secret-$&-${DO_NOT_EXPAND}" }],
};
function read() { return buildProjectMcpServers(dir, logger, new Set()); }

describe("project MCP environment references", () => {
  it("resolves the real header shape once, without persisting or logging the credential", () => {
    write({ sentry });
    const before = fs.readFileSync(path.join(dir, ".mcp.json"));
    expect(read()).toEqual([expectedSentry]);
    expect(fs.readFileSync(path.join(dir, ".mcp.json"))).toEqual(before);
    expect(JSON.stringify([logs.info.mock.calls, logs.warn.mock.calls])).not.toContain(token);
  });

  it("expands URL, command, arguments and env values, not names or bare shell expressions", () => {
    vi.stubEnv("SEAM_TEST_MCP_HOST", "mcp.example.invalid");
    vi.stubEnv("SEAM_TEST_MCP_COMMAND", "/opt/example/mcp");
    write({
      web: { url: "https://${SEAM_TEST_MCP_HOST}/mcp", headers: { "X-Literal": "$BARE $(no-shell)" } },
      stdio: { command: "${SEAM_TEST_MCP_COMMAND}", args: ["--token=${SEAM_TEST_MCP_TOKEN}", 7], env: { KEY: "${SEAM_TEST_MCP_TOKEN}", BAD: 7 } },
    });
    expect(read()).toEqual([
      { name: "web", type: "http", url: "https://mcp.example.invalid/mcp", headers: [{ name: "X-Literal", value: "$BARE $(no-shell)" }] },
      { name: "stdio", command: "/opt/example/mcp", args: ["--token=synthetic-project-secret-$&-${DO_NOT_EXPAND}"], env: [{ name: "KEY", value: token }] },
    ]);
  });

  it("supports explicit fallback and preserves deliberately empty values", () => {
    write({ web: { url: "https://example.invalid", headers: {
      fallback: "${SEAM_TEST_MCP_MISSING:-local}",
      present: "${SEAM_TEST_MCP_TOKEN:-unused}",
      empty: "${SEAM_TEST_MCP_EMPTY}",
      emptyFallback: "${SEAM_TEST_MCP_EMPTY:-fallback}",
    } } });
    expect(read()[0]).toMatchObject({ headers: [
      { name: "fallback", value: "local" }, { name: "present", value: token },
      { name: "empty", value: "" }, { name: "emptyFallback", value: "" },
    ] });
  });

  it.each(["url", "headers", "command", "args", "env"])("skips only the server with an unset variable in %s", (field) => {
    const missing = "${SEAM_TEST_MCP_MISSING}";
    const broken = field === "url" || field === "headers"
      ? { url: field === "url" ? missing : "https://example.invalid", headers: { Authorization: `\${SEAM_TEST_MCP_TOKEN} ${missing}` } }
      : { command: field === "command" ? missing : "node", args: field === "args" ? [missing] : [], env: field === "env" ? { KEY: missing } : {} };
    write({ broken, sentry });
    expect(read()).toEqual([expectedSentry]);
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "broken", missingVariables: ["SEAM_TEST_MCP_MISSING"] }),
      "project .mcp.json: unresolved environment variables; skipping this server",
    );
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(token);
  });

  it("reserved servers stay skipped without resolving their configuration", () => {
    write({ reserved: { url: "${SEAM_TEST_MCP_MISSING}" }, sentry });
    expect(buildProjectMcpServers(dir, logger, new Set(["reserved"]))).toEqual([expectedSentry]);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0]![1]).toContain("reserved");
  });

  it("does not mistake inherited object methods for environment values", () => {
    const key: string = "toString";
    const previous = Object.hasOwn(process.env, key) ? process.env[key] : undefined;
    delete process.env[key];
    try {
      write({ web: { url: "https://example.invalid", headers: { "X-Test": "${toString:-fallback}" } } });
      expect(read()[0]).toMatchObject({ headers: [{ name: "X-Test", value: "fallback" }] });
    } finally {
      if (previous !== undefined) process.env[key] = previous;
    }
  });

  it("does not expose config content through JSON parse diagnostics", () => {
    fs.writeFileSync(path.join(dir, ".mcp.json"), "mcp-key");
    expect(read()).toEqual([]);
    expect(logs.warn).toHaveBeenCalled();
    expect(inspect(logs.warn.mock.calls, { depth: 5 })).not.toContain("mcp-key");
  });

  it("re-reads environment and project scope on each build, without cross-project leakage", () => {
    write({ sentry });
    expect(read()).toEqual([expectedSentry]);
    vi.stubEnv("SEAM_TEST_MCP_TOKEN", "rotated-synthetic");
    expect(read()[0]).toMatchObject({ headers: [{ name: "Authorization", value: "Sentry-Bearer rotated-synthetic" }] });
    const other = fs.mkdtempSync(path.join(dir, "other-"));
    expect(buildProjectMcpServers(other, logger, new Set())).toEqual([]);
  });
});

describe("production router and ACP MCP delivery", () => {
  it("delivers resolved headers on new and resumed sessions; missing server does not prevent either", async () => {
    write({ sentry, broken: { url: "https://example.invalid", headers: { Authorization: "${SEAM_TEST_MCP_MISSING}" } } });
    const seen: Array<{ mode: string; servers: McpServer[] }> = [];
    const profile = {
      id: "codex", defaultModel: "default", effort: { mechanism: "none", levels: [] },
      spawn() {
        const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
        const child = Object.assign(new EventEmitter(), {
          stdin, stdout, stderr, pid: undefined, killed: false,
          kill() { this.killed = true; stdin.end(); stdout.end(); stderr.end(); child.emit("exit", 0, null); return true; },
        });
        agent({ name: "project-mcp-fixture" })
          .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
          .onRequest(methods.agent.session.new, ({ params }) => { seen.push({ mode: "new", servers: params.mcpServers }); return { sessionId: "kept-conversation" }; })
          .onRequest(methods.agent.session.load, ({ params }) => { seen.push({ mode: "load", servers: params.mcpServers }); return {}; })
          .connect(ndJsonStream(Writable.toWeb(stdout) as WritableStream<Uint8Array>, Readable.toWeb(stdin) as ReadableStream<Uint8Array>));
        return child;
      },
    } as unknown as AgentProfile;
    const store = new SessionStore(path.join(dir, "test.db"));
    const router = new SessionRouter({ logger, store, profiles: [profile], modelCatalog: fixtureModelCatalog([profile]), defaultAgentId: "codex", defaultModel: "default", defaultCwd: dir });
    const record = { id: "discord:test", platform: "discord", channelRef: "test", parentRef: "parent", agentId: "codex", acpSessionId: "", repoPath: dir, configJson: "{}", createdUtc: "2026-01-01T00:00:00Z", updatedUtc: "2026-01-01T00:00:00Z" };
    store.upsert(record);
    try {
      await router.getOrStartRuntime(record);
      await router.disposeAll();
      const saved = store.get(record.id)!;
      expect(saved.acpSessionId).toBe("kept-conversation");
      await router.getOrStartRuntime(saved);
      expect(seen).toEqual([{ mode: "new", servers: [expectedSentry] }, { mode: "load", servers: [expectedSentry] }]);
      expect(store.get(record.id)!.acpSessionId).toBe("kept-conversation");
    } finally { await router.disposeAll(); store.close(); }
  });
});
