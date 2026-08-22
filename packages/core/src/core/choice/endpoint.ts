/**
 * Headless ingest endpoints (#95). Reusable HTTP contract: token + frozen
 * spawn fields. Not a Discord choice card.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { DispatchSpec } from "../dispatch/types.js";

export type IngestEndpointStatus = "open" | "revoked";

export interface IngestEndpoint {
  id: string;
  tokenHash: string;
  name: string;
  cwd: string | null;
  agentId: string | null;
  model: string | null;
  effort: string | null;
  wrapper: string | null;
  resultSchema: unknown | null;
  corsOrigins: string[] | null;
  uniqueStudent: boolean;
  notifyThread: string | null;
  status: IngestEndpointStatus;
  createdBy: string;
  createdUtc: string;
  authoringChannelRef: string;
  authoringParentRef: string | null;
  platform: string;
}

export interface IngestEndpointSpec {
  name: string;
  wrapper?: string;
  resultSchema?: unknown;
  corsOrigins?: string[];
  uniqueStudent?: boolean;
  notifyThread?: string | null;
  cwd?: string;
  agent?: string;
  model?: string;
  effort?: string;
}

const EndpointSpecSchema = z.object({
  name: z.string().trim().min(1).max(80),
  wrapper: z.string().optional(),
  resultSchema: z.unknown().optional(),
  corsOrigins: z.array(z.string().min(1)).optional(),
  uniqueStudent: z.boolean().optional(),
  notifyThread: z
    .string()
    .regex(/^\d+$/)
    .nullable()
    .optional(),
  cwd: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});

export function newIngestEndpointId(): string {
  return `ie_${randomBytes(9).toString("base64url")}`;
}

export function parseIngestEndpointSpec(
  raw: unknown
): { ok: true; spec: IngestEndpointSpec } | { ok: false; error: string } {
  const parsed = EndpointSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: issues };
  }
  return { ok: true, spec: parsed.data };
}

export function wrapEndpointPrompt(opts: {
  ingestId: string;
  name: string;
  payload: string;
  wrapper?: string | null;
  untrustedStudentId?: string | null;
}): string {
  const head = [
    "<seam-ingest>",
    `Endpoint ${opts.ingestId} (${opts.name}). HTTP ingest (site token; not a Discord user).`,
    `Claimed student id (untrusted): ${opts.untrustedStudentId || "(none)"}.`,
    "Destination: isolated silent (no Discord thread unless notifyThread was set at mint).",
    "Declare the student-facing HTTP body with submit_result({...}) or a seam-result fence. That JSON is the HTTP response — not a Discord transcript.",
    "</seam-ingest>",
  ];
  const wrapper = (opts.wrapper ?? "").trim();
  return [...head, "", ...(wrapper ? [wrapper, ""] : []), opts.payload].join("\n");
}

/** True when `target` is a Discord snowflake (notify thread), not a ledger sentinel. */
export function isDiscordSnowflake(id: string): boolean {
  return /^\d{10,}$/.test(id);
}

export function planEndpointDispatch(opts: {
  endpoint: IngestEndpoint;
  payload: string;
  untrustedStudentId?: string | null;
  defaultModel?: string;
}): DispatchSpec {
  const e = opts.endpoint;
  const id = cryptoRandomUuid();
  const notify = e.notifyThread && isDiscordSnowflake(e.notifyThread) ? e.notifyThread : null;
  const prompt = wrapEndpointPrompt({
    ingestId: e.id,
    name: e.name,
    payload: opts.payload,
    wrapper: e.wrapper,
    untrustedStudentId: opts.untrustedStudentId,
  });
  const spec: DispatchSpec = {
    id,
    target: notify ?? `ingest:${e.id}`,
    prompt,
    session: "isolated",
    kind: "ingest",
    stream: false,
    correlationId: e.id,
    createdUtc: new Date().toISOString(),
  };
  if (e.cwd) spec.cwd = e.cwd;
  if (e.agentId) spec.agentId = e.agentId;
  if (e.model) spec.model = e.model;
  else if (opts.defaultModel) spec.model = opts.defaultModel;
  if (e.effort) spec.effort = e.effort;
  return spec;
}

function cryptoRandomUuid(): string {
  return globalThis.crypto.randomUUID();
}
