/**
 * Drive a test deployment's clicks and slash commands. The test deployment
 * serves POST /test/interaction behind a shared key; the driving deployment
 * calls it for agents through tester_interact.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../lib/logger.js";
import type { TestInteractionSpec, TranscriptEntry } from "../platforms/discord/synthetic-interaction.js";

export interface TestInteractionResult {
  transcript: TranscriptEntry[];
  replied: boolean;
  deferred: boolean;
}

export interface TestInventory {
  controllerInstanceId: string;
  branch: string;
  commit: string;
  bridges: Array<{
    host: string;
    instanceId: string;
    ready: boolean;
    agents: Array<{
      id: string;
      installed: boolean;
      ready: boolean;
      reason?: string;
      withheld?: boolean;
    }>;
  }>;
}

export type TestRestartAction = "controller" | "bridge" | "controller_bridge" | "sessiond";

export interface TestRestartResult {
  accepted: true;
  action: TestRestartAction;
}

export interface TestDispatchSpec {
  id: string;
  channelId: string;
  prompt: string;
}

export interface TestDispatchResult {
  accepted: true;
  id: string;
}

const MAX_BODY = 64 * 1024;

function keyMatches(given: string | undefined, key: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function makeTestInteractionHandler(opts: {
  key: string;
  actorId: string;
  inject: (spec: TestInteractionSpec, actorId: string) => Promise<TestInteractionResult>;
  logger: Logger;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    const auth = req.headers.authorization;
    const given = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!keyMatches(given, opts.key)) return send(res, 401, { error: "unauthorized" });
    let spec: TestInteractionSpec;
    try {
      spec = (await readJson(req)) as TestInteractionSpec;
    } catch (err) {
      return send(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
    }
    try {
      const result = await opts.inject(spec, opts.actorId);
      opts.logger.info({ kind: spec.kind, channelId: spec.channelId, ops: result.transcript.length }, "test interaction injected");
      send(res, 200, result);
    } catch (err) {
      send(res, 422, { error: (err as Error).message });
    }
  };
}

export function makeTestInventoryHandler(opts: {
  key: string;
  inventory: () => TestInventory | Promise<TestInventory>;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "GET") return send(res, 405, { error: "GET only" });
    const auth = req.headers.authorization;
    const given = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!keyMatches(given, opts.key)) return send(res, 401, { error: "unauthorized" });
    send(res, 200, await opts.inventory());
  };
}

export function makeTestRestartHandler(opts: {
  key: string;
  prepare: (action: TestRestartAction) => () => void;
  logger: Logger;
  delayMs?: number;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    const auth = req.headers.authorization;
    const given = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!keyMatches(given, opts.key)) return send(res, 401, { error: "unauthorized" });
    let action: TestRestartAction;
    try {
      const body = await readJson(req) as { action?: unknown };
      if (
        body.action !== "controller" &&
        body.action !== "bridge" &&
        body.action !== "controller_bridge" &&
        body.action !== "sessiond"
      ) {
        return send(res, 400, { error: "action must be controller, bridge, controller_bridge, or sessiond" });
      }
      action = body.action;
    } catch (err) {
      return send(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
    }

    let restart: () => void;
    try {
      restart = opts.prepare(action);
    } catch (err) {
      return send(res, 422, { error: (err as Error).message });
    }

    send(res, 202, { accepted: true, action });
    const timer = setTimeout(() => {
      try {
        restart();
        opts.logger.warn({ action }, "test durability restart triggered");
      } catch (err) {
        opts.logger.error({ err, action }, "test durability restart failed to launch");
      }
    }, opts.delayMs ?? 250);
    timer.unref();
  };
}

export function makeTestDispatchHandler(opts: {
  key: string;
  enqueue: (spec: TestDispatchSpec) => Promise<void>;
  logger: Logger;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    const auth = req.headers.authorization;
    const given = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!keyMatches(given, opts.key)) return send(res, 401, { error: "unauthorized" });
    let spec: TestDispatchSpec;
    try {
      const body = await readJson(req) as Partial<TestDispatchSpec>;
      if (typeof body.id !== "string" || body.id.length === 0 || body.id.length > 200) {
        return send(res, 400, { error: "id must be a non-empty string of at most 200 characters" });
      }
      if (typeof body.channelId !== "string" || !/^\d+$/.test(body.channelId)) {
        return send(res, 400, { error: "channelId must be a Discord snowflake" });
      }
      if (typeof body.prompt !== "string" || body.prompt.length === 0 || body.prompt.length > 8_000) {
        return send(res, 400, { error: "prompt must be a non-empty string of at most 8000 characters" });
      }
      spec = { id: body.id, channelId: body.channelId, prompt: body.prompt };
    } catch (err) {
      return send(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
    }
    try {
      await opts.enqueue(spec);
      opts.logger.info({ id: spec.id, channelId: spec.channelId }, "test dispatch enqueued");
      send(res, 202, { accepted: true, id: spec.id });
    } catch (err) {
      send(res, 422, { error: (err as Error).message });
    }
  };
}

export class TestDriverClient {
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async interact(spec: TestInteractionSpec): Promise<TestInteractionResult> {
    const res = await this.fetchFn(`${this.url.replace(/\/+$/, "")}/test/interaction`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json().catch(() => ({}))) as TestInteractionResult & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `test driver returned ${res.status}`);
    return body;
  }

  async inventory(): Promise<TestInventory> {
    const res = await this.fetchFn(`${this.url.replace(/\/+$/, "")}/test/inventory`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as TestInventory & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `test inventory returned ${res.status}`);
    return body;
  }

  async health(): Promise<void> {
    const res = await this.fetchFn(`${this.url.replace(/\/+$/, "")}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`test health returned ${res.status}`);
  }

  async restart(action: TestRestartAction): Promise<TestRestartResult> {
    const res = await this.fetchFn(`${this.url.replace(/\/+$/, "")}/test/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as TestRestartResult & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `test restart returned ${res.status}`);
    return body;
  }

  async dispatch(spec: TestDispatchSpec): Promise<TestDispatchResult> {
    const res = await this.fetchFn(`${this.url.replace(/\/+$/, "")}/test/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as TestDispatchResult & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `test dispatch returned ${res.status}`);
    return body;
  }
}
