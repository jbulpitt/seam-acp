import { Collection, MessagePayload } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import {
  DELIVERY_NONCE_LENGTH,
  deliveryNonce,
} from "../packages/core/src/core/dispatch/delivery-proof.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { pino } from "pino";
import { reconcileCompletedDoneFiles } from "../packages/core/src/core/dispatch/done-reconcile.js";
import { dispatchDirs } from "../packages/core/src/core/dispatch/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function bareAdapter(send: ReturnType<typeof vi.fn>, fetch?: ReturnType<typeof vi.fn>) {
  const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
  Object.assign(adapter as object, { client: { user: { id: "seam-bot" } } });
  (adapter as unknown as { fetchSendableChannel: unknown }).fetchSendableChannel = async () => ({
    send,
    messages: { fetch: fetch ?? vi.fn() },
  });
  return adapter;
}

describe("#305 Discord nonce delivery proof", () => {
  it("derives a stable Discord-sized nonce without exposing the dispatch id", () => {
    // Protects the 25-character Discord limit and id opacity; deleting it lets
    // raw UUIDs be rejected or durable dispatch ids leak into message metadata.
    expect(deliveryNonce("dispatch-305")).toBe("Zb2vDQoTQKsHKsy1kfvGLbSVK");
    expect(deliveryNonce("dispatch-305")).toHaveLength(DELIVERY_NONCE_LENGTH);
    expect(deliveryNonce("different-dispatch")).not.toBe("Zb2vDQoTQKsHKsy1kfvGLbSVK");
  });

  it("forwards nonce enforcement through the actual discord.js send path", async () => {
    const send = vi.fn(async () => ({ id: "discord-message" }));
    const adapter = bareAdapter(send);
    await adapter.sendMessage(
      { platform: "discord", id: "thread" },
      "captured result",
      { nonce: "nonce-305", enforceNonce: true }
    );
    // Protects the camelCase→discord.js production boundary; deleting these
    // fields makes accepted:true a local claim with no server deduplication.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: "captured result",
      nonce: "nonce-305",
      enforceNonce: true,
    }));

    const target = {
      client: {
        options: { enforceNonce: false, jsonTransformer: (value: unknown) => value },
        user: { id: "seam-bot" },
      },
    };
    const resolved = new MessagePayload(target as never, send.mock.calls[0]![0]);
    await resolved.resolveBody();
    // Protects the installed library contract itself; deleting it lets an
    // upgrade stop emitting Discord's wire-level `enforce_nonce` unnoticed.
    expect(resolved.body).toMatchObject({ nonce: "nonce-305", enforce_nonce: true });

    await adapter.sendPanel(
      { platform: "discord", id: "thread" },
      { color: 0x123456, title: "Result", description: "card body", fields: [] },
      { nonce: "panel-nonce-305", enforceNonce: true }
    );
    await adapter.sendFile(
      { platform: "discord", id: "thread" },
      { data: Buffer.from("file body"), filename: "result.txt", mimeType: "text/plain" },
      { nonce: "file-nonce-305", enforceNonce: true }
    );
    // Protects card/file recovery parity; deleting either forwarding branch
    // leaves non-text terminal results outside Discord's dedup contract.
    expect(send.mock.calls[1]![0]).toMatchObject({
      nonce: "panel-nonce-305",
      enforceNonce: true,
    });
    expect(send.mock.calls[2]![0]).toMatchObject({
      nonce: "file-nonce-305",
      enforceNonce: true,
    });
  });

  it("finds only this bot's nonce and reports a complete absence at the time boundary", async () => {
    const page = new Collection<string, any>([
      ["newer-human", { id: "newer-human", createdTimestamp: 2_000,
        author: { id: "human" }, nonce: "nonce-305" }],
      ["older-bot", { id: "older-bot", createdTimestamp: 1_000,
        author: { id: "seam-bot" }, nonce: "nonce-305" }],
    ]);
    const fetch = vi.fn(async () => page);
    const adapter = bareAdapter(vi.fn(), fetch);
    const channel = { platform: "discord", id: "thread" };
    await expect(adapter.findMessageByNonce(channel, "nonce-305", 900)).resolves.toEqual({
      status: "found",
      message: { channel, id: "older-bot" },
    });

    page.delete("older-bot");
    await expect(adapter.findMessageByNonce(channel, "nonce-305", 1_500)).resolves.toEqual({
      status: "absent",
    });
    // Protects author binding during lookup; deleting it lets a user's nonce
    // falsely prove that Seam delivered its terminal result.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("persists the exact nonce payload before send and refuses substitution", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-305-receipt-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new SessionStore(path.join(dir, "test.db"));
    cleanups.push(() => store.close());
    store.turnAttempts.registerOwner("boot");
    const attempt = store.turnAttempts.claim({
      id: "dispatch-305",
      target: "thread",
      prompt: "test",
      session: "live",
      createdUtc: "2026-09-11T00:00:00.000Z",
    }, "identity", "boot", "inbound");
    store.turnAttempts.complete(attempt, {
      id: attempt.id,
      target: "thread",
      status: "completed",
      output: "captured result",
      finishedUtc: "2026-09-11T00:00:01.000Z",
    });

    const receipt = store.turnAttempts.prepareDelivery(
      attempt.id,
      "thread",
      { kind: "message", text: "captured result" },
      "2026-09-11T00:00:02.000Z"
    );
    expect(receipt).toEqual({
      nonce: "Zb2vDQoTQKsHKsy1kfvGLbSVK",
      startedUtc: "2026-09-11T00:00:02.000Z",
    });
    expect(store.turnAttempts.get(attempt.id)).toMatchObject({
      deliveryDone: false,
      deliveryChannel: "thread",
      deliveryPayload: { kind: "message", text: "captured result" },
    });
    // Protects nonce/body binding; deleting it permits a different result to
    // be hidden behind Discord returning the first message for the same nonce.
    expect(() => store.turnAttempts.prepareDelivery(
      attempt.id,
      "thread",
      { kind: "message", text: "substituted" }
    )).toThrow(/receipt mismatch/);
  });

  it("terminalizes the exact nine legacy ids once with a durable reason", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-305-nine-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new SessionStore(path.join(dir, "test.db"));
    cleanups.push(() => store.close());
    const ids = [
      "8e21ecc2-e263-4dc1-ae5d-29b48b7e05ca",
      "8e187eb6-082c-40d1-8ee3-e7260e553da3",
      "7125db6f-5eef-49ef-be1c-a641f8c1391c",
      "66db5ca7-c170-4935-b6c0-53eb7c186346",
      "63f78e8c-923a-472e-a89c-a0ad9cb2d6e4",
      "5f24ef14-180a-43f1-ae8f-ff4832e256a2",
      "39fd0f86-83f0-4a18-9a96-a10a6b15d531",
      "1abfe6fc-9303-4861-9168-0e1cbce3a7d7",
      "03553f25-857e-4516-bdab-81c168bbbb96",
    ];
    const done = dispatchDirs(dir).done;
    await mkdir(done, { recursive: true });
    for (const id of ids) {
      store.recordDelegation({
        id,
        kind: "handoff",
        targetRef: "thread",
        correlationId: id,
        status: "interrupted",
      });
      await writeFile(path.join(done, `${id}.json`), JSON.stringify({
        id,
        target: "thread",
        status: "completed",
        finishedUtc: "2026-09-03T00:00:00.000Z",
      }));
    }
    const reconcile = () => reconcileCompletedDoneFiles({
      dataDir: dir,
      logger: pino({ level: "silent" }),
      getDelegation: (id) => store.getDelegation(id),
      listRecoveryCandidates: (after, limit) => store.listNonTerminalDelegations(after, limit),
      replay: async () => {},
      abandonUnprovable: (id, reason) => store.abandonUnprovableDelivery(id, reason),
    });

    const first = await reconcile();
    expect(first).toMatchObject({ recoveryCandidates: 9, abandonedUnprovable: 9, failed: 0 });
    for (const id of ids) {
      expect(store.getDelegation(id)).toMatchObject({
        status: "abandoned",
        terminalReason: expect.stringContaining("cannot be proven"),
      });
    }
    const second = await reconcile();
    // Protects the production backlog from permanent boot churn; deleting the
    // terminal reason/transition makes these same ids candidates indefinitely.
    expect(second).toMatchObject({ recoveryCandidates: 0, abandonedUnprovable: 0 });
  });
});
