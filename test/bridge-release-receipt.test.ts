import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { releaseShaFromHello } from "../packages/core/src/core/bridge-hub.js";
import { createReleaseReceiptWriter, readRunningReleaseSha } from "../packages/bridge/src/release-receipt.js";

const H = (value: string) => value.repeat(64);

describe("bridge activation receipt (#241)", () => {
  it("binds stage, activation, process, instance, controller ack and both RPCs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-receipt-test-"));
    const receipt = path.join(dir, "release-receipt.json"); const activation = path.join(dir, "activation-envelope.json");
    const stage = { formatVersion: 2, bridgeId: "media-server", sourceSha: "a".repeat(40), artifactChecksum: H("b"), verificationAgent: "grok", stageId: H("c"), treeDigest: H("d"), stagedAt: new Date().toISOString() };
    const envelope = { formatVersion: 2, activationId: H("e"), bridgeId: "media-server", sourceSha: stage.sourceSha, artifactChecksum: stage.artifactChecksum, verificationAgent: "grok", stageId: stage.stageId, oldPid: 41, startedAt: new Date(Date.now() - 1_000).toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString() };
    await fs.writeFile(receipt, JSON.stringify(stage)); await fs.writeFile(activation, JSON.stringify(envelope));
    const adapterRefusals = [{ agentId: "agy", code: "configuration_incomplete" as const, missing: ["AGY_SHA256"] }];
    const writer = await createReleaseReceiptWriter({ bridgeId: "media-server", instanceId: "new-instance", protocolVersion: 1, adapterRefusals, activationEnvelopePath: activation, receiptPath: receipt });
    expect(writer?.helloMetadata()).toMatchObject({ activationId: envelope.activationId, bridgeId: "media-server", oldPid: 41, pid: process.pid });
    await writer!.recordHelloAccepted(); await writer!.recordCatalogRpc("describeModelCatalog", "grok"); await writer!.recordCatalogRpc("fetchModelCatalog", "grok");
    await writer!.recordControllerVerification({ activationId: envelope.activationId, bridgeId: "media-server", instanceId: "wrong", pid: process.pid, sourceSha: stage.sourceSha, artifactChecksum: stage.artifactChecksum });
    expect(JSON.parse(await fs.readFile(receipt, "utf8")).completedAt).toBeUndefined();
    await writer!.recordControllerVerification({ activationId: envelope.activationId, bridgeId: "media-server", instanceId: "new-instance", pid: process.pid, sourceSha: "f".repeat(40), artifactChecksum: stage.artifactChecksum });
    expect(JSON.parse(await fs.readFile(receipt, "utf8")).completedAt).toBeUndefined();
    await writer!.recordControllerVerification({ activationId: envelope.activationId, bridgeId: "media-server", instanceId: "new-instance", pid: process.pid, sourceSha: stage.sourceSha, artifactChecksum: stage.artifactChecksum });
    const saved = JSON.parse(await fs.readFile(receipt, "utf8"));
    expect(saved).toMatchObject({ ...stage, ...envelope, pid: process.pid, instanceId: "new-instance", protocolVersion: 1, adapterRefusals, controllerAck: { activationId: envelope.activationId, bridgeId: "media-server", instanceId: "new-instance", pid: process.pid, sourceSha: stage.sourceSha, artifactChecksum: stage.artifactChecksum } });
    expect(saved.catalogRpcs.grok.describeModelCatalogAt).toBeTruthy(); expect(saved.catalogRpcs.grok.fetchModelCatalogAt).toBeTruthy(); expect(saved.completedAt).toBeTruthy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses stale, mismatched, or legacy state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-receipt-refuse-")); const receipt = path.join(dir,"release-receipt.json"); const activation = path.join(dir,"activation-envelope.json");
    await fs.writeFile(receipt, JSON.stringify({ formatVersion: 2, bridgeId: "media-server", sourceSha: "a".repeat(40), artifactChecksum: H("b"), verificationAgent: "grok", stageId: H("c"), treeDigest: H("d"), stagedAt: new Date().toISOString() }));
    await fs.writeFile(activation, JSON.stringify({ formatVersion: 2, activationId: H("e"), bridgeId: "other", sourceSha: "a".repeat(40), artifactChecksum: H("b"), verificationAgent: "grok", stageId: H("c"), oldPid: 41, startedAt: new Date(Date.now()-10_000).toISOString(), deadlineAt: new Date(Date.now()-1_000).toISOString() }));
    expect(await createReleaseReceiptWriter({ bridgeId: "media-server", instanceId: "x", protocolVersion: 1, adapterRefusals: [], activationEnvelopePath: activation, receiptPath: receipt })).toBeNull();
    // The activation window closed. The stage receipt is still the release
    // this directory is. Identification does not require the envelope.
    expect(await readRunningReleaseSha(receipt)).toBe("a".repeat(40));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("omits a sha when the receipt is missing or not a stage receipt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-receipt-none-"));
    expect(await readRunningReleaseSha(path.join(dir, "release-receipt.json"))).toBeNull();
    await fs.writeFile(path.join(dir, "release-receipt.json"), JSON.stringify({ sourceSha: "a".repeat(40) }));
    expect(await readRunningReleaseSha(path.join(dir, "release-receipt.json"))).toBeNull();
    await fs.writeFile(path.join(dir, "release-receipt.json"), JSON.stringify({
      formatVersion: 2, bridgeId: "media-server", sourceSha: "A".repeat(40),
      artifactChecksum: H("b"), verificationAgent: "grok", stageId: H("c"),
      treeDigest: H("d"), stagedAt: new Date().toISOString(),
    }));
    expect(await readRunningReleaseSha(path.join(dir, "release-receipt.json"))).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("hello release sha (#557)", () => {
  const sha = "a".repeat(40);

  it("accepts a 40-hex sha and nothing else", () => {
    expect(releaseShaFromHello(sha)).toBe(sha);
    expect(releaseShaFromHello(undefined)).toBeNull();
    expect(releaseShaFromHello("")).toBeNull();
    expect(releaseShaFromHello("A".repeat(40))).toBeNull();
    expect(releaseShaFromHello(`${sha}0`)).toBeNull();
    expect(releaseShaFromHello(sha.slice(0, 12))).toBeNull();
  });
});
