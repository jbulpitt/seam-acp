import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { AgentAdapter, AgentProfile } from "@seam/adapters";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type McpServer,
} from "@agentclientprotocol/sdk";
import {
  dispatchBridgeRpc,
  type RpcContext,
  type SlotSpawnConfig,
} from "../packages/bridge/src/rpc.js";
import {
  spawnRemoteSlot,
  type MuxHandle,
} from "../packages/core/src/core/remote-spawn.js";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { BridgeMcpInputRewriter } from "../packages/bridge/src/mcp-injection.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

describe("remote project MCP ownership (#417)", () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-project-mcp-"));
    project = path.join(root, "remote-layout", "repo");
    fs.mkdirSync(project, { recursive: true });
    vi.stubEnv("LANGFUSE_MCP_AUTH", "synthetic-remote-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function child(slot = 7) {
    return Object.assign(new EventEmitter(), {
      slot,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill() { this.killed = true; return true; },
    }) as unknown as ReturnType<MuxHandle["spawn"]>;
  }

  function context(configureSlot: (slot: number, cfg: SlotSpawnConfig) => void): RpcContext {
    return {
      adapters: new Map<string, AgentAdapter>(),
      workspaceRoot: root,
      cwd: root,
      devMode: false,
      configureSlot,
    };
  }

  it("loads host-owned config and delivers it through the real ACP session/new path", async () => {
    fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({
      mcpServers: {
        langfuse: {
          url: "https://langfuse.example/mcp",
          headers: { Authorization: "Bearer ${LANGFUSE_MCP_AUTH}" },
        },
        "stdio-helper": {
          command: "node",
          args: ["helper-mcp.mjs"],
          env: { LANGFUSE_MCP_AUTH: "${LANGFUSE_MCP_AUTH}" },
        },
      },
    }));
    const configured: SlotSpawnConfig[] = [];
    const rpcReplies: unknown[] = [];
    let released = false;
    let delivered: McpServer[] | undefined;
    const spawned = child();
    const bridgeInput = new PassThrough();
    let rewriter: BridgeMcpInputRewriter | undefined;
    spawned.stdin.on("data", (chunk: Buffer) => {
      rewriter ??= new BridgeMcpInputRewriter(configured[0]?.mcpServers ?? []);
      const output = rewriter.push(chunk.toString("utf8"));
      if (output) bridgeInput.write(output);
    });
    agent({ name: "remote-project-mcp-fixture" })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
      }))
      .onRequest(methods.agent.session.new, ({ params }) => {
        delivered = params.mcpServers;
        return { sessionId: "remote-project-session" };
      })
      .connect(ndJsonStream(
        Writable.toWeb(spawned.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(bridgeInput) as ReadableStream<Uint8Array>
      ));
    const mcpServers: McpServer[] = [{
      name: "seam-mcp",
      type: "http",
      url: "https://controller.example/mcp",
      headers: [],
    }];
    const mux: MuxHandle = {
      spawn: () => spawned,
      rpc: async (method, params, opts) => {
        const reply = await dispatchBridgeRpc(
          method,
          params,
          opts?.agentId,
          context((_slot, cfg) => configured.push(cfg))
        );
        rpcReplies.push(reply);
        return reply;
      },
      releaseStdin: () => { released = true; },
    };
    const profile = {
      id: "codex",
      displayName: "Codex",
      defaultModel: "default",
      mcpServersAtSpawn: false,
    } as AgentProfile;
    const runtime = new AgentRuntime({
      profile,
      logger: silent,
      mcpServers,
      spawnFn: () => spawnRemoteSlot(mux, {
        agentId: "codex",
        cwd: project,
        mcpServers,
      }),
    });

    try {
      await runtime.start();
      await runtime.newSession({ cwd: project });
    } finally {
      await runtime.dispose();
    }

    expect(released).toBe(true);
    expect(configured).toHaveLength(1);
    expect(configured[0]?.cwd).toBe(project);
    expect(mcpServers).toEqual([
      expect.objectContaining({ name: "seam-mcp", type: "http" }),
    ]);
    expect(configured[0]?.mcpServers).toEqual([
      expect.objectContaining({ name: "seam-mcp", type: "http" }),
      {
        name: "langfuse",
        type: "http",
        url: "https://langfuse.example/mcp",
        headers: [{ name: "Authorization", value: "Bearer synthetic-remote-secret" }],
      },
      {
        name: "stdio-helper",
        command: "node",
        args: ["helper-mcp.mjs"],
        env: [{ name: "LANGFUSE_MCP_AUTH", value: "synthetic-remote-secret" }],
      },
    ]);
    expect(delivered).toEqual(configured[0]?.mcpServers);
    expect(rpcReplies).toEqual([{
      ok: true,
      slot: 7,
      projectMcpInjection: true,
      projectMcpServers: ["langfuse", "stdio-helper"],
    }]);
    expect(JSON.stringify(rpcReplies)).not.toContain("synthetic-remote-secret");
  });

  it("refuses controller-transported stdio config with an actionable message", async () => {
    const configureSlot = vi.fn();
    await expect(dispatchBridgeRpc("spawn", {
      slot: 1,
      cwd: project,
      agentId: "codex",
      mcpServers: [{
        name: "langfuse",
        command: "node",
        args: [],
        env: [{ name: "LANGFUSE_MCP_AUTH", value: "must-not-cross" }],
      }],
    }, "codex", context(configureSlot))).rejects.toThrow(
      'remote spawn refuses transported stdio MCP server "langfuse"; ' +
      "configure it in the bridge host project's .mcp.json instead"
    );
    expect(configureSlot).not.toHaveBeenCalled();
  });

  it("enriches fragmented session/load frames without shadowing transported servers", () => {
    const rewriter = new BridgeMcpInputRewriter([
      { name: "seam-mcp", type: "http", url: "https://must-not-win", headers: [] },
      { name: "stdio-helper", command: "node", args: ["helper.mjs"], env: [] },
    ]);
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "session/load",
      params: {
        sessionId: "kept",
        cwd: project,
        mcpServers: [{
          name: "seam-mcp",
          type: "http",
          url: "https://controller.example/mcp",
          headers: [],
        }],
      },
    });

    expect(rewriter.push(request.slice(0, 17))).toBe("");
    const output = rewriter.push(`${request.slice(17)}\n`);
    const message = JSON.parse(output) as {
      params: { mcpServers: McpServer[] };
    };
    expect(message.params.mcpServers).toEqual([
      expect.objectContaining({ name: "seam-mcp", url: "https://controller.example/mcp" }),
      expect.objectContaining({ name: "stdio-helper", command: "node" }),
    ]);
  });
});
