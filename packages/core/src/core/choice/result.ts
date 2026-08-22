/**
 * Declared HTTP result channel (#92). First successful submit wins.
 * MCP `submit_result` and `seam-result` fences share {@link acceptChoiceResult}.
 */
import type { SessionStore } from "../session-store.js";
import type { Logger } from "../../lib/logger.js";

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
};

export function validateAgainstSchema(
  schema: unknown,
  value: unknown
): { ok: true } | { ok: false; error: string } {
  if (schema == null) return { ok: true };
  if (typeof schema !== "object") {
    return { ok: false, error: "resultSchema must be an object" };
  }
  return check(schema as JsonSchema, value, "$");
}

function check(schema: JsonSchema, value: unknown, path: string): { ok: true } | { ok: false; error: string } {
  if (schema.enum && !schema.enum.some((e) => Object.is(e, value))) {
    return { ok: false, error: `${path} is not one of the allowed enum values` };
  }
  const types = schema.type == null ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((t) => matchesType(t, value))) {
    return { ok: false, error: `${path} should be ${types.join("|")} (got ${valueType(value)})` };
  }
  if (types.includes("object") || (schema.properties && isPlainObject(value))) {
    if (!isPlainObject(value)) {
      if (types.includes("object")) return { ok: false, error: `${path} should be object` };
    } else {
      const required = schema.required ?? [];
      for (const key of required) {
        if (!(key in value)) return { ok: false, error: `${path} missing required property "${key}"` };
      }
      if (schema.properties) {
        for (const [key, child] of Object.entries(schema.properties)) {
          if (key in value) {
            const inner = check(child, (value as Record<string, unknown>)[key], `${path}.${key}`);
            if (!inner.ok) return inner;
          }
        }
      }
      if (schema.additionalProperties === false && schema.properties) {
        for (const key of Object.keys(value)) {
          if (!(key in schema.properties)) {
            return { ok: false, error: `${path} has unexpected property "${key}"` };
          }
        }
      }
    }
  }
  if ((types.includes("array") || schema.items) && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const inner = check(schema.items, value[i], `${path}[${i}]`);
      if (!inner.ok) return inner;
    }
  }
  return { ok: true };
}

function matchesType(t: string, value: unknown): boolean {
  switch (t) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && (t === "number" || Number.isInteger(value));
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function valueType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

interface Waiter {
  schema: unknown;
  choiceId: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  settled: boolean;
}

/**
 * In-memory waiters keyed by dispatch id, plus session/channel bindings so
 * submit_result / seam-result can find the waiter from the running turn.
 * Durable copy lives in `choice_results` (202 poll after timeout / restart).
 */
export class ChoiceResultHub {
  private readonly waiters = new Map<string, Waiter>();
  private readonly sessionToDispatch = new Map<string, string>();
  private readonly channelToDispatch = new Map<string, string>();
  private readonly store: SessionStore;
  private readonly logger: Logger;

  constructor(opts: { store: SessionStore; logger: Logger }) {
    this.store = opts.store;
    this.logger = opts.logger;
  }

  expect(opts: { dispatchId: string; choiceId: string; schema: unknown }): Promise<unknown> {
    const existing = this.waiters.get(opts.dispatchId);
    if (existing && !existing.settled) {
      return new Promise((resolve, reject) => {
        const prevResolve = existing.resolve;
        const prevReject = existing.reject;
        existing.resolve = (v) => {
          prevResolve(v);
          resolve(v);
        };
        existing.reject = (e) => {
          prevReject(e);
          reject(e);
        };
      });
    }
    return new Promise((resolve, reject) => {
      this.waiters.set(opts.dispatchId, {
        schema: opts.schema,
        choiceId: opts.choiceId,
        resolve,
        reject,
        settled: false,
      });
    });
  }

  bindSession(sessionId: string, dispatchId: string): void {
    this.sessionToDispatch.set(sessionId, dispatchId);
  }

  bindChannel(channelRef: string, dispatchId: string): void {
    this.channelToDispatch.set(channelRef, dispatchId);
  }

  unbindSession(sessionId: string): void {
    this.sessionToDispatch.delete(sessionId);
  }

  submitFromSession(
    sessionId: string,
    value: unknown
  ): { ok: true; dispatchId: string } | { ok: false; error: string } {
    const dispatchId = this.sessionToDispatch.get(sessionId);
    if (!dispatchId) {
      return { ok: false, error: "No ingest waiter for this turn — submit_result is only for HTTP ingest turns." };
    }
    return this.submitFromDispatch(dispatchId, value);
  }

  submitFromChannel(
    channelRef: string,
    value: unknown
  ): { ok: true; dispatchId: string } | { ok: false; error: string } {
    const dispatchId = this.channelToDispatch.get(channelRef);
    if (!dispatchId) {
      return { ok: false, error: "No ingest waiter for this turn — submit_result is only for HTTP ingest turns." };
    }
    return this.submitFromDispatch(dispatchId, value);
  }

  submitFromDispatch(
    dispatchId: string,
    value: unknown
  ): { ok: true; dispatchId: string } | { ok: false; error: string } {
    const w = this.waiters.get(dispatchId);
    const row = this.store.getChoiceResult(dispatchId);
    const schema = w?.schema ?? row?.schema ?? null;
    if (row?.status === "ok") {
      return { ok: false, error: "A result was already submitted for this turn (first call wins)." };
    }
    const checked = validateAgainstSchema(schema, value);
    if (!checked.ok) return checked;
    this.store.finishChoiceResult(dispatchId, "ok", value, null);
    if (w && !w.settled) {
      w.settled = true;
      w.resolve(value);
    }
    return { ok: true, dispatchId };
  }

  turnEnded(dispatchId: string): void {
    const w = this.waiters.get(dispatchId);
    const row = this.store.getChoiceResult(dispatchId);
    if (row?.status === "ok") {
      this.waiters.delete(dispatchId);
      return;
    }
    this.store.finishChoiceResult(dispatchId, "missing", null, "turn ended with no submit_result / seam-result");
    if (w && !w.settled) {
      w.settled = true;
      w.reject(new Error("turn ended with no declared result"));
    }
    this.waiters.delete(dispatchId);
    for (const [sid, id] of this.sessionToDispatch) {
      if (id === dispatchId) this.sessionToDispatch.delete(sid);
    }
    for (const [ch, id] of this.channelToDispatch) {
      if (id === dispatchId) this.channelToDispatch.delete(ch);
    }
  }
}

export function parseResultFence(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(content.trim());
    return { ok: true, value };
  } catch {
    return { ok: false, error: "seam-result body must be JSON" };
  }
}

/** Pull a ```seam-result JSON fence out of captured agent text (isolated
 *  dispatch may not run the live fence intercept). */
export function extractSeamResultFromText(
  text: string
): { ok: true; value: unknown } | { ok: false } {
  const m = text.match(/```seam-result\s*\n([\s\S]*?)```/i);
  if (!m?.[1]) return { ok: false };
  const parsed = parseResultFence(m[1]);
  return parsed.ok ? parsed : { ok: false };
}
