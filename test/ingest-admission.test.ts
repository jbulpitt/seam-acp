import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { hashBridgeToken, mintBridgeToken } from "../packages/core/src/core/bridge-pairing.js";
import { ChoiceIngest } from "../packages/core/src/core/choice/ingest.js";
import {
  ChoiceResultHub,
  reconcileInterruptedChoiceAdmissions,
} from "../packages/core/src/core/choice/result.js";
import type { IngestEndpoint } from "../packages/core/src/core/choice/endpoint.js";
import type { ChoiceCard } from "../packages/core/src/core/choice/types.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import {
  dispatchDirs,
  enqueueDispatchSpec,
  type DispatchSpec,
} from "../packages/core/src/core/dispatch/types.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dataDir: string;
let store: SessionStore;
const servers: Server[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "seam-ingest-admission-"));
  store = new SessionStore(path.join(dataDir, "test.db"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

function endpoint(tokenHash: string): IngestEndpoint {
  return {
    id: "ie_admission",
    tokenHash,
    name: "admission-race",
    cwd: "/repo",
    location: "local",
    agentId: "claude",
    model: "default",
    effort: null,
    wrapper: "Return the fixture result.",
    resultSchema: {
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "number" } },
    },
    corsOrigins: null,
    uniqueStudent: false,
    notifyThread: null,
    thread: null,
    preset: null,
    status: "open",
    createdBy: "discord:thread-1",
    createdUtc: "2026-09-09T00:00:00.000Z",
    authoringChannelRef: "thread-1",
    authoringParentRef: "parent-1",
    platform: "discord",
  };
}

function card(tokenHash: string): ChoiceCard {
  return {
    id: "choice_admission",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "parent-1",
    messageId: "message-1",
    title: "Admission race",
    body: null,
    maxClicks: 5,
    targetUserId: null,
    defaultTarget: { type: "live" },
    options: [{ label: "Submit", kind: "custom", target: { type: "live" } }],
    clickCount: 0,
    status: "open",
    lastClickerId: null,
    lastClickerName: null,
    lastOptionIndex: null,
    createdBy: "discord:thread-1",
    createdUtc: "2026-09-09T00:00:00.000Z",
    ingestTokenHash: tokenHash,
    ingestOptionIndex: 0,
    resultSchema: {
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "number" } },
    },
    ingestWrapper: "Return the fixture result.",
    ingestCors: null,
  };
}

function authoringSession(): SessionRecord {
  return {
    id: "discord:thread-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "parent-1",
    agentId: "claude",
    acpSessionId: "acp-fixture",
    repoPath: "/repo",
    configJson: "{}",
    createdUtc: "2026-09-09T00:00:00.000Z",
    updatedUtc: "2026-09-09T00:00:00.000Z",
  };
}

async function listen(ingest: ChoiceIngest): Promise<number> {
  const server = createServer((req, res) => void ingest.handle(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function exerciseFastCompletion(opts: {
  token: string;
  ownerId: string;
  ingest: (enqueue: (spec: DispatchSpec) => Promise<void>, results: ChoiceResultHub) => ChoiceIngest;
}): Promise<void> {
  const results = new ChoiceResultHub({ store, logger: silent });
  let workerSubmissions = 0;
  const watcher = new DispatchWatcher({ attempts: store.turnAttempts,
    dataDir,
    logger: silent,
    onDispatch: async (spec) => {
      workerSubmissions++;
      expect(store.getChoiceResult(spec.id)).toMatchObject({
        choiceId: opts.ownerId,
        status: expect.stringMatching(/^(admitting|pending)$/),
        schema: { type: "object" },
      });
      expect(results.submitFromDispatch(spec.id, { answer: 42 })).toEqual({
        ok: true,
        dispatchId: spec.id,
      });
      return { output: "fixture transcript is not the HTTP result", stopReason: "end_turn" };
    },
  });
  const ingest = opts.ingest(async (spec) => {
    await enqueueDispatchSpec(dataDir, spec);
    // Deterministically make the published job finish before enqueue returns.
    await watcher.start();
    watcher.stop();
  }, results);
  const port = await listen(ingest);

  const response = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "synthetic input", studentId: "fixture-student" }),
  });

  expect(workerSubmissions).toBe(1);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ answer: 42 });
  const doneFiles = await import("node:fs/promises").then(({ readdir }) =>
    readdir(dispatchDirs(dataDir).done)
  );
  expect(doneFiles).toHaveLength(1);
  const done = JSON.parse(
    await readFile(path.join(dispatchDirs(dataDir).done, doneFiles[0]!), "utf8")
  ) as { status: string };
  expect(done.status).toBe("completed");
}

describe("#247 durable ingest admission", () => {
  it("registers a headless endpoint result before runnable publication", async () => {
    const token = mintBridgeToken();
    store.insertIngestEndpoint(endpoint(hashBridgeToken(token)));
    await exerciseFastCompletion({
      token,
      ownerId: "ie_admission",
      ingest: (enqueue, results) =>
        new ChoiceIngest({
          store,
          results,
          logger: silent,
          enqueue,
          destLive: async () => "ok",
          authoringSession,
          publicBase: () => "http://127.0.0.1",
          waitMs: 2_000,
        }),
    });
  });

  it("registers a card-bound HTTP result before runnable publication", async () => {
    const token = mintBridgeToken();
    store.insertChoiceCard(card(hashBridgeToken(token)));
    await exerciseFastCompletion({
      token,
      ownerId: "choice_admission",
      ingest: (enqueue, results) =>
        new ChoiceIngest({
          store,
          results,
          logger: silent,
          enqueue,
          destLive: async () => "ok",
          authoringSession,
          publicBase: () => "http://127.0.0.1",
          waitMs: 2_000,
        }),
    });
  });

  it("refuses submit_result when no durable result identity was admitted", () => {
    const results = new ChoiceResultHub({ store, logger: silent });
    expect(results.submitFromDispatch("not-admitted", { answer: 42 })).toEqual({
      ok: false,
      error: "No admitted ingest result exists for this turn.",
    });
    expect(store.getChoiceResult("not-admitted")).toBeNull();
  });

  it.each(["endpoint", "card"] as const)(
    "terminalizes %s publication failure without leaving a runnable artifact",
    async (kind) => {
      const token = mintBridgeToken();
      if (kind === "endpoint") {
        store.insertIngestEndpoint(endpoint(hashBridgeToken(token)));
      } else {
        store.insertChoiceCard(card(hashBridgeToken(token)));
      }
      const results = new ChoiceResultHub({ store, logger: silent });
      const ingest = new ChoiceIngest({
        store,
        results,
        logger: silent,
        enqueue: async () => {
          throw new Error("hostile enqueue detail must not escape");
        },
        destLive: async () => "ok",
        authoringSession,
        publicBase: () => "http://127.0.0.1",
        waitMs: 2_000,
      });
      const port = await listen(ingest);

      const response = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "synthetic input", studentId: "fixture-student" }),
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as { jobId: string; status: string; error: string };
      expect(body).toMatchObject({
        status: "error",
        error: "dispatch admission failed before publication",
      });
      expect(body.error).not.toContain("hostile enqueue detail");
      expect(store.getChoiceResult(body.jobId)).toMatchObject({
        status: "error",
        finishedUtc: expect.any(String),
      });
      await expect(
        import("node:fs/promises").then(({ readdir }) => readdir(dispatchDirs(dataDir).pending))
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("terminalizes a restart-interrupted registration when no artifact was published", async () => {
    const beforeRestart = new ChoiceResultHub({ store, logger: silent });
    void beforeRestart
      .beginAdmission({ dispatchId: "registered-only", choiceId: "ie_admission", schema: { type: "object" } })
      .catch(() => {});
    expect(store.getChoiceResult("registered-only")?.status).toBe("admitting");

    // A new process has no waiter; recovery consults only durable evidence and
    // never invokes the worker callback.
    const recovered = await reconcileInterruptedChoiceAdmissions({
      store,
      logger: silent,
      dataDir,
    });
    expect(recovered).toEqual({
      inspected: 1,
      published: 0,
      failed: 1,
      deferred: 0,
      truncated: false,
    });
    expect(store.getChoiceResult("registered-only")).toMatchObject({
      status: "error",
      error: "ingest admission interrupted before dispatch publication",
      finishedUtc: expect.any(String),
    });
  });

  it("recovers an exact published artifact to pending without executing it", async () => {
    const results = new ChoiceResultHub({ store, logger: silent });
    void results
      .beginAdmission({ dispatchId: "published-not-acked", choiceId: "ie_admission", schema: null })
      .catch(() => {});
    await enqueueDispatchSpec(dataDir, {
      id: "published-not-acked",
      target: "ingest:ie_admission",
      prompt: "synthetic",
      session: "isolated",
      kind: "ingest",
      createdUtc: "2026-09-09T00:00:00.000Z",
    });
    let executions = 0;
    const recovered = await reconcileInterruptedChoiceAdmissions({
      store,
      logger: silent,
      dataDir,
      artifactState: async (dir, id) => {
        expect(dir).toBe(dataDir);
        expect(id).toBe("published-not-acked");
        return "pending";
      },
    });
    expect(recovered.published).toBe(1);
    expect(executions).toBe(0);
    expect(store.getChoiceResult("published-not-acked")?.status).toBe("pending");
    expect(await readFile(path.join(dispatchDirs(dataDir).pending, "published-not-acked.json"), "utf8"))
      .toContain("published-not-acked");
  });

  it("never overwrites a successful result during late publish, failure, or restart recovery", async () => {
    const results = new ChoiceResultHub({ store, logger: silent });
    const pending = results.beginAdmission({
      dispatchId: "fast-success",
      choiceId: "ie_admission",
      schema: { type: "object" },
    });
    expect(results.submitFromDispatch("fast-success", { answer: 42 }).ok).toBe(true);
    await expect(pending).resolves.toEqual({ answer: 42 });

    results.publishAdmission("fast-success");
    results.failAdmission("fast-success");
    const recovered = await reconcileInterruptedChoiceAdmissions({ store, logger: silent, dataDir });
    expect(recovered.inspected).toBe(0);
    expect(store.getChoiceResult("fast-success")).toMatchObject({
      status: "ok",
      body: { answer: 42 },
      error: null,
    });
    expect(results.submitFromDispatch("fast-success", { answer: 99 })).toEqual({
      ok: false,
      error: "A result was already submitted for this turn (first call wins).",
    });
  });
});
