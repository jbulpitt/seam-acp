import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import type { PermissionPolicyMode, SessionRecord } from "../types.js";
import type { ElicitationRequestContext } from "./types.js";

type ElicitUserFn = (
  record: SessionRecord,
  request: CreateElicitationRequest,
  context: ElicitationRequestContext
) => Promise<CreateElicitationResponse>;

/** Codex-acp request `_meta` key for MCP tool-call approval elicitations. */
export const CODEX_APPROVAL_KIND_KEY = "codex_approval_kind";
/** Value Codex-acp currently sends for MCP tool-call approvals. */
export const CODEX_APPROVAL_KIND_MCP_TOOL_CALL = "mcp_tool_call";
/**
 * Durable, non-secret marker stored on the request JSON after `_meta` is
 * stripped. Lets restart/ask-mode cards keep the Allow/Cancel path without
 * persisting opaque ACP metadata.
 */
export const SEAM_MCP_TOOL_APPROVAL_FLAG = "seamMcpToolApproval";
const PERSIST_KEY = "persist";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * True only for form-mode MCP tool-call approvals identified by structured
 * metadata. Message text, schema titles, and schema `_meta` are ignored.
 */
export function isMcpToolApprovalElicitation(request: CreateElicitationRequest): boolean {
  if (request.mode !== "form") return false;
  return (
    isPlainRecord(request._meta) &&
    request._meta[CODEX_APPROVAL_KIND_KEY] === CODEX_APPROVAL_KIND_MCP_TOOL_CALL
  );
}

/** Stored form JSON after `_meta` is stripped; used only to rehydrate Allow/Cancel. */
export function isStoredMcpToolApproval(request: CreateElicitationRequest): boolean {
  return (
    isMcpToolApprovalElicitation(request) ||
    (request.mode === "form" &&
      (request as Record<string, unknown>)[SEAM_MCP_TOOL_APPROVAL_FLAG] === true)
  );
}

/** Copy used for durable storage: drop `_meta`, keep a non-secret approval flag. */
export function durableApprovalRequest(request: CreateElicitationRequest): CreateElicitationRequest {
  if (!isMcpToolApprovalElicitation(request)) return request;
  return { ...request, [SEAM_MCP_TOOL_APPROVAL_FLAG]: true } as CreateElicitationRequest;
}

/** `always` / `deny` resolve without a Discord card; `ask` stays interactive. */
export function autoResponseForApprovalPolicy(
  mode: PermissionPolicyMode
): CreateElicitationResponse | null {
  if (mode === "always") return { action: "accept" };
  if (mode === "deny") return { action: "cancel" };
  return null;
}

/**
 * Drop Codex persist-scope choices so Seam remains the source of truth.
 * Does not change sessionId / toolCallId correlation.
 */
export function elicitationWithoutTrustGrant(
  request: CreateElicitationRequest
): CreateElicitationRequest {
  if (request.mode !== "form") return request;
  const schema = "requestedSchema" in request && isPlainRecord(request.requestedSchema)
    ? request.requestedSchema
    : null;
  const current = schema ? schema.properties : undefined;
  if (!schema || !isPlainRecord(current) || !Object.hasOwn(current, PERSIST_KEY)) {
    return request;
  }
  const { persist: _persist, ...properties } = current;
  const required = (Array.isArray(schema.required) ? schema.required : []).filter(
    (key: unknown) => key !== PERSIST_KEY
  );
  return {
    ...request,
    requestedSchema: {
      ...schema,
      properties,
      ...(required.length > 0 ? { required } : { required: undefined }),
    },
  } as CreateElicitationRequest;
}

/** Strip persist from content and `_meta` so auto-allow never grants Codex trust. */
export function responseWithoutTrustGrant(
  response: CreateElicitationResponse
): CreateElicitationResponse {
  const next: CreateElicitationResponse = { ...response };
  if (isPlainRecord(next._meta) && Object.hasOwn(next._meta, PERSIST_KEY)) {
    const { persist: _persist, ...meta } = next._meta;
    if (Object.keys(meta).length > 0) next._meta = meta;
    else delete next._meta;
  }
  if (
    next.action === "accept" &&
    isPlainRecord(next.content) &&
    Object.hasOwn(next.content, PERSIST_KEY)
  ) {
    const { persist: _persist, ...content } = next.content;
    if (Object.keys(content).length > 0) {
      next.content = content as NonNullable<typeof next.content>;
    } else {
      delete next.content;
    }
  }
  return next;
}

export async function handleElicitationWithPermissionPolicy(opts: {
  request: CreateElicitationRequest;
  context: ElicitationRequestContext;
  mode: PermissionPolicyMode;
  elicitUser?: ElicitUserFn;
  record: SessionRecord;
}): Promise<CreateElicitationResponse> {
  if (isMcpToolApprovalElicitation(opts.request)) {
    const auto = autoResponseForApprovalPolicy(opts.mode);
    if (auto) return auto;
    if (!opts.elicitUser) return { action: "cancel" };
    const response = await opts.elicitUser(
      opts.record,
      elicitationWithoutTrustGrant(opts.request),
      opts.context
    );
    return responseWithoutTrustGrant(response);
  }
  if (!opts.elicitUser) return { action: "decline" };
  return opts.elicitUser(opts.record, opts.request, opts.context);
}
