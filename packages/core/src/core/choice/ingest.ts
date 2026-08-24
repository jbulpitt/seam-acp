/**
 * HTTP ingress for frozen choice cards (#92). POST /ingest is a custom-option
 * submit: auth is the site token, payload is the body, routing is emitChoice.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { hashBridgeToken } from "../bridge-pairing.js";
import type { Logger } from "../../lib/logger.js";
import type { SessionStore } from "../session-store.js";
import type { DispatchSpec } from "../dispatch/types.js";
import type { SessionRecord } from "../types.js";
import { emitChoice, type ChoiceActor } from "./emit.js";
import { ChoiceResultHub } from "./result.js";
import type { ChoiceCard } from "./types.js";
import {
  planEndpointDispatch,
  type IngestEndpoint,
} from "./endpoint.js";

export const INGEST_PATH = "/ingest";
/** How long POST /ingest holds for submit_result before 202 + poll.
 *  5 min covers a cold isolated grok spawn; longer grading should poll
 *  (Cloudflare proxied POST dies around 100s — use ?wait=0 then GET the job). */
export const DEFAULT_INGEST_WAIT_MS = 300_000;
export const DEFAULT_INGEST_BODY_MAX = 65_536;
export const DEFAULT_INGEST_RATE_PER_MIN = 60;

export interface ChoiceIngestOpts {
  store: SessionStore;
  results: ChoiceResultHub;
  logger: Logger;
  enqueue: (spec: DispatchSpec) => Promise<void>;
  destLive: (card: ChoiceCard, optionIndex: number) => Promise<"ok" | "gone" | "archived">;
  authoringSession: (channelRef: string) => SessionRecord | null;
  publicBase: () => string;
  waitMs?: number;
  bodyMax?: number;
  ratePerMin?: number;
  defaultModel?: string;
  now?: () => number;
}

export class ChoiceIngest {
  private readonly store: SessionStore;
  private readonly results: ChoiceResultHub;
  private readonly logger: Logger;
  private readonly enqueue: (spec: DispatchSpec) => Promise<void>;
  private readonly destLive: ChoiceIngestOpts["destLive"];
  private readonly authoringSession: ChoiceIngestOpts["authoringSession"];
  private readonly publicBase: () => string;
  private readonly waitMs: number;
  private readonly bodyMax: number;
  private readonly ratePerMin: number;
  private readonly defaultModel?: string;
  private readonly now: () => number;
  private readonly hits = new Map<string, number[]>();

  constructor(opts: ChoiceIngestOpts) {
    this.store = opts.store;
    this.results = opts.results;
    this.logger = opts.logger;
    this.enqueue = opts.enqueue;
    this.destLive = opts.destLive;
    this.authoringSession = opts.authoringSession;
    this.publicBase = opts.publicBase;
    this.waitMs = opts.waitMs ?? DEFAULT_INGEST_WAIT_MS;
    this.bodyMax = opts.bodyMax ?? DEFAULT_INGEST_BODY_MAX;
    this.ratePerMin = opts.ratePerMin ?? DEFAULT_INGEST_RATE_PER_MIN;
    this.defaultModel = opts.defaultModel;
    this.now = opts.now ?? Date.now;
  }

  ingestUrl(): string {
    return `${this.publicBase().replace(/\/+$/, "")}${INGEST_PATH}`;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://ingest.local");
    if (req.method === "OPTIONS") {
      this.cors(res, req, []);
      res.writeHead(204);
      res.end();
      return;
    }
    const token = bearerToken(req) ?? url.searchParams.get("token") ?? "";
    if (!token) {
      json(res, 401, { error: "missing ingest token (Authorization: Bearer)" });
      return;
    }
    const hash = hashBridgeToken(token);
    const card = this.store.getChoiceCardByIngestHash(hash);
    const endpoint = this.store.getIngestEndpointByTokenHash(hash);
    if ((!card || !card.ingestTokenHash) && !endpoint) {
      json(res, 401, { error: "invalid ingest token" });
      return;
    }
    const cors = card?.ingestCors ?? endpoint?.corsOrigins ?? [];
    const rateKey = card?.ingestTokenHash ?? endpoint!.tokenHash;
    this.cors(res, req, cors);
    if (req.method === "GET" && url.pathname.startsWith(`${INGEST_PATH}/jobs/`)) {
      const dispatchId = url.pathname.slice(`${INGEST_PATH}/jobs/`.length).replace(/\/+$/, "");
      const ownerId = card?.id ?? endpoint!.id;
      await this.handlePoll(res, ownerId, dispatchId);
      return;
    }
    if (req.method !== "POST" || url.pathname.replace(/\/+$/, "") !== INGEST_PATH) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (!this.rateOk(rateKey)) {
      json(res, 429, { error: "rate limited" });
      return;
    }
    const waitQ = url.searchParams.get("wait");
    const waitMs = waitQ === "0" ? 0 : this.waitMs;
    if (endpoint) {
      await this.handleEndpointPost(req, res, endpoint, waitMs);
      return;
    }
    await this.handlePost(req, res, card!, waitMs);
  }

  private async handlePoll(res: ServerResponse, ownerId: string, dispatchId: string): Promise<void> {
    const row = this.store.getChoiceResult(dispatchId);
    if (!row || row.choiceId !== ownerId) {
      json(res, 404, { error: "unknown job" });
      return;
    }
    if (row.status === "pending") {
      json(res, 202, { jobId: dispatchId, status: "pending" });
      return;
    }
    if (row.status === "ok") {
      json(res, 200, row.body);
      return;
    }
    // 422 not 5xx: Cloudflare replaces 504 JSON with plaintext "error code: 504".
    this.respondNoResult(res, dispatchId, row);
  }

  /** Job finished without a declared result (`missing` / `error`). Non-5xx so proxies keep JSON. */
  private respondNoResult(
    res: ServerResponse,
    dispatchId: string,
    row?: { status: string; error: string | null } | null
  ): void {
    const r = row ?? this.store.getChoiceResult(dispatchId);
    json(res, 422, {
      error: r?.error ?? "no declared result",
      jobId: dispatchId,
      status: r?.status ?? "missing",
    });
  }

  private async handlePost(
    req: IncomingMessage,
    res: ServerResponse,
    card: ChoiceCard,
    waitMs: number
  ): Promise<void> {
    if (card.status !== "open") {
      json(res, 409, { error: "this card is closed" });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, this.bodyMax);
    } catch {
      json(res, 413, { error: `body exceeds ${this.bodyMax} bytes` });
      return;
    }
    const parsed = parseIngestBody(raw, req.headers["content-type"]);
    const optionIndex = card.ingestOptionIndex ?? 0;
    const option = card.options[optionIndex];
    if (!option) {
      json(res, 400, { error: "ingest option is missing on this card" });
      return;
    }
    const studentId = typeof parsed.studentId === "string" ? parsed.studentId.trim().slice(0, 80) : "";
    const studentKey = studentId || `anon:${randomUUID()}`;
    const actor: ChoiceActor = {
      id: `ingest:${card.id}:${studentKey}`,
      name: studentId ? `ingest:${studentId}` : "ingest",
    };
    const payload = buildIngestPayload(parsed, card.ingestWrapper, option.payload);
    const destLive = await this.destLive(card, optionIndex);
    if (destLive === "gone" || destLive === "archived") {
      json(res, 409, {
        error: destLive === "gone" ? "destination thread is gone" : "destination thread is archived",
      });
      return;
    }
    const claimed = this.store.claimChoiceClick({
      choiceId: card.id,
      userId: actor.id,
      userName: actor.name,
      optionIndex,
    });
    if (!claimed.ok) {
      const msg =
        claimed.reason === "already-clicked"
          ? "this student already submitted"
          : claimed.reason === "exhausted"
            ? "this card is already taken"
            : "this card is closed";
      json(res, 409, { error: msg });
      return;
    }
    const emitted = await emitChoice({
      card: claimed.card,
      optionIndex,
      actor,
      payload,
      enqueue: this.enqueue,
      authoringSession: this.authoringSession(card.channelRef),
      destLive,
      defaultModel: this.defaultModel,
      source: "http",
      ...(card.ingestWrapper ? { wrapper: card.ingestWrapper } : {}),
      ...(studentId ? { untrustedStudentId: studentId } : {}),
    });
    if (!emitted.ok) {
      json(res, 409, { error: emitted.error });
      return;
    }
    this.store.setChoiceClickDelivery(card.id, actor.id, emitted.dispatchId);
    const now = new Date().toISOString();
    this.store.insertChoiceResult({
      dispatchId: emitted.dispatchId,
      choiceId: card.id,
      status: "pending",
      body: null,
      error: null,
      schema: card.resultSchema,
      createdUtc: now,
      finishedUtc: null,
    });
    const pending = this.results.expect({
      dispatchId: emitted.dispatchId,
      choiceId: card.id,
      schema: card.resultSchema,
    });
    const timed = await withTimeout(pending, waitMs);
    if (timed.status === "ok") {
      json(res, 200, timed.value);
      return;
    }
    if (timed.status === "ended") {
      this.respondNoResult(res, emitted.dispatchId);
      return;
    }
    json(res, 202, {
      jobId: emitted.dispatchId,
      status: "pending",
      poll: `${INGEST_PATH}/jobs/${emitted.dispatchId}`,
    });
  }

  private async handleEndpointPost(
    req: IncomingMessage,
    res: ServerResponse,
    endpoint: IngestEndpoint,
    waitMs: number
  ): Promise<void> {
    if (endpoint.status !== "open") {
      json(res, 409, { error: "this endpoint is revoked" });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, this.bodyMax);
    } catch {
      json(res, 413, { error: `body exceeds ${this.bodyMax} bytes` });
      return;
    }
    const parsed = parseIngestBody(raw, req.headers["content-type"]);
    const studentId = typeof parsed.studentId === "string" ? parsed.studentId.trim().slice(0, 80) : "";
    if (endpoint.uniqueStudent && studentId) {
      const claimed = this.store.claimIngestStudent(endpoint.id, studentId);
      if (!claimed.ok) {
        json(res, 409, { error: "this student already submitted" });
        return;
      }
    }
    const payload = buildIngestPayload(parsed, endpoint.wrapper, undefined);
    const spec = planEndpointDispatch({
      endpoint,
      payload,
      ...(studentId ? { untrustedStudentId: studentId } : {}),
      defaultModel: this.defaultModel,
    });
    await this.enqueue(spec);
    const now = new Date().toISOString();
    this.store.insertChoiceResult({
      dispatchId: spec.id,
      choiceId: endpoint.id,
      status: "pending",
      body: null,
      error: null,
      schema: endpoint.resultSchema,
      createdUtc: now,
      finishedUtc: null,
    });
    const pending = this.results.expect({
      dispatchId: spec.id,
      choiceId: endpoint.id,
      schema: endpoint.resultSchema,
    });
    const timed = await withTimeout(pending, waitMs);
    if (timed.status === "ok") {
      json(res, 200, timed.value);
      return;
    }
    if (timed.status === "ended") {
      this.respondNoResult(res, spec.id);
      return;
    }
    json(res, 202, {
      jobId: spec.id,
      status: "pending",
      poll: `${INGEST_PATH}/jobs/${spec.id}`,
    });
  }

  private cors(res: ServerResponse, req: IncomingMessage, allow: string[]): void {
    const origin = req.headers.origin;
    const allowed =
      allow.length === 0
        ? origin ?? "*"
        : origin && allow.includes(origin)
          ? origin
          : allow[0]!;
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Vary", "Origin");
  }

  private rateOk(tokenHash: string): boolean {
    const t = this.now();
    const windowStart = t - 60_000;
    const prev = (this.hits.get(tokenHash) ?? []).filter((x) => x > windowStart);
    if (prev.length >= this.ratePerMin) {
      this.hits.set(tokenHash, prev);
      return false;
    }
    prev.push(t);
    this.hits.set(tokenHash, prev);
    return true;
  }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || undefined;
  }
  const alt = req.headers["x-seam-ingest"];
  if (typeof alt === "string" && alt.trim()) return alt.trim();
  return undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) {
        req.destroy();
        reject(new Error("too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function parseIngestBody(raw: string, contentType: string | undefined): Record<string, unknown> {
  const ct = (contentType ?? "").toLowerCase();
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (ct.includes("application/x-www-form-urlencoded")) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(trimmed)) out[k] = v;
    return out;
  }
  try {
    const v: unknown = JSON.parse(trimmed);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return { text: trimmed };
  } catch {
    return { text: raw };
  }
}

export function buildIngestPayload(
  body: Record<string, unknown>,
  _wrapper: string | null,
  optionPayload: string | undefined
): string {
  const copy = { ...body };
  delete copy.studentId;
  if (typeof copy.text === "string" && copy.text.trim() && Object.keys(copy).length === 1) {
    return stitch(optionPayload, copy.text);
  }
  if (typeof copy.essay === "string" && Object.keys(copy).length === 1) {
    return stitch(optionPayload, copy.essay);
  }
  const encoded = JSON.stringify(copy, null, 2);
  return stitch(optionPayload, encoded === "{}" ? "" : encoded);
}

function stitch(optionPayload: string | undefined, submission: string): string {
  const frozen = (optionPayload ?? "").trim();
  const sub = submission.trim();
  if (frozen && sub) return `${frozen}\n\n${sub}`;
  return frozen || sub;
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number
): Promise<{ status: "ok"; value: T } | { status: "timeout" } | { status: "ended"; error: string }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ status: "timeout" }), ms);
    p.then((value) => {
      clearTimeout(t);
      resolve({ status: "ok", value });
    }).catch((err: unknown) => {
      clearTimeout(t);
      resolve({
        status: "ended",
        error: err instanceof Error ? err.message : "no declared result",
      });
    });
  });
}
