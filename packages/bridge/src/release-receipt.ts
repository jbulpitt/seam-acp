import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

interface ReleaseIdentity {
  sourceSha: string;
  artifactChecksum: string;
  verificationAgent: string;
}

interface ReadyReceipt extends ReleaseIdentity {
  pid: number;
  instanceId: string;
  protocolVersion: number;
  helloAcceptedAt?: string;
  controllerVerifiedAt?: string;
  catalogRpcs: Record<string, {
    describeModelCatalogAt?: string;
    fetchModelCatalogAt?: string;
  }>;
}

const SHA = /^[0-9a-f]{40}$/;
const CHECKSUM = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class ReleaseReceiptWriter {
  private receipt: ReadyReceipt;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    identity: ReleaseIdentity,
    instance: { bridgeId: string; instanceId: string; protocolVersion: number },
    private readonly receiptPath: string,
  ) {
    this.receipt = {
      ...identity,
      pid: process.pid,
      instanceId: instance.instanceId,
      protocolVersion: instance.protocolVersion,
      catalogRpcs: {},
    };
  }

  recordHelloAccepted(): Promise<void> {
    this.receipt.helloAcceptedAt = new Date().toISOString();
    return this.write();
  }

  helloMetadata(): ReleaseIdentity {
    return {
      sourceSha: this.receipt.sourceSha,
      artifactChecksum: this.receipt.artifactChecksum,
      verificationAgent: this.receipt.verificationAgent,
    };
  }

  recordCatalogRpc(method: string, agentId: string | undefined): Promise<void> {
    if (!agentId || !SAFE_NAME.test(agentId)) return Promise.resolve();
    if (method !== "describeModelCatalog" && method !== "fetchModelCatalog") return Promise.resolve();
    const calls = this.receipt.catalogRpcs[agentId] ?? {};
    if (method === "describeModelCatalog") calls.describeModelCatalogAt = new Date().toISOString();
    else calls.fetchModelCatalogAt = new Date().toISOString();
    this.receipt.catalogRpcs[agentId] = calls;
    return this.write();
  }

  recordControllerVerification(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") return Promise.resolve();
    const value = payload as Partial<ReleaseIdentity>;
    if (
      value.sourceSha !== this.receipt.sourceSha ||
      value.artifactChecksum !== this.receipt.artifactChecksum ||
      value.verificationAgent !== this.receipt.verificationAgent
    ) return Promise.resolve();
    this.receipt.controllerVerifiedAt = new Date().toISOString();
    return this.write();
  }

  private write(): Promise<void> {
    const snapshot = JSON.stringify(this.receipt) + "\n";
    this.pending = this.pending.then(async () => {
      await fs.mkdir(path.dirname(this.receiptPath), { recursive: true });
      const temporary = `${this.receiptPath}.next-${process.pid}`;
      await fs.writeFile(temporary, snapshot, { mode: 0o600 });
      await fs.rename(temporary, this.receiptPath);
    });
    return this.pending;
  }
}

export async function createReleaseReceiptWriter(options: {
  bridgeId: string;
  instanceId: string;
  protocolVersion: number;
  releaseStatePath?: string;
  receiptPath?: string;
}): Promise<ReleaseReceiptWriter | null> {
  if (!SAFE_NAME.test(options.bridgeId)) return null;
  const releaseStatePath = options.releaseStatePath ?? fileURLToPath(new URL("../../../bridge-release-state.json", import.meta.url));
  let identity: ReleaseIdentity;
  try {
    identity = JSON.parse(await fs.readFile(releaseStatePath, "utf8")) as ReleaseIdentity;
  } catch {
    return null;
  }
  if (!SHA.test(identity.sourceSha) || !CHECKSUM.test(identity.artifactChecksum) || !SAFE_NAME.test(identity.verificationAgent)) return null;
  const receiptPath = options.receiptPath ?? path.join(homedir(), ".seam", "bridge-rollouts", "ready", `${options.bridgeId}.json`);
  return new ReleaseReceiptWriter(identity, options, receiptPath);
}
