import type {
  RemoteRecoveryResult,
  RemoteRecoverySnapshot,
} from "@seam/adapters";
import type { SlotSpawnConfig } from "./rpc.js";

/** Private, local protocol between the bridge and its supervised adapter host. */
export const ADAPTER_CHILD_PROTOCOL_VERSION = 1;

export interface AdapterChildBootstrap {
  v: typeof ADAPTER_CHILD_PROTOCOL_VERSION;
  type: "bootstrap";
  copilotCmd: string;
  localCwd: string;
  slot: number;
  config: SlotSpawnConfig;
}

export type AdapterChildInput =
  | AdapterChildBootstrap
  | {
      v: typeof ADAPTER_CHILD_PROTOCOL_VERSION;
      type: "input";
      dataBase64: string;
    }
  | {
      v: typeof ADAPTER_CHILD_PROTOCOL_VERSION;
      type: "arm_recovery";
      requestId: string;
      submissionId: unknown;
      acpSessionId: unknown;
      continuation: unknown;
    }
  | {
      v: typeof ADAPTER_CHILD_PROTOCOL_VERSION;
      type: "disarm_recovery";
      requestId: string;
      submissionId: unknown;
    };

export type AdapterChildOutput =
  | {
      v: typeof ADAPTER_CHILD_PROTOCOL_VERSION;
      type: "data";
      data: string;
    }
  | {
      v: typeof ADAPTER_CHILD_PROTOCOL_VERSION;
      type: "recovery";
      recovery: RemoteRecoverySnapshot;
    }
  | {
      v: typeof ADAPTER_CHILD_PROTOCOL_VERSION;
      type: "recovery_result";
      recoveryResult: RemoteRecoveryResult;
    }
  | {
      v: typeof ADAPTER_CHILD_PROTOCOL_VERSION;
      type: "spawn_refusal";
      spawnError: string;
    }
  | {
      /** The slot is stopping after it started; `reason` reaches the controller. */
      v: typeof ADAPTER_CHILD_PROTOCOL_VERSION;
      type: "refusal";
      reason: string;
    }
  | {
      v: typeof ADAPTER_CHILD_PROTOCOL_VERSION;
      type: "control_result";
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    };

export function adapterChildLine(message: AdapterChildInput | AdapterChildOutput): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseAdapterChildOutput(line: string): AdapterChildOutput | undefined {
  try {
    const value = JSON.parse(line) as Partial<AdapterChildOutput>;
    if (value.v !== ADAPTER_CHILD_PROTOCOL_VERSION) return undefined;
    if (value.type === "data" && typeof value.data === "string") return value as AdapterChildOutput;
    if (value.type === "recovery" && value.recovery && typeof value.recovery === "object") {
      return value as AdapterChildOutput;
    }
    if (value.type === "recovery_result" && value.recoveryResult && typeof value.recoveryResult === "object") {
      return value as AdapterChildOutput;
    }
    if (value.type === "spawn_refusal" && typeof value.spawnError === "string") {
      return value as AdapterChildOutput;
    }
    if (value.type === "refusal" && typeof value.reason === "string") {
      return value as AdapterChildOutput;
    }
    if (value.type === "control_result" && typeof value.requestId === "string" && typeof value.ok === "boolean") {
      return value as AdapterChildOutput;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
