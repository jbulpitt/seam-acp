/**
 * Bridge-side RPC dispatcher. Calls `@seam/adapters` methods; never imports
 * discord.js. RPC methods must be on the bridge allow-list.
 */
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentAdapter } from "@seam/adapters";
import {
  isAllowedRpcMethod,
  isHostRpcMethod,
  invokeAdapterRpc,
  ATTACH_MAX_BYTES,
  readProjectMcpServers,
  isModelFallbackPlan,
  isRemoteRung1Policy,
  type ModelFallbackPlan,
  type RemoteRung1Policy,
} from "@seam/adapters";

const HOST_EXEC_DEFAULT_TIMEOUT_MS = 30_000;
const HOST_EXEC_MAX_TIMEOUT_MS = 15 * 60_000;
const HOST_EXEC_OUTPUT_MAX_BYTES = 64 * 1024;
const SESSION_CWD_METHODS = new Set([
  "listSessions",
  "getTranscript",
  "getUsage",
  "usage",
  "cloneSession",
  "deleteSession",
]);

export interface SlotSpawnConfig {
  agentId?: string;
  cwd?: string;
  /** The controller's cwd, when this host lacks it and runs in `cwd` instead. */
  requestedCwd?: string;
  env?: Record<string, string>;
  mcpServers?: McpServer[];
  model?: string;
  modelFallbacks?: ModelFallbackPlan;
  effort?: string;
  rung1Recovery?: RemoteRung1Policy;
}

export interface RpcContext {
  adapters: Map<string, AgentAdapter>;
  workspaceRoot: string;
  cwd: string;
  configureSlot?: (slot: number, cfg: SlotSpawnConfig) => void;
}

function asRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function requireAgent(ctx: RpcContext, agentId: string | undefined): AgentAdapter {
  const id = agentId || [...ctx.adapters.keys()][0];
  if (!id) throw new Error("no agentId and no adapters registered");
  const adapter = ctx.adapters.get(id);
  if (!adapter) throw new Error(`unknown agentId: ${id}`);
  return adapter;
}

const projectMcpLogger = {
  info(fields: Record<string, unknown>, message: string) {
    console.error(`[bridge] ${message}`, fields);
  },
  warn(fields: Record<string, unknown>, message: string) {
    console.error(`[bridge] ${message}`, fields);
  },
};

/**
 * The controller may transport network MCP endpoints, but never stdio command
 * or environment payloads. Project stdio configuration belongs to the host
 * that owns the cwd and is loaded below from that host's `.mcp.json`.
 * Refusing one remote spawn keeps every other adapter and bridge usable.
 */
export function assertTransportableRemoteMcpServers(raw: unknown): McpServer[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("remote spawn MCP configuration must be an array");
  }
  return raw.map((value, index) => {
    if (!value || typeof value !== "object") {
      throw new Error(`remote spawn MCP server at index ${index} is invalid`);
    }
    const server = value as Record<string, unknown>;
    const name = typeof server.name === "string" ? server.name : `index ${index}`;
    if (typeof server.command === "string" || !(server.type === "http" || server.type === "sse")) {
      throw new Error(
        `remote spawn refuses transported stdio MCP server "${name}"; ` +
        "configure it in the bridge host project's .mcp.json instead"
      );
    }
    if (typeof server.name !== "string" || typeof server.url !== "string") {
      throw new Error(`remote spawn MCP server "${name}" requires name and url`);
    }
    return value as McpServer;
  });
}

export async function dispatchBridgeRpc(
  method: string,
  params: unknown,
  agentId: string | undefined,
  ctx: RpcContext
): Promise<unknown> {
  if (!isAllowedRpcMethod(method)) {
    throw new Error(`unknown rpc method: ${method}`);
  }
  if (isHostRpcMethod(method)) {
    return dispatchHost(method, asRecord(params), ctx);
  }
  return dispatchAdapter(method, asRecord(params), agentId, ctx);
}

async function dispatchAdapter(
  method: string,
  params: Record<string, unknown>,
  agentId: string | undefined,
  ctx: RpcContext
): Promise<unknown> {
  const cwd = str(params.cwd) ?? ctx.cwd;

  if (method === "readAttachment" && params.hostPath === true) {
    const requested = str(params.path) ?? str(params.filename);
    if (!requested) throw new Error("path required");
    const resolved = path.resolve(cwd, requested);
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) throw new Error(`not a regular file: ${requested}`);
    if (stat.size > ATTACH_MAX_BYTES) {
      throw new Error(`file exceeds ${ATTACH_MAX_BYTES} byte attach cap (${stat.size} B)`);
    }
    const bytes = await fsp.readFile(resolved);
    return {
      bytesBase64: bytes.toString("base64"),
      filename: path.basename(resolved),
      size: bytes.byteLength,
    };
  }

  if (method === "writeAttachment" && params.hostPath === true) {
    const requested = str(params.path);
    const base64 = str(params.bytesBase64) ?? str(params.base64);
    if (!requested || base64 === undefined) throw new Error("path and bytesBase64 required");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength > ATTACH_MAX_BYTES) {
      throw new Error(`file exceeds ${ATTACH_MAX_BYTES} byte attach cap (${bytes.byteLength} B)`);
    }
    const resolved = path.resolve(cwd, requested);
    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    await fsp.writeFile(resolved, bytes);
    return { path: resolved, size: bytes.byteLength };
  }

  if (method === "spawn") {
    const slot = params.slot;
    if (typeof slot !== "number") throw new Error("spawn requires numeric slot");
    // A thread can move to a host that does not have its directory (a new
    // agent@host binding). Work in this host's workspace instead, and say so.
    const requestedCwd = cwd;
    const spawnCwd = existsSync(requestedCwd) ? requestedCwd : ctx.cwd;
    const env =
      params.env && typeof params.env === "object" && !Array.isArray(params.env)
        ? Object.fromEntries(
            Object.entries(params.env as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string"
            )
          )
        : undefined;
    const transportedMcpServers = assertTransportableRemoteMcpServers(params.mcpServers);
    const projectMcpServers = readProjectMcpServers({
      cwd: spawnCwd,
      logger: projectMcpLogger,
      reservedNames: new Set(transportedMcpServers.map((server) => server.name)),
      environment: process.env,
    });
    const mcpServers = [...transportedMcpServers, ...projectMcpServers];
    const modelFallbacks = isModelFallbackPlan(params.modelFallbacks) &&
      params.modelFallbacks.agentId === (str(params.agentId) ?? agentId) &&
      params.modelFallbacks.requestedModel === str(params.model) ? params.modelFallbacks : undefined;
    if (params.modelFallbacks !== undefined && !modelFallbacks) {
      console.error("[bridge] unsupported or mismatched model fallback plan; keeping requested model without substitution");
    }
    const rung1Recovery = isRemoteRung1Policy(params.rung1Recovery)
      ? params.rung1Recovery
      : undefined;
    if (params.rung1Recovery !== undefined && !rung1Recovery) {
      throw new Error("spawn received an invalid rung-1 recovery policy");
    }
    ctx.configureSlot?.(slot, {
      agentId: str(params.agentId) ?? agentId,
      cwd: spawnCwd,
      ...(spawnCwd !== requestedCwd ? { requestedCwd } : {}),
      env,
      mcpServers,
      model: str(params.model),
      ...(modelFallbacks ? { modelFallbacks } : {}),
      effort: str(params.effort),
      ...(rung1Recovery ? { rung1Recovery } : {}),
    });
    return {
      ok: true,
      slot,
      projectMcpInjection: true,
      projectMcpServers: projectMcpServers.map((server) => server.name),
      ...(rung1Recovery ? { rung1RecoveryVersion: 1 } : {}),
      ...(spawnCwd !== requestedCwd ? { cwdFallback: { requested: requestedCwd, used: spawnCwd } } : {}),
    };
  }

  const adapter = method === "listWorkspaces" ? undefined : requireAgent(ctx, agentId);
  if (method === "install" && adapter) {
    const recipe = adapter.install();
    if (params.confirmed !== true) return recipe;
    if (!recipe.supported) {
      throw new Error("install is not supported for this agent");
    }
    return { ok: true, ran: false, recipe };
  }
  const adapterCwd = SESSION_CWD_METHODS.has(method) && !existsSync(cwd)
    ? ctx.cwd
    : cwd;
  return invokeAdapterRpc(method, adapterCwd === cwd ? params : { ...params, cwd: adapterCwd }, {
    adapter,
    workspaceRoot: ctx.workspaceRoot,
    cwd: adapterCwd,
  });
}

async function dispatchHost(
  method: string,
  params: Record<string, unknown>,
  ctx: RpcContext
): Promise<unknown> {
  switch (method) {
    case "shell": {
      const command = str(params.command);
      if (!command) throw new Error("shell requires command");
      const timeoutSec = typeof params.timeoutSec === "number" ? params.timeoutSec : undefined;
      const timeoutMs = timeoutSec === undefined
        ? HOST_EXEC_DEFAULT_TIMEOUT_MS
        : Math.round(timeoutSec * 1000);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > HOST_EXEC_MAX_TIMEOUT_MS) {
        throw new Error("timeoutSec must be between 1 and 900");
      }
      return runHostCommand(command, str(params.cwd) ?? ctx.cwd, timeoutMs);
    }
    default:
      throw new Error(`unknown rpc method: ${method}`);
  }
}

type HostCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

function appendBounded(
  chunks: Buffer[],
  currentBytes: number,
  value: Buffer
): { bytes: number; truncated: boolean } {
  const remaining = HOST_EXEC_OUTPUT_MAX_BYTES - currentBytes;
  if (remaining <= 0) return { bytes: currentBytes, truncated: value.byteLength > 0 };
  chunks.push(value.subarray(0, remaining));
  return {
    bytes: currentBytes + Math.min(value.byteLength, remaining),
    truncated: value.byteLength > remaining,
  };
}

export function runHostCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<HostCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stdout, stdoutBytes, chunk);
      stdoutBytes = appended.bytes;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stderr, stderrBytes, chunk);
      stderrBytes = appended.bytes;
      stderrTruncated ||= appended.truncated;
    });
    child.once("error", reject);

    const stop = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), 1_000);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}
