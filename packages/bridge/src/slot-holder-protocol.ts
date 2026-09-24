/**
 * sessiond ⇄ slot-holder protocol (#631). Newline-delimited JSON over the
 * holder's private socket. Binary data is base64.
 */
export const SLOT_HOLDER_PROTOCOL_VERSION = 1;

export interface SlotHolderFrame {
  seq: number;
  at: number;
  stream: "stdout" | "stderr" | "exit";
  dataBase64?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

export type SlotHolderInput =
  | { v: typeof SLOT_HOLDER_PROTOCOL_VERSION; type: "hello"; afterSeq: number }
  | {
      v: typeof SLOT_HOLDER_PROTOCOL_VERSION;
      type: "spawn";
      executable: string;
      args?: string[];
      cwd: string;
      env: Record<string, string>;
    }
  | { v: typeof SLOT_HOLDER_PROTOCOL_VERSION; type: "write"; id: string; dataBase64: string }
  | { v: typeof SLOT_HOLDER_PROTOCOL_VERSION; type: "ack"; throughSeq: number }
  | { v: typeof SLOT_HOLDER_PROTOCOL_VERSION; type: "signal"; signal: NodeJS.Signals };

export type SlotHolderOutput =
  | { v: typeof SLOT_HOLDER_PROTOCOL_VERSION; type: "hello_ack"; pid?: number; exited?: boolean }
  | { v: typeof SLOT_HOLDER_PROTOCOL_VERSION; type: "spawn_result"; ok: boolean; pid?: number; code?: string }
  | { v: typeof SLOT_HOLDER_PROTOCOL_VERSION; type: "write_result"; id: string; ok: boolean }
  | { v: typeof SLOT_HOLDER_PROTOCOL_VERSION; type: "frame"; frame: SlotHolderFrame };
