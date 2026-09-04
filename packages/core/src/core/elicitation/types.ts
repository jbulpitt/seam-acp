import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";

export const ELICITATION_CUSTOM_ID_PREFIX = "seam-elicit:";
export const ELICITATION_MAX_FIELDS = 20;
export const ELICITATION_PAGE_SIZE = 5;
export const ELICITATION_MAX_OPTIONS = 25;
export const ELICITATION_MAX_MESSAGE = 2_000;
export const ELICITATION_MAX_TEXT = 4_000;
export const ELICITATION_TTL_MS = 15 * 60_000;
export const ELICITATION_MODAL_LEASE_MS = 5 * 60_000;

export type ElicitationTerminalStatus =
  | "accepted"
  | "cancelled"
  | "expired"
  | "superseded"
  | "interrupted"
  | "declined";
export type ElicitationStatus = "open" | ElicitationTerminalStatus;

export interface ElicitationRow {
  id: string;
  sessionRecordId: string;
  platform: string;
  channelRef: string;
  parentRef: string | null;
  authorizedUserId: string;
  acpSessionId: string | null;
  requestCorrelation: string;
  mode: "form" | "url";
  elicitationId: string | null;
  requestJson: string;
  valuesJson: string;
  completedPagesJson: string;
  currentPage: number;
  status: ElicitationStatus;
  messageId: string | null;
  leaseToken: string | null;
  leaseExpiresUtc: string | null;
  terminalDetail: string | null;
  createdUtc: string;
  updatedUtc: string;
  expiresUtc: string;
}

export interface NewElicitationRow extends ElicitationRow {
  status: "open";
}

export interface ElicitationField {
  key: string;
  schema: ElicitationPropertySchema;
  required: boolean;
  title: string;
}

export interface ValidatedForm {
  request: Extract<CreateElicitationRequest, { mode: "form" }>;
  fields: ElicitationField[];
  pages: ElicitationField[][];
  directDecision:
    | { kind: "boolean"; field: ElicitationField }
    | {
        kind: "single" | "multi";
        field: ElicitationField;
        options: Array<{ label: string; value: string; description?: string }>;
        min: number;
        max: number;
      }
    | null;
}

export type ElicitationValues = Record<string, ElicitationContentValue>;

export interface ElicitationRequestContext {
  requestId: string | number | null;
  signal: AbortSignal;
}

export type ElicitationHandler = (
  request: CreateElicitationRequest,
  context: ElicitationRequestContext
) => Promise<CreateElicitationResponse>;

export type ElicitationComponentAction =
  | { kind: "answer"; id: string }
  | { kind: "cancel"; id: string }
  | { kind: "previous"; id: string }
  | { kind: "next"; id: string }
  | { kind: "boolean"; id: string; value: boolean }
  | { kind: "choice"; id: string; index: number }
  | { kind: "skip"; id: string }
  | { kind: "select"; id: string }
  | { kind: "submit"; id: string; lease: string };

export function elicitationCustomId(action: string, id: string, suffix?: string): string {
  return `${ELICITATION_CUSTOM_ID_PREFIX}${action}:${id}${suffix ? `:${suffix}` : ""}`;
}

export function parseElicitationCustomId(value: string): ElicitationComponentAction | null {
  if (!value.startsWith(ELICITATION_CUSTOM_ID_PREFIX)) return null;
  const [action, id, suffix, extra] = value.slice(ELICITATION_CUSTOM_ID_PREFIX.length).split(":");
  if (!action || !id || extra !== undefined) return null;
  switch (action) {
    case "answer": return suffix === undefined ? { kind: "answer", id } : null;
    case "cancel": return suffix === undefined ? { kind: "cancel", id } : null;
    case "prev": return suffix === undefined ? { kind: "previous", id } : null;
    case "next": return suffix === undefined ? { kind: "next", id } : null;
    case "bool":
      if (suffix === "1") return { kind: "boolean", id, value: true };
      if (suffix === "0") return { kind: "boolean", id, value: false };
      return null;
    case "choice": {
      const index = Number(suffix);
      return Number.isSafeInteger(index) && index >= 0 ? { kind: "choice", id, index } : null;
    }
    case "skip": return suffix === undefined ? { kind: "skip", id } : null;
    case "select": return suffix === undefined ? { kind: "select", id } : null;
    case "submit": return suffix ? { kind: "submit", id, lease: suffix } : null;
    default: return null;
  }
}

export function responseForTerminal(status: ElicitationTerminalStatus): CreateElicitationResponse {
  return status === "accepted" ? { action: "accept" } : status === "declined"
    ? { action: "decline" }
    : { action: "cancel" };
}
