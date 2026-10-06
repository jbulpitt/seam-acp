/**
 * Typed command-bus protocol (PR3 / §5).
 *
 * Frames share the existing per-bridge WebSocket with the slot mux
 * (`data` / `kill` / `exit`). `rpc.method` is restricted to the adapter
 * allow-list. Host RPCs execute with the bridge process permissions.
 */

export const PROTOCOL_VERSION = 1;

export const ADAPTER_RPC_METHODS = [
  "describe",
  "prepare",
  "install",
  "spawn",
  "describeModelCatalog",
  "fetchModelCatalog",
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

export const HOST_RPC_METHODS = ["shell"] as const;
export type HostRpcMethod = (typeof HOST_RPC_METHODS)[number];

const ADAPTER_RPC_SET = new Set<string>(ADAPTER_RPC_METHODS);
const HOST_RPC_SET = new Set<string>(HOST_RPC_METHODS);

export function isAdapterRpcMethod(method: string): method is AdapterRpcMethod {
  return ADAPTER_RPC_SET.has(method);
}

export function isHostRpcMethod(method: string): method is HostRpcMethod {
  return HOST_RPC_SET.has(method);
}

/** True when the method may be dispatched by a bridge. */
export function isAllowedRpcMethod(method: string): boolean {
  return isAdapterRpcMethod(method) || isHostRpcMethod(method);
}

export interface HelloAgentInventory {
  agentId: string;
  version: number;
  installed: boolean;
  ready: boolean;
  /** Optional non-secret resolved runtime/provenance inventory. */
  runtime?: import("./agent-profile.js").AdapterRuntimeDescriptor;
}

export interface HelloHostInfo {
  os: string;
  arch: string;
  /** Exact non-secret workspace configured by the bridge's `--cwd`. */
  workspaceRoot?: string;
  /** Exact non-secret home directory; fallback when no workspace was declared. */
  home?: string;
}

export interface HelloFrame {
  v: number;
  type: "hello";
  bridgeId: string;
  instanceId: string;
  protocolVersion: number;
  /**
   * Git sha of the release this process is running. Omitted when the bridge
   * has no stage receipt. Absence is unknown — never infer it from a sibling.
   */
  releaseSha?: string;
  host: HelloHostInfo;
  agents: HelloAgentInventory[];
  /** Optional bridge behaviours. Absence is the legacy contract. */
  capabilities?: {
    /** Agent slots outlive this bridge process and can be reconciled by id. */
    durableSlots?: boolean;
  };
  /** Legacy rollout field. Receivers must ignore it. */
  devMode?: boolean;
  /** Secret-free staged-release identity used only for rollout verification. */
  release?: {
    formatVersion: 2;
    activationId: string;
    stageId: string;
    bridgeId: string;
    sourceSha: string;
    artifactChecksum: string;
    verificationAgent: string;
    oldPid: number;
    pid: number;
    startedAt: string;
    deadlineAt: string;
  };
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
