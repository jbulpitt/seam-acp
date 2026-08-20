/**
 * Bridge-side RPC dispatcher. Calls `@seam/adapters` methods; never imports
 * discord.js. `rpc.method` must be on the adapter allow-list, or a dev-mode
 * handler when `--dev` / `SEAM_BRIDGE_DEV=1` registered them.
 */
import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { AgentAdapter } from "@seam/adapters";
import {
  isAllowedRpcMethod,
  isDevRpcMethod,
  invokeAdapterRpc,
  isPathWithinRoot,
  ATTACH_MAX_BYTES,
} from "@seam/adapters";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export interface SlotSpawnConfig {
  agentId?: string;
  cwd?: string;
  env?: Record<string, string>;
  mcpServers?: unknown;
  model?: string;
  effort?: string;
}

export interface RpcContext {
  adapters: Map<string, AgentAdapter>;
  workspaceRoot: string;
  cwd: string;
  devMode: boolean;
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

function assertWithinRoot(target: string, root: string, label: string): string {
  const resolved = path.resolve(target);
  if (!isPathWithinRoot(resolved, root)) {
    throw new Error(`${label} escapes workspace root`);
  }
  return resolved;
}

export async function dispatchBridgeRpc(
  method: string,
  params: unknown,
  agentId: string | undefined,
  ctx: RpcContext
): Promise<unknown> {
  if (!isAllowedRpcMethod(method, { devMode: ctx.devMode })) {
    throw new Error(`unknown rpc method: ${method}`);
  }
  if (isDevRpcMethod(method)) {
    return dispatchDev(method, asRecord(params), ctx);
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

  if (method === "spawn") {
    const slot = params.slot;
    if (typeof slot !== "number") throw new Error("spawn requires numeric slot");
    const env =
      params.env && typeof params.env === "object" && !Array.isArray(params.env)
        ? Object.fromEntries(
            Object.entries(params.env as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string"
            )
          )
        : undefined;
    ctx.configureSlot?.(slot, {
      agentId: str(params.agentId) ?? agentId,
      cwd,
      env,
      mcpServers: params.mcpServers,
      model: str(params.model),
      effort: str(params.effort),
    });
    return { ok: true, slot };
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
  return invokeAdapterRpc(method, params, {
    adapter,
    workspaceRoot: ctx.workspaceRoot,
    cwd,
  });
}

async function dispatchDev(
  method: string,
  params: Record<string, unknown>,
  ctx: RpcContext
): Promise<unknown> {
  if (!ctx.devMode) throw new Error("dev-mode RPC is not registered on this bridge");
  const root = ctx.workspaceRoot;

  switch (method) {
    case "exec": {
      const file = str(params.file) ?? str(params.command);
      if (!file) throw new Error("exec requires file");
      const args = Array.isArray(params.args) ? params.args.map(String) : [];
      const cwd = str(params.cwd) ? assertWithinRoot(str(params.cwd)!, root, "cwd") : ctx.cwd;
      const { stdout, stderr } = await execFileAsync(file, args, {
        cwd,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return { stdout, stderr };
    }
    case "shell": {
      const command = str(params.command);
      if (!command) throw new Error("shell requires command");
      const cwd = str(params.cwd) ? assertWithinRoot(str(params.cwd)!, root, "cwd") : ctx.cwd;
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return { stdout, stderr };
    }
    case "tailLog": {
      const p = str(params.path);
      if (!p) throw new Error("tailLog requires path");
      const abs = assertWithinRoot(path.isAbsolute(p) ? p : path.join(root, p), root, "path");
      const lines = typeof params.lines === "number" ? Math.min(Math.max(params.lines, 1), 500) : 80;
      const buf = await fsp.readFile(abs);
      if (buf.byteLength > ATTACH_MAX_BYTES) {
        throw new Error("log file exceeds attach cap");
      }
      const text = buf.toString("utf8");
      const all = text.split(/\r?\n/);
      return { text: all.slice(-lines).join("\n"), lines: Math.min(lines, all.length) };
    }
    case "writeFile": {
      const p = str(params.path);
      const content = str(params.content);
      if (!p || content === undefined) throw new Error("writeFile requires path and content");
      const abs = assertWithinRoot(path.isAbsolute(p) ? p : path.join(root, p), root, "path");
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, "utf8");
      return { path: abs, bytes: Buffer.byteLength(content) };
    }
    default:
      throw new Error(`unknown rpc method: ${method}`);
  }
}
