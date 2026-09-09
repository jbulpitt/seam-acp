import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface StageReceipt {
  formatVersion: 2;
  bridgeId: string;
  sourceSha: string;
  artifactChecksum: string;
  verificationAgent: string;
  stageId: string;
  treeDigest: string;
  stagedAt: string;
}

interface ActivationEnvelope {
  formatVersion: 2;
  activationId: string;
  bridgeId: string;
  sourceSha: string;
  artifactChecksum: string;
  verificationAgent: string;
  stageId: string;
  oldPid: number;
  startedAt: string;
  deadlineAt: string;
}

interface ReadyReceipt extends StageReceipt, ActivationEnvelope {
  pid: number;
  instanceId: string;
  protocolVersion: number;
  helloAcceptedAt?: string;
  controllerVerifiedAt?: string;
  completedAt?: string;
  controllerAck?: { activationId: string; bridgeId: string; instanceId: string; pid: number };
  catalogRpcs: Record<string, { describeModelCatalogAt?: string; fetchModelCatalogAt?: string }>;
}

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const INSTANCE = /^[A-Za-z0-9._-]{8,128}$/;

function isStageReceipt(value: unknown): value is StageReceipt {
  const item = value as Partial<StageReceipt> | null;
  return item?.formatVersion === 2 && SAFE_NAME.test(item.bridgeId ?? "") && SHA.test(item.sourceSha ?? "") && HASH.test(item.artifactChecksum ?? "") && SAFE_NAME.test(item.verificationAgent ?? "") && HASH.test(item.stageId ?? "") && HASH.test(item.treeDigest ?? "") && Number.isFinite(Date.parse(item.stagedAt ?? ""));
}

function isActivationEnvelope(value: unknown): value is ActivationEnvelope {
  const item = value as Partial<ActivationEnvelope> | null;
  const started = Date.parse(item?.startedAt ?? ""); const deadline = Date.parse(item?.deadlineAt ?? "");
  return item?.formatVersion === 2 && HASH.test(item.activationId ?? "") && SAFE_NAME.test(item.bridgeId ?? "") && SHA.test(item.sourceSha ?? "") && HASH.test(item.artifactChecksum ?? "") && SAFE_NAME.test(item.verificationAgent ?? "") && HASH.test(item.stageId ?? "") && Number.isSafeInteger(item.oldPid) && (item.oldPid ?? 0) > 1 && item.oldPid !== process.pid && Number.isFinite(started) && Number.isFinite(deadline) && started <= Date.now() && Date.now() <= deadline && deadline - started <= 900_000;
}

export class ReleaseReceiptWriter {
  private receipt: ReadyReceipt;
  private pending: Promise<void> = Promise.resolve();

  constructor(stage: StageReceipt, activation: ActivationEnvelope, instance: { instanceId: string; protocolVersion: number }, private readonly receiptPath: string) {
    this.receipt = { ...stage, ...activation, pid: process.pid, instanceId: instance.instanceId, protocolVersion: instance.protocolVersion, catalogRpcs: {} };
  }

  recordHelloAccepted(): Promise<void> {
    this.receipt.helloAcceptedAt = new Date().toISOString();
    return this.write();
  }

  helloMetadata() {
    const { formatVersion, activationId, stageId, bridgeId, sourceSha, artifactChecksum, verificationAgent, oldPid, startedAt, deadlineAt, pid } = this.receipt;
    return { formatVersion, activationId, stageId, bridgeId, sourceSha, artifactChecksum, verificationAgent, oldPid, startedAt, deadlineAt, pid };
  }

  recordCatalogRpc(method: string, agentId: string | undefined): Promise<void> {
    if (!agentId || !SAFE_NAME.test(agentId) || (method !== "describeModelCatalog" && method !== "fetchModelCatalog")) return Promise.resolve();
    const calls = this.receipt.catalogRpcs[agentId] ?? {};
    if (method === "describeModelCatalog") calls.describeModelCatalogAt = new Date().toISOString();
    else calls.fetchModelCatalogAt = new Date().toISOString();
    this.receipt.catalogRpcs[agentId] = calls;
    return this.write();
  }

  recordControllerVerification(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") return Promise.resolve();
    const value = payload as { activationId?: string; bridgeId?: string; instanceId?: string; pid?: number };
    if (value.activationId !== this.receipt.activationId || value.bridgeId !== this.receipt.bridgeId || value.instanceId !== this.receipt.instanceId || value.pid !== this.receipt.pid) return Promise.resolve();
    this.receipt.controllerAck = { activationId: value.activationId, bridgeId: value.bridgeId, instanceId: value.instanceId, pid: value.pid };
    this.receipt.controllerVerifiedAt = new Date().toISOString();
    this.receipt.completedAt = this.receipt.controllerVerifiedAt;
    return this.write();
  }

  private write(): Promise<void> {
    const snapshot = `${JSON.stringify(this.receipt)}\n`;
    this.pending = this.pending.then(async () => {
      const temporary = `${this.receiptPath}.next-${process.pid}`;
      await fs.writeFile(temporary, snapshot, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, this.receiptPath);
    });
    return this.pending;
  }
}

export async function createReleaseReceiptWriter(options: { bridgeId: string; instanceId: string; protocolVersion: number; releaseStatePath?: string; activationEnvelopePath?: string; receiptPath?: string }): Promise<ReleaseReceiptWriter | null> {
  if (!SAFE_NAME.test(options.bridgeId) || !INSTANCE.test(options.instanceId) || options.protocolVersion !== 1) return null;
  const receiptPath = options.receiptPath ?? fileURLToPath(new URL("../../../release-receipt.json", import.meta.url));
  const activationPath = options.activationEnvelopePath ?? options.releaseStatePath ?? fileURLToPath(new URL("../../../activation-envelope.json", import.meta.url));
  let stage: unknown; let activation: unknown;
  try { stage = JSON.parse(await fs.readFile(receiptPath, "utf8")); activation = JSON.parse(await fs.readFile(activationPath, "utf8")); } catch { return null; }
  if (!isStageReceipt(stage) || !isActivationEnvelope(activation)) return null;
  if (stage.bridgeId !== options.bridgeId || activation.bridgeId !== options.bridgeId || stage.sourceSha !== activation.sourceSha || stage.artifactChecksum !== activation.artifactChecksum || stage.verificationAgent !== activation.verificationAgent || stage.stageId !== activation.stageId) return null;
  return new ReleaseReceiptWriter(stage, activation, { instanceId: options.instanceId, protocolVersion: options.protocolVersion }, receiptPath);
}
