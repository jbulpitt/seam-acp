import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReleaseReceiptWriter } from "../packages/bridge/src/release-receipt.js";

const H = (value: string) => value.repeat(64);

describe("bridge activation receipt (#241)", () => {
  it("binds stage, activation, process, instance, controller ack and both RPCs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-receipt-test-"));
    const receipt = path.join(dir, "release-receipt.json"); const activation = path.join(dir, "activation-envelope.json");
    const stage = { formatVersion: 2, bridgeId: "media-server", sourceSha: "a".repeat(40), artifactChecksum: H("b"), verificationAgent: "grok", stageId: H("c"), treeDigest: H("d"), stagedAt: new Date().toISOString() };
    const envelope = { formatVersion: 2, activationId: H("e"), bridgeId: "media-server", sourceSha: stage.sourceSha, artifactChecksum: stage.artifactChecksum, verificationAgent: "grok", stageId: stage.stageId, oldPid: 41, startedAt: new Date(Date.now() - 1_000).toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString() };
    await fs.writeFile(receipt, JSON.stringify(stage)); await fs.writeFile(activation, JSON.stringify(envelope));
    const writer = await createReleaseReceiptWriter({ bridgeId: "media-server", instanceId: "new-instance", protocolVersion: 1, activationEnvelopePath: activation, receiptPath: receipt });
    expect(writer?.helloMetadata()).toMatchObject({ activationId: envelope.activationId, bridgeId: "media-server", oldPid: 41, pid: process.pid });
    await writer!.recordHelloAccepted(); await writer!.recordCatalogRpc("describeModelCatalog", "grok"); await writer!.recordCatalogRpc("fetchModelCatalog", "grok");
    await writer!.recordControllerVerification({ activationId: envelope.activationId, bridgeId: "media-server", instanceId: "wrong", pid: process.pid });
    expect(JSON.parse(await fs.readFile(receipt, "utf8")).completedAt).toBeUndefined();
    await writer!.recordControllerVerification({ activationId: envelope.activationId, bridgeId: "media-server", instanceId: "new-instance", pid: process.pid });
    const saved = JSON.parse(await fs.readFile(receipt, "utf8"));
    expect(saved).toMatchObject({ ...stage, ...envelope, pid: process.pid, instanceId: "new-instance", protocolVersion: 1, controllerAck: { activationId: envelope.activationId, bridgeId: "media-server", instanceId: "new-instance", pid: process.pid } });
    expect(saved.catalogRpcs.grok.describeModelCatalogAt).toBeTruthy(); expect(saved.catalogRpcs.grok.fetchModelCatalogAt).toBeTruthy(); expect(saved.completedAt).toBeTruthy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses stale, mismatched, or legacy state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-receipt-refuse-")); const receipt = path.join(dir,"release-receipt.json"); const activation = path.join(dir,"activation-envelope.json");
    await fs.writeFile(receipt, JSON.stringify({ formatVersion: 2, bridgeId: "media-server", sourceSha: "a".repeat(40), artifactChecksum: H("b"), verificationAgent: "grok", stageId: H("c"), treeDigest: H("d"), stagedAt: new Date().toISOString() }));
    await fs.writeFile(activation, JSON.stringify({ formatVersion: 2, activationId: H("e"), bridgeId: "other", sourceSha: "a".repeat(40), artifactChecksum: H("b"), verificationAgent: "grok", stageId: H("c"), oldPid: 41, startedAt: new Date(Date.now()-10_000).toISOString(), deadlineAt: new Date(Date.now()-1_000).toISOString() }));
    expect(await createReleaseReceiptWriter({ bridgeId: "media-server", instanceId: "x", protocolVersion: 1, activationEnvelopePath: activation, receiptPath: receipt })).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
