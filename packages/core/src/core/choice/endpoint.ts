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
  /**
   * Live handoff destination (#224). A snowflake here makes every POST a
   * typical live turn in THAT thread's own session — its identity, its history,
   * no report-back. Mutually exclusive with `preset` / pinned agent-model-effort-cwd
   * / `notifyThread`, which are the isolated-worker knobs.
   */
  thread: string | null;
  /** Named preset resolved at fire, not snapshot. Null ⇒ use frozen agent/model/cwd. */
  preset: string | null;
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
  /** Live handoff destination — see {@link IngestEndpoint.thread}. */
  thread?: string;
  /** Resolve this project preset at fire (agent/model/effort/cwd + instructions). */
  preset?: string;
  cwd?: string;
  agent?: string;
  model?: string;
  effort?: string;
}

const EndpointSpecSchema = z
  .object({
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
    thread: z
      .string()
      .regex(/^\d{10,}$/, "thread must be a Discord thread snowflake")
      .optional(),
    preset: z.string().trim().min(1).max(80).optional(),
    cwd: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.preset) {
      for (const key of ["agent", "model", "effort", "cwd"] as const) {
        if (s[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `preset cannot be combined with ${key} — the preset is the identity (resolved at fire)`,
            path: [key],
          });
        }
      }
    }
    if (!s.thread) return;
    // A live handoff runs in the target thread's OWN session: its agent, model,
    // effort and cwd. Every knob below picks a DIFFERENT identity, so combining
    // them would silently ignore one of the two. notifyThread is the isolated
    // score-then-copy shape — a separate product, not a second destination.
    for (const key of ["preset", "agent", "model", "effort", "cwd", "notifyThread"] as const) {
      if (s[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `thread cannot be combined with ${key} — a live handoff uses the target thread's own identity`,
          path: [key],
        });
      }
    }
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
  /** #224: live handoff into this thread's own session. No declared result required. */
  thread?: string | null;
}): string {
  const head = [
    "<seam-ingest>",
    `Endpoint ${opts.ingestId} (${opts.name}). HTTP ingest (site token; not a Discord user).`,
    `Claimed student id (untrusted): ${opts.untrustedStudentId || "(none)"}.`,
    ...(opts.thread
      ? [
          "Destination: this thread, live. Answer here as you normally would — the POST already returned.",
          "No submit_result is required; there is no HTTP body to declare and nothing reports back.",
        ]
      : [
          "Destination: isolated silent (no Discord thread unless notifyThread was set at mint).",
          "Declare the student-facing HTTP body with submit_result({...}) or a seam-result fence. That JSON is the HTTP response — not a Discord transcript.",
        ]),
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
  const live = e.thread && isDiscordSnowflake(e.thread) ? e.thread : null;
  const notify = e.notifyThread && isDiscordSnowflake(e.notifyThread) ? e.notifyThread : null;
  const prompt = wrapEndpointPrompt({
    ingestId: e.id,
    name: e.name,
    payload: opts.payload,
    wrapper: e.wrapper,
    untrustedStudentId: opts.untrustedStudentId,
    ...(live ? { thread: live } : {}),
  });
  // #224 live handoff: a typical turn in the target thread's own session.
  // `kind: "ingest"` stays so the HTTP waiter and the ledger still classify the
  // job, but session=live routes it away from the synthetic isolated record.
  // No `returnTo` — the answer lands in the thread, it does not report back.
  if (live) {
    return {
      id,
      target: live,
      prompt,
      session: "live",
      kind: "ingest",
      stream: true,
      correlationId: e.id,
      createdUtc: new Date().toISOString(),
    };
  }
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
  if (e.preset) spec.preset = e.preset;
  if (e.cwd) spec.cwd = e.cwd;
  if (e.agentId) spec.agentId = e.agentId;
  if (e.model) spec.model = e.model;
  else if (!e.preset && opts.defaultModel) spec.model = opts.defaultModel;
  if (e.effort) spec.effort = e.effort;
  return spec;
}

function cryptoRandomUuid(): string {
  return globalThis.crypto.randomUUID();
}
