#!/usr/bin/env node
/**
 * Evaluate sanitized, separately approved AGY upgrade-canary evidence (#266).
 *
 * The prompt-free `agy models` check in stage-agy-runtime proves that the
 * candidate can start and enumerate models. It cannot prove the behaviors a
 * real Seam turn consumes. AGY 1.2.2 made that distinction concrete: identity,
 * provenance and version checks all passed while StreamAgentStateUpdates
 * rejected the adapter with `unauthenticated` (#371).
 *
 * This gate therefore refuses only promotion of the candidate artifact. The
 * currently pinned runtime keeps serving. It never disables the adapter or
 * changes host state, and it never launches AGY or a provider request itself.
 */
import fs from "node:fs";
import path from "node:path";

export const AGY_UPGRADE_EVIDENCE_VERSION = 1;
export const AGY_UPGRADE_REQUIRED_CAPABILITIES = Object.freeze([
  "stream-subscription",
  "thinking",
  "mcp",
  "usage",
  "structured-output",
  "session-continuity",
  "cleanup",
]);
export const AGY_UPGRADE_MIN_SAMPLES = 3;

const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const METRICS = Object.freeze([
  "startupToFirstEventMs",
  "firstTextMs",
  "completionToIdleMs",
  "cleanupMs",
  "peakRssBytes",
  "peakChildCount",
]);
const KNOWN_UPDATE_FIELDS = new Set([
  "conversationId", "trajectoryId", "status", "executableStatus",
  "executorLoopStatus", "mainTrajectoryUpdate", "artifactSnapshotsUpdate",
  "executorMetadata", "fullyIdle",
]);
const KNOWN_MAIN_TRAJECTORY_FIELDS = new Set([
  "stepsUpdate", "generatorMetadatasUpdate", "executorMetadatasUpdate",
]);
const KNOWN_STEPS_UPDATE_FIELDS = new Set(["indices", "steps"]);
const KNOWN_STEP_FIELDS = new Set(["type", "status", "plannerResponse", "metadata"]);
const KNOWN_PLANNER_FIELDS = new Set([
  "modifiedResponse", "thinking", "messageId", "thinkingDuration", "stopReason",
]);
const KNOWN_METADATA_FIELDS = new Set([
  "createdAt", "viewableAt", "finishedGeneratingAt", "startedAt", "completedAt",
  "stepGenerationVersion", "source", "generatorModel", "modelUsage",
]);
const KNOWN_MODEL_USAGE_FIELDS = new Set([
  "model", "inputTokens", "outputTokens", "thinkingOutputTokens", "responseOutputTokens",
]);

export class AgyUpgradeRefusal extends Error {
  constructor(message) {
    super(`${message}; candidate not promoted, existing runtime remains pinned`);
    this.name = "AgyUpgradeRefusal";
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgyUpgradeRefusal(`${label} must be an object`);
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgyUpgradeRefusal(`${label} must be a non-empty string`);
  }
  return value;
}

function nonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgyUpgradeRefusal(`${label} must be a finite non-negative number`);
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeSamples(samples, label) {
  if (!Array.isArray(samples) || samples.length < AGY_UPGRADE_MIN_SAMPLES) {
    throw new AgyUpgradeRefusal(
      `${label} needs at least ${AGY_UPGRADE_MIN_SAMPLES} paired observations; one run is not performance evidence`
    );
  }
  const taskIds = [];
  const values = Object.fromEntries(METRICS.map((metric) => [metric, []]));
  for (const [index, raw] of samples.entries()) {
    const sample = object(raw, `${label}[${index}]`);
    taskIds.push(nonEmpty(sample.taskId, `${label}[${index}].taskId`));
    for (const metric of METRICS) {
      values[metric].push(nonNegative(sample[metric], `${label}[${index}].${metric}`));
    }
  }
  return {
    count: samples.length,
    taskIds,
    metrics: Object.fromEntries(METRICS.map((metric) => [metric, {
      median: median(values[metric]),
      tail: Math.max(...values[metric]),
    }])),
  };
}

function countUnknownKeys(value, known) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.keys(value).filter((key) => !known.has(key)).length;
}

/**
 * Count schema drift from sanitized native update shapes without retaining or
 * returning any field value. Provider-specific tool union bodies deliberately
 * count as unknown until the structural snapshot is extended; drift is visible
 * but never a reason to reject an otherwise compatible candidate.
 */
export function countUnknownAgyFields(updates) {
  if (!Array.isArray(updates)) {
    throw new AgyUpgradeRefusal("schemaDrift.updates must be an array of sanitized update shapes");
  }
  let count = 0;
  for (const rawUpdate of updates) {
    const update = object(rawUpdate, "schemaDrift update");
    count += countUnknownKeys(update, KNOWN_UPDATE_FIELDS);
    const main = update.mainTrajectoryUpdate;
    if (!main || typeof main !== "object" || Array.isArray(main)) continue;
    count += countUnknownKeys(main, KNOWN_MAIN_TRAJECTORY_FIELDS);
    const stepsUpdate = main.stepsUpdate;
    if (!stepsUpdate || typeof stepsUpdate !== "object" || Array.isArray(stepsUpdate)) continue;
    count += countUnknownKeys(stepsUpdate, KNOWN_STEPS_UPDATE_FIELDS);
    if (!Array.isArray(stepsUpdate.steps)) continue;
    for (const rawStep of stepsUpdate.steps) {
      if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) continue;
      count += countUnknownKeys(rawStep, KNOWN_STEP_FIELDS);
      const planner = rawStep.plannerResponse;
      count += countUnknownKeys(planner, KNOWN_PLANNER_FIELDS);
      const metadata = rawStep.metadata;
      count += countUnknownKeys(metadata, KNOWN_METADATA_FIELDS);
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        count += countUnknownKeys(metadata.modelUsage, KNOWN_MODEL_USAGE_FIELDS);
      }
    }
  }
  return count;
}

/** Parse without ever echoing report contents; canary traces may be private. */
export function readAgyUpgradeEvidence(file, readFileSync = fs.readFileSync) {
  try {
    return JSON.parse(String(readFileSync(path.resolve(file), "utf8")));
  } catch {
    throw new AgyUpgradeRefusal("upgrade evidence is unreadable or invalid JSON");
  }
}

/**
 * Validate candidate-specific evidence and return only aggregate, safe output.
 * Unknown native fields are observed as a count, never printed or treated as
 * capability loss. This avoids both silent schema drift and private-data logs.
 */
export function evaluateAgyUpgradeEvidence(raw, expected) {
  const report = object(raw, "upgrade evidence");
  if (report.schemaVersion !== AGY_UPGRADE_EVIDENCE_VERSION || report.kind !== "agy-upgrade-evidence") {
    throw new AgyUpgradeRefusal("unsupported upgrade evidence schema");
  }
  if (report.sanitized !== true || report.evidenceLevel !== "live-verified") {
    throw new AgyUpgradeRefusal("upgrade evidence must be sanitized and live-verified by a separately approved canary");
  }
  if (!ISO_DATE.test(nonEmpty(report.capturedAt, "capturedAt"))) {
    throw new AgyUpgradeRefusal("capturedAt must be an ISO-8601 UTC timestamp");
  }

  const candidate = object(report.candidate, "candidate");
  const version = nonEmpty(candidate.version, "candidate.version");
  const sha256 = nonEmpty(candidate.sha256, "candidate.sha256");
  if (!SHA256.test(sha256)) throw new AgyUpgradeRefusal("candidate.sha256 must be 64 lowercase hex characters");
  if (version !== expected.version) {
    throw new AgyUpgradeRefusal(`candidate.version does not match staged version (${version} != ${expected.version})`);
  }
  if (sha256 !== expected.sha256) {
    throw new AgyUpgradeRefusal("candidate.sha256 does not match the staged artifact");
  }

  const baselineIdentity = object(report.baseline, "baseline");
  nonEmpty(baselineIdentity.version, "baseline.version");
  const baselineSha256 = nonEmpty(baselineIdentity.sha256, "baseline.sha256");
  if (!SHA256.test(baselineSha256)) {
    throw new AgyUpgradeRefusal("baseline.sha256 must be 64 lowercase hex characters");
  }

  const comparison = object(report.comparison, "comparison");
  if (!/^[a-f0-9]{7,64}$/.test(nonEmpty(comparison.adapterCommit, "comparison.adapterCommit"))) {
    throw new AgyUpgradeRefusal("comparison.adapterCommit must be an exact Git commit id");
  }
  nonEmpty(comparison.scenarioVersion, "comparison.scenarioVersion");
  nonEmpty(comparison.hostClass, "comparison.hostClass");
  nonEmpty(comparison.declaredHostLoad, "comparison.declaredHostLoad");
  nonEmpty(comparison.modelId, "comparison.modelId");

  if (!Array.isArray(report.capabilities)) {
    throw new AgyUpgradeRefusal("capabilities must be an array");
  }
  const byId = new Map();
  for (const [index, rawCapability] of report.capabilities.entries()) {
    const capability = object(rawCapability, `capabilities[${index}]`);
    const id = nonEmpty(capability.id, `capabilities[${index}].id`);
    if (byId.has(id)) throw new AgyUpgradeRefusal(`capability ${id} is duplicated`);
    byId.set(id, capability);
  }
  for (const id of AGY_UPGRADE_REQUIRED_CAPABILITIES) {
    const capability = byId.get(id);
    if (!capability) throw new AgyUpgradeRefusal(`required capability ${id} was not observed`);
    const observations = nonNegative(capability.observations, `capability ${id} observations`);
    if (!Number.isSafeInteger(observations) || observations < 1) {
      throw new AgyUpgradeRefusal(`required capability ${id} has no observation`);
    }
    if (capability.verdict !== "pass") {
      if (capability.verdict !== "fail") {
        throw new AgyUpgradeRefusal(`required capability ${id} has an invalid verdict`);
      }
      const code = typeof capability.reasonCode === "string" &&
        /^[a-z0-9_-]{1,100}$/.test(capability.reasonCode)
        ? ` (${capability.reasonCode})`
        : "";
      throw new AgyUpgradeRefusal(`required capability ${id} failed${code}`);
    }
  }

  const drift = object(report.schemaDrift, "schemaDrift");
  const unknownFieldCount = countUnknownAgyFields(drift.updates);

  const performance = object(report.performance, "performance");
  const baseline = summarizeSamples(performance.baseline, "performance.baseline");
  const candidateSummary = summarizeSamples(performance.candidate, "performance.candidate");
  if (baseline.count !== candidateSummary.count ||
      baseline.taskIds.some((taskId, index) => taskId !== candidateSummary.taskIds[index])) {
    throw new AgyUpgradeRefusal("baseline and candidate performance observations must use identical ordered tasks");
  }

  return {
    candidate: { version, sha256 },
    capabilities: Object.fromEntries(AGY_UPGRADE_REQUIRED_CAPABILITIES.map((id) => [id, "pass"])),
    unknownFieldCount,
    performance: { baseline, candidate: candidateSummary },
  };
}

export function formatAgyUpgradeSummary(summary) {
  const lines = [
    `candidate version=${summary.candidate.version} sha256=${summary.candidate.sha256}`,
    `capabilities=${AGY_UPGRADE_REQUIRED_CAPABILITIES.map((id) => `${id}:pass`).join(",")}`,
    `unknown_native_fields=${summary.unknownFieldCount}`,
  ];
  for (const side of ["baseline", "candidate"]) {
    const result = summary.performance[side];
    lines.push(`${side}_samples=${result.count}`);
    for (const metric of METRICS) {
      lines.push(`${side}_${metric}=median:${result.metrics[metric].median},tail:${result.metrics[metric].tail}`);
    }
  }
  lines.push("performance_verdict=observed-only (no synthetic promotion threshold)");
  return lines.join("\n");
}

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
  const evidence = args.get("--evidence");
  const version = args.get("--version");
  const sha256 = args.get("--sha256");
  if (!evidence || !version || !sha256 || argv.length !== 6) {
    console.error("usage: node scripts/agy-upgrade-gate.mjs --evidence <json> --version <version> --sha256 <64-hex>");
    return 2;
  }
  try {
    console.log(formatAgyUpgradeSummary(evaluateAgyUpgradeEvidence(
      readAgyUpgradeEvidence(evidence), { version, sha256 }
    )));
    return 0;
  } catch (error) {
    console.error(`REFUSED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
