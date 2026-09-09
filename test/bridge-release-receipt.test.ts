import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReleaseReceiptWriter } from "../packages/bridge/src/release-receipt.js";

describe("bridge release ready receipt (#241)", () => {
  it("records accepted hello and only successful catalog RPC completion", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-receipt-test-"));
    const state = path.join(dir, "bridge-release-state.json");
    const receipt = path.join(dir, "ready", "media-server.json");
    await fs.writeFile(state, JSON.stringify({ sourceSha: "a".repeat(40), artifactChecksum: "b".repeat(64), verificationAgent: "grok" }));
    const writer = await createReleaseReceiptWriter({
      bridgeId: "media-server",
      instanceId: "new-instance",
      protocolVersion: 1,
      releaseStatePath: state,
      receiptPath: receipt,
    });
    expect(writer).not.toBeNull();
    await writer!.recordHelloAccepted();
    await writer!.recordCatalogRpc("describeModelCatalog", "grok");
    await writer!.recordCatalogRpc("unknown", "grok");
    await writer!.recordCatalogRpc("fetchModelCatalog", "grok");
    await writer!.recordControllerVerification({ sourceSha: "a".repeat(40), artifactChecksum: "b".repeat(64), verificationAgent: "grok" });
    const saved = JSON.parse(await fs.readFile(receipt, "utf8"));
    expect(saved).toMatchObject({
      sourceSha: "a".repeat(40),
      artifactChecksum: "b".repeat(64),
      pid: process.pid,
      instanceId: "new-instance",
      protocolVersion: 1,
    });
    expect(saved.helloAcceptedAt).toBeTruthy();
    expect(saved.controllerVerifiedAt).toBeTruthy();
    expect(saved.catalogRpcs.grok.describeModelCatalogAt).toBeTruthy();
    expect(saved.catalogRpcs.grok.fetchModelCatalogAt).toBeTruthy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("stays disabled for legacy/unverified artifacts", async () => {
    expect(await createReleaseReceiptWriter({
      bridgeId: "media-server",
      instanceId: "legacy",
      protocolVersion: 1,
      releaseStatePath: "/definitely/missing/release-state.json",
    })).toBeNull();
  });
});
