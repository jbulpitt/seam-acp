export const AGY_UPGRADE_EVIDENCE_VERSION: 1;
export const AGY_UPGRADE_REQUIRED_CAPABILITIES: readonly string[];
export const AGY_UPGRADE_MIN_SAMPLES: number;

export class AgyUpgradeRefusal extends Error {}

export interface AgyUpgradeMetricSummary {
  median: number;
  tail: number;
}

export interface AgyUpgradeSampleSummary {
  count: number;
  taskIds: string[];
  metrics: Record<string, AgyUpgradeMetricSummary>;
}

export interface AgyUpgradeSummary {
  candidate: { version: string; sha256: string };
  capabilities: Record<string, "pass">;
  unknownFieldCount: number;
  performance: {
    baseline: AgyUpgradeSampleSummary;
    candidate: AgyUpgradeSampleSummary;
  };
}

export function readAgyUpgradeEvidence(
  file: string,
  readFileSync?: (file: string, encoding: string) => string | Buffer,
): unknown;

export function countUnknownAgyFields(updates: unknown): number;

export function evaluateAgyUpgradeEvidence(
  raw: unknown,
  expected: { version: string; sha256: string },
): AgyUpgradeSummary;

export function formatAgyUpgradeSummary(summary: AgyUpgradeSummary): string;
