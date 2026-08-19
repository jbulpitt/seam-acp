/**
 * Typed command-bus protocol (PR3 / §5).
 *
 * Frames share the existing per-bridge WebSocket with the slot mux
 * (`data` / `kill` / `exit`). `rpc.method` is restricted to the adapter
 * allow-list; `exec` / `shell` / `tailLog` / `writeFile` exist only when
 * the bridge process is in dev mode.
 */

export const PROTOCOL_VERSION = 1;

export const ADAPTER_RPC_METHODS = [
  "describe",
  "prepare",
  "install",
  "spawn",
  "listWorkspaces",
  "listSessions",
  "getTranscript",
  "getUsage",
  "cloneSession",
  "deleteSession",
  "whoami",
  "usage",
  "writeAttachment",
  "readAttachment",
] as const;

export type AdapterRpcMethod = (typeof ADAPTER_RPC_METHODS)[number];

export const DEV_RPC_METHODS = ["exec", "shell", "tailLog", "writeFile"] as const;
export type DevRpcMethod = (typeof DEV_RPC_METHODS)[number];

const ADAPTER_RPC_SET = new Set<string>(ADAPTER_RPC_METHODS);
const DEV_RPC_SET = new Set<string>(DEV_RPC_METHODS);

export function isAdapterRpcMethod(method: string): method is AdapterRpcMethod {
  return ADAPTER_RPC_SET.has(method);
}

export function isDevRpcMethod(method: string): method is DevRpcMethod {
  return DEV_RPC_SET.has(method);
}

/** True when the method may be dispatched for this connection. */
export function isAllowedRpcMethod(
  method: string,
  opts: { devMode: boolean }
): boolean {
  if (isAdapterRpcMethod(method)) return true;
  return opts.devMode && isDevRpcMethod(method);
}

export interface HelloAgentInventory {
  agentId: string;
  version: number;
  installed: boolean;
  ready: boolean;
}

export interface HelloHostInfo {
  os: string;
  arch: string;
}

export interface HelloFrame {
  v: number;
  type: "hello";
  bridgeId: string;
  instanceId: string;
  protocolVersion: number;
  host: HelloHostInfo;
  agents: HelloAgentInventory[];
  /** True when the bridge process registered dev-mode RPC handlers. */
  devMode?: boolean;
}

export interface HelloAckFrame {
  v: number;
  type: "hello_ack";
  protocolVersion: number;
  accepted: boolean;
  error?: string;
}

export interface RpcFrame {
  v: number;
  type: "rpc";
  id: string;
  agentId?: string;
  method: string;
  params?: unknown;
}

export interface RpcReplyFrame {
  v: number;
  type: "rpc_reply";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface EventFrame {
  v: number;
  type: "event";
  name: string;
  payload?: unknown;
}

export interface PingFrame {
  v: number;
  type: "ping";
  ts?: number;
}

export interface PongFrame {
  v: number;
  type: "pong";
  ts?: number;
}

export type CommandBusFrame =
  | HelloFrame
  | HelloAckFrame
  | RpcFrame
  | RpcReplyFrame
  | EventFrame
  | PingFrame
  | PongFrame;

export function parseCommandBusFrame(raw: unknown): CommandBusFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as { type?: unknown; v?: unknown };
  if (typeof msg.type !== "string") return null;
  switch (msg.type) {
    case "hello":
    case "hello_ack":
    case "rpc":
    case "rpc_reply":
    case "event":
    case "ping":
    case "pong":
      return raw as CommandBusFrame;
    default:
      return null;
  }
}
