import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { bindDoneDeliveryResolver, DoneRetention, pruneDoneArtifact, pruneDoneArtifacts } from "../packages/core/src/core/dispatch/done-retention.js";
import { createRuntimeDispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";

let dir: string;
let store: SessionStore;
const logger = pino({ level: "silent" });
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "seam-316-proof-"));
  store = new SessionStore(path.join(dir, "seam.db"));
  await mkdir(path.join(dir, "dispatch/done"), { recursive: true });
});
afterEach(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
const file = (id: string) => path.join(dir, "dispatch/done", `${id}.json`);
const deps = () => bindDoneDeliveryResolver({ dataDir: dir, logger,
  getDelegation: id => store.getDelegation(id),
  getReportBackByCorrelation: id => store.getReportBackByCorrelation(id),
  isAttemptDeliveryProven: id => store.turnAttempts.isDeliveryProven(id),
  getExpirationAuthorization: id => store.getDoneArtifactExpirationAuthorization(id),
});
async function artifact(id: string, routing: Record<string, string> = {}): Promise<void> {
  await writeFile(file(id), JSON.stringify({ id, target: "synthetic-thread", kind: "wake",
    status: "completed", finishedUtc: new Date().toISOString(), output: "private synthetic output", ...routing }));
}
async function direct(id: string): Promise<void> {
  store.recordDelegation({ id, kind: "wake", status: "completed" });
  const a = store.turnAttempts.claim({ id, target: "synthetic-thread", prompt: "never run", session: "live", createdUtc: new Date().toISOString() }, "fixture", "owner");
  store.turnAttempts.complete(a, { id, target: "synthetic-thread", status: "completed", output: "private synthetic output", finishedUtc: new Date().toISOString() });
  await artifact(id);
}

describe("#316 corrected deletion contract", () => {
  it.each(["failed", "timed_out", "abandoned"] as const)("retains a %s onward child despite a terminal parent", async status => {
    store.recordDelegation({ id: "parent", kind: "handoff", status: "completed" });
    store.recordDelegation({ id: "child", kind: "report_back", status, correlationId: "parent" });
    store.updateDelegationStatus("child", status, { terminalReason: "automatic disposition is not delivery" });
    await artifact("parent", { kind: "handoff", returnTo: "origin" });
    // Removing exact positive proof deletes the only local output when onward delivery failed.
    expect(pruneDoneArtifact(deps(), "parent").state).toBe("retained");
    await expect(access(file("parent"))).resolves.toBeUndefined();
    store.updateDelegationStatus("child", "completed");
    // Removing completed-child evidence strands genuinely delivered parent artifacts forever.
    expect(pruneDoneArtifact(deps(), "parent").state).toBe("pruned");
  });

  it.each(["uncertain", "abandoned", "terminal-no-onward"] as const)("retains a direct %s attempt without a receipt", async disposition => {
    await direct("direct");
    if (disposition === "uncertain") store.turnAttempts.markDeliveryUncertain("direct", "nonce search exceeded 5000 messages");
    if (disposition === "abandoned") store.turnAttempts.abandonDelivery("direct", "automatic recovery refusal");
    // Removing receipt-only proof turns search exhaustion or lifecycle completion into destructive consent.
    expect(pruneDoneArtifact(deps(), "direct").state).toBe("retained");
    expect(store.getDoneArtifactExpirationAuthorization("direct")).toBeNull();
  });

  it("prunes after an actual nonce lookup confirms the bot's receipt, without sending", async () => {
    await direct("nonce");
    const receipt = store.turnAttempts.prepareDelivery("nonce", "synthetic-thread", { kind: "message", text: "private synthetic output" });
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    const fetch = vi.fn(async () => new Collection([["message", { id: "message", author: { id: "seam-bot" }, nonce: receipt.nonce, createdTimestamp: Date.now() }]]));
    Object.assign(adapter, { client: { user: { id: "seam-bot" } }, fetchSendableChannel: async () => ({ messages: { fetch } }) });
    const found = await adapter.findMessageByNonce({ platform: "discord", id: "synthetic-thread" }, receipt.nonce, Date.parse(receipt.startedUtc));
    expect(found.status).toBe("found");
    if (found.status === "found") store.turnAttempts.markDeliveryDone("nonce");
    // Removing the receipt projection keeps confirmed modern output indefinitely; no provider/Discord send is used here.
    expect(pruneDoneArtifact(deps(), "nonce").state).toBe("pruned");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("requires immutable operator authorization to expire unproven legacy output", async () => {
    store.recordDelegation({ id: "legacy", kind: "handoff", status: "abandoned" });
    store.updateDelegationStatus("legacy", "abandoned", { terminalReason: "operator-looking words are not an authorization" });
    await artifact("legacy", { kind: "handoff" });
    // Removing separate authorization makes reason text or automatic abandonment sufficient to erase output.
    expect(pruneDoneArtifact(deps(), "legacy").state).toBe("retained");
    const authorization = store.authorizeDoneArtifactExpiration("legacy", "fixture-operator", "expire this exact disposable artifact");
    expect(store.authorizeDoneArtifactExpiration("legacy", "fixture-operator", authorization.reason)).toEqual(authorization);
    expect(() => store.authorizeDoneArtifactExpiration("legacy", "different-operator", "replace consent")).toThrow(/already authorized/);
    expect(store.getDoneArtifactExpirationAuthorization("legacy")).toEqual(authorization);
    // Removing the authorized-expiration branch prevents the sole explicit unproven-legacy expiration path.
    expect(pruneDoneArtifact(deps(), "legacy").state).toBe("pruned");
  });

  it("bounds bulk authorized expiration without hiding dry-run totals or starving later eligible files", async () => {
    for (const id of ["keep", "a", "b", "c"]) {
      store.recordDelegation({ id, kind: "wake", status: "completed" });
      await artifact(id);
      if (id !== "keep") store.authorizeDoneArtifactExpiration(id, "fixture-operator", "explicit bulk fixture");
    }
    // Removing the unlink budget lets a bulk authorization erase the entire backlog in one pass.
    expect(await pruneDoneArtifacts(deps(), { maxPruned: 2 })).toMatchObject({ pruned: 2, limitReached: true });
    expect(await readdir(path.join(dir, "dispatch/done"))).toHaveLength(2);
    expect(await pruneDoneArtifacts(deps(), { maxPruned: 2, dryRun: true })).toMatchObject({ pruned: 1, retained: 1, limitReached: false });
    expect(await pruneDoneArtifacts(deps(), { maxPruned: 2 })).toMatchObject({ pruned: 1, retained: 1 });
    expect(await readdir(path.join(dir, "dispatch/done"))).toEqual(["keep.json"]);
    // Removing validation silently disables the bound for zero/NaN/oversized values.
    for (const maxPruned of [0, NaN, 1001]) await expect(pruneDoneArtifacts(deps(), { maxPruned })).rejects.toThrow(/maxPruned/);
  });

  it("starts retention only after the shipped watcher releases the recovery admission barrier", async () => {
    await direct("barrier");
    store.turnAttempts.markDeliveryDone("barrier");
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const recovered = vi.fn(() => barrier);
    const watcher = createRuntimeDispatchWatcher({ attempts: store.turnAttempts, dataDir: dir, logger, runtime: {
      dispatchInjectTurn: async () => { throw new Error("no task allowed"); },
      observeRetainedDispatch: async () => {}, recoverInterruptedTurns: recovered,
    } });
    const manager = new DoneRetention(deps());
    const started = watcher.start({ waitForInitialDispatches: false })
      .then(() => watcher.admissionReleased()).then(() => manager.start());
    try {
      await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce());
      // Removing #303's awaited barrier lets retention erase evidence while boot recovery still owns it.
      await expect(access(file("barrier"))).resolves.toBeUndefined();
      release(); await started; await manager.drain();
      await expect(access(file("barrier"))).rejects.toMatchObject({ code: "ENOENT" });
      const index = await readFile(new URL("../packages/core/src/index.ts", import.meta.url), "utf8");
      // Protects actual composition ordering, not merely the isolated watcher's capability.
      expect(index.indexOf("doneRetention.start();")).toBeGreaterThan(index.indexOf("await dispatchWatcher.start({ waitForInitialDispatches: false });"));
      expect(index.indexOf("await dispatchWatcher.admissionReleased();")).toBeGreaterThan(0);
      expect(index.indexOf("doneRetention.start();")).toBeGreaterThan(index.indexOf("await dispatchWatcher.admissionReleased();"));
    } finally { release(); await started; manager.stop(); await manager.drain(); watcher.stop(); await watcher.drain(); }
  });
});
