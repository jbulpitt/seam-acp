import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { discoverAgyLs, readAgyJsonResponse, subscribeToAgyStream, waitForAgyConversationId } from "../packages/adapters/src/agy-stream.js";

afterEach(() => vi.restoreAllMocks());

it("releases the production subscription reader when its consumer breaks", async () => {
  let cancelled = false;
  const json = Buffer.from('{"update":{"status":"RUNNING"}}');
  const header = Buffer.alloc(5); header.writeUInt32BE(json.length, 1);
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.concat([header, json])); },
    cancel() { cancelled = true; },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
  for await (const update of subscribeToAgyStream({ port: 1, conversationId: "fixture" })) {
    expect(update.status).toBe("RUNNING");
    break;
  }
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

it.each([
  [0, 0, 0, 0, 4, 123], // truncated payload
  [1, 0, 0, 0, 2, 123, 125], // unsupported compression, otherwise VALID JSON
])("rejects incomplete/unsupported frames instead of silently completing (%j)", async (...bytes) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array(bytes)));
  await expect((async () => {
    for await (const _ of subscribeToAgyStream({ port: 1, conversationId: "fixture" })) { /* drain */ }
  })()).rejects.toMatchObject({ code: "protocol_error" });
});

it("caps HTTP metadata before parsing and closes the response", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  await expect(readAgyJsonResponse(new Response(body))).rejects.toMatchObject({ code: "output_overflow" });
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

it("accepts coalesced valid frames whose total chunk exceeds the per-frame limit", async () => {
  const payload = Buffer.from(JSON.stringify({ update: { status: "RUNNING", text: "x".repeat(5 * 1024 * 1024) } }));
  const header = Buffer.alloc(5); header.writeUInt32BE(payload.length, 1);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Buffer.concat([header, payload, header, payload])));
  const statuses: unknown[] = [];
  for await (const update of subscribeToAgyStream({ port: 1, conversationId: "fixture" })) statuses.push(update.status);
  expect(statuses).toEqual(["RUNNING", "RUNNING"]);
});

it("caps the private startup log for both discovery readers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-r5-log-"));
  const file = path.join(root, "fixture.log");
  try {
    await fs.writeFile(file, new Uint8Array(8 * 1024 * 1024 + 1));
    await expect(discoverAgyLs({ logFile: file })).rejects.toMatchObject({ code: "output_overflow" });
    await expect(waitForAgyConversationId({ logFile: file })).rejects.toMatchObject({ code: "output_overflow" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("the discovery deadline bounds a hanging health request too", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-r5-health-"));
  const file = path.join(root, "fixture.log");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Promise((_, reject) => {
    const signal = init!.signal!;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  try {
    await fs.writeFile(file, "port at 1 for HTTP\n");
    const start = Date.now();
    await expect(discoverAgyLs({ logFile: file, timeoutMs: 30 })).rejects.toThrow("did not appear");
    expect(Date.now() - start).toBeLessThan(500);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
