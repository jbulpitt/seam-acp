import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  AGY_UPGRADE_REQUIRED_CAPABILITIES,
  evaluateAgyUpgradeEvidence,
  formatAgyUpgradeSummary,
} from "../scripts/agy-upgrade-gate.mjs";

type Report = Record<string, any>;

const fixture = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, "fixtures", "agy-upgrade-gate", "reports.json"),
  "utf8",
)) as { reports: Report[] };

function expandedReports(): Report[] {
  const base = structuredClone(fixture.reports[0]!);
  return fixture.reports.map((raw) => {
    if (!raw.$copy) return structuredClone(raw);
    const report = structuredClone(base);
    report.candidate = structuredClone(raw.candidate);
    if (raw.schemaDrift) report.schemaDrift = structuredClone(raw.schemaDrift);
    if (raw.capabilityOverride) {
      report.capabilities = report.capabilities.map((entry: Report) =>
        entry.id === raw.capabilityOverride.id
          ? structuredClone(raw.capabilityOverride)
          : entry);
    }
    return report as Report;
  }).map((report) => {
    // The immutable files truthfully say synthetic-fixture. Unit tests promote
    // only their in-memory copies to exercise the production live-evidence leg.
    report.evidenceLevel = "live-verified";
    return report;
  });
}

const reports = expandedReports();

describe("AGY R10 upgrade compatibility gate", () => {
  it("does not promote the repository's offline fixture into live evidence", () => {
    const offline = structuredClone(fixture.reports[0]!);
    expect(offline.evidenceLevel).toBe("synthetic-fixture");
    expect(() => evaluateAgyUpgradeEvidence(offline, offline.candidate)).toThrow(
      /must be sanitized and live-verified.*existing runtime remains pinned/,
    );
  });

  it("refuses the observed 1.2.2 stream-subscription regression even though catalog identity passed", () => {
    const report = reports.find((entry) => entry.candidate.version === "1.2.2")!;
    expect(() => evaluateAgyUpgradeEvidence(report, report.candidate)).toThrow(
      /required capability stream-subscription failed \(unauthenticated\).*existing runtime remains pinned/,
    );
  });

  it.each(["1.1.27", "1.1.28", "1.2.0"])(
    "accepts complete known-good-shaped %s evidence",
    (version) => {
      const report = reports.find((entry) => entry.candidate.version === version)!;
      const result = evaluateAgyUpgradeEvidence(report, report.candidate);
      expect(result.capabilities).toEqual(Object.fromEntries(
        AGY_UPGRADE_REQUIRED_CAPABILITIES.map((id: string) => [id, "pass"]),
      ));
    },
  );

  it("reports unknown schema fields and paired median/tail samples without inventing a speed verdict", () => {
    const report = reports.find((entry) => entry.candidate.version === "1.2.0")!;
    const result = evaluateAgyUpgradeEvidence(report, report.candidate);
    const summary = formatAgyUpgradeSummary(result);
    expect(result.unknownFieldCount).toBe(2);
    expect(result.performance.baseline).toMatchObject({
      count: 3,
      metrics: { startupToFirstEventMs: { median: 12, tail: 14 } },
    });
    expect(result.performance.candidate).toMatchObject({
      count: 3,
      metrics: { startupToFirstEventMs: { median: 13, tail: 15 } },
    });
    expect(summary).toContain("unknown_native_fields=2");
    expect(summary).toContain("performance_verdict=observed-only (no synthetic promotion threshold)");
    expect(summary).not.toMatch(/faster|slower|regression/i);
  });

  it("does not mistake the prompt-free catalog check for full promotion evidence", () => {
    const report = structuredClone(reports[0]!);
    report.capabilities = report.capabilities.filter((entry: Report) =>
      entry.id === "stream-subscription");
    expect(() => evaluateAgyUpgradeEvidence(report, report.candidate)).toThrow(
      /required capability thinking was not observed.*existing runtime remains pinned/,
    );
  });

  it("refuses one-run and mismatched-task performance claims", () => {
    const oneRun = structuredClone(reports[0]!);
    oneRun.performance.baseline = oneRun.performance.baseline.slice(0, 1);
    oneRun.performance.candidate = oneRun.performance.candidate.slice(0, 1);
    expect(() => evaluateAgyUpgradeEvidence(oneRun, oneRun.candidate)).toThrow(
      /at least 3 paired observations; one run is not performance evidence/,
    );

    const mismatch = structuredClone(reports[0]!);
    mismatch.performance.candidate[1].taskId = "different-task";
    expect(() => evaluateAgyUpgradeEvidence(mismatch, mismatch.candidate)).toThrow(
      /must use identical ordered tasks/,
    );
  });

  it("binds canary evidence to the exact staged version and bytes", () => {
    const report = reports[0]!;
    expect(() => evaluateAgyUpgradeEvidence(report, {
      version: report.candidate.version,
      sha256: "f".repeat(64),
    })).toThrow(/candidate\.sha256 does not match the staged artifact/);
  });

  it("never echoes an unsafe capability reason from canary evidence", () => {
    const report = structuredClone(reports[0]!);
    const stream = report.capabilities.find((entry: Report) =>
      entry.id === "stream-subscription");
    stream.verdict = "fail";
    stream.reasonCode = "Authorization: Bearer synthetic-private-value";
    let message = "";
    try {
      evaluateAgyUpgradeEvidence(report, report.candidate);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("required capability stream-subscription failed");
    expect(message).not.toContain("synthetic-private-value");
    expect(message).toContain("existing runtime remains pinned");
  });
});
