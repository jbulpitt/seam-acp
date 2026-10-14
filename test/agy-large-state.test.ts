import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { AgyTurnLifecycle } from "../packages/adapters/src/agy-lifecycle.js";
import { readAgyJsonResponse, subscribeToAgyStream } from "../packages/adapters/src/agy-stream.js";

afterEach(() => vi.restoreAllMocks());

it.each([11_571_566, 15_566_684, 13_113_103])("reads the observed %i-byte native resumed-state frame", async bytes => {
  const update = { status: "CASCADE_RUN_STATUS_IDLE", mainTrajectoryUpdate: {
    stepsUpdate: { indices: [851], steps: [{ type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
      plannerResponse: { modifiedResponse: "" } }] },
  } };
  const empty = JSON.stringify({ update });
  update.mainTrajectoryUpdate.stepsUpdate.steps[0]!.plannerResponse.modifiedResponse = "x".repeat(bytes - Buffer.byteLength(empty));
  const payload = Buffer.from(JSON.stringify({ update }));
  expect(payload.length).toBe(bytes);
  const header = Buffer.alloc(5); header.writeUInt32BE(bytes, 1);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(header.subarray(0, 2));
      controller.enqueue(Buffer.concat([header.subarray(2), payload.subarray(0, 8_000_000)]));
      controller.enqueue(payload.subarray(8_000_000));
    },
    cancel() { cancelled = true; },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
  const stream = subscribeToAgyStream({ port: 1, conversationId: "retained-cascade" });
  try {
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(first.value?.mainTrajectoryUpdate?.stepsUpdate?.indices).toEqual([851]);
    expect(first.value?.mainTrajectoryUpdate?.stepsUpdate?.steps?.[0]?.plannerResponse?.modifiedResponse).toHaveLength(bytes - Buffer.byteLength(empty));
  } finally { await stream.return(); }
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

it("names an oversized frame and its declared size before allocating the payload", async () => {
  const bytes = 64 * 1024 * 1024 + 1;
  const header = Buffer.alloc(5); header.writeUInt32BE(bytes, 1);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(header); }, cancel() { cancelled = true; } });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
  const stream = subscribeToAgyStream({ port: 1, conversationId: "retained-cascade" });
  await expect(stream.next()).rejects.toMatchObject({ code: "output_overflow",
    overflow: { limit: "StreamAgentStateUpdates frame", observedBytes: bytes, limitBytes: 64 * 1024 * 1024 } });
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

it("keeps the metadata bound but reports the specific limit and observed bytes", async () => {
  const bytes = 8 * 1024 * 1024 + 1;
  const error = await readAgyJsonResponse(new Response(new Uint8Array(bytes))).catch(error => error);
  expect(error).toMatchObject({ code: "output_overflow",
    overflow: { limit: "HTTP metadata", observedBytes: bytes, limitBytes: 8 * 1024 * 1024 } });
  expect(error.message).toContain("HTTP metadata");
  expect(error.message).toContain(String(bytes));
  expect(error.message).toContain(String(8 * 1024 * 1024));
});

it.each([false, true])("reports byte-count evidence for native %s stdout/stderr overflow", async structured => {
  const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: 0, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcess;
  const run = new AgyTurnLifecycle("overflow-evidence", 10_000);
  run.attach(child, structured, false);
  const bytes = structured ? 1_100_000 : 300_000;
  const source = structured ? child.stdout! : child.stderr!;
  try {
    source.emit("data", Buffer.alloc(bytes));
    const error = run.abort.signal.reason;
    expect(error).toMatchObject({ code: "output_overflow", overflow: {
      limit: structured ? "stdout" : "stderr", observedBytes: bytes,
      limitBytes: structured ? 1_000_000 : 256_000,
    } });
    expect(error.message).toContain(String(bytes));
  } finally { await run.close(); }
});
