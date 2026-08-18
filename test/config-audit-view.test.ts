import { describe, it, expect } from "vitest";
import type { ConfigAuditEntry } from "../src/core/types.js";
import {
  formatConfigAuditView,
  formatConfigAuditDetail,
  findAuditEntry,
  truncatePayload,
  auditLine,
  AUDIT_PAYLOAD_MAX,
} from "../src/platforms/discord/config-audit-view.js";

const NOW = new Date("2026-08-17T12:00:00.000Z");

const entry = (over: Partial<ConfigAuditEntry> = {}): ConfigAuditEntry => ({
  id: "cfg-abc12345def",
  tier: "session",
  actorId: "9001",
  actorName: "jesse",
  scope: "discord:thread-a",
  summary: "model → claude-opus-4-8",
  beforeJson: '{"model":"claude-sonnet-5"}',
  afterJson: '{"model":"claude-opus-4-8"}',
  correlationId: "corr-1",
  appliedUtc: "2026-08-17T11:58:00.000Z",
  ...over,
});

describe("auditLine", () => {
  it("renders when/actor/tier/scope/summary on one line with a short id", () => {
    const line = auditLine(entry(), NOW);
    expect(line).toContain("`abc12345`"); // short id, not the full one
    expect(line).toContain("2m"); // coarse age
    expect(line).toContain("jesse");
    expect(line).toContain("session");
    expect(line).toContain("thread-a");
    expect(line).toContain("model → claude-opus-4-8");
  });

  it("falls back to actor id, then 'unknown', when the name is absent", () => {
    expect(auditLine(entry({ actorName: null }), NOW)).toContain("9001");
    expect(
      auditLine(entry({ actorName: null, actorId: null }), NOW)
    ).toContain("unknown");
  });

  it("clamps a very long summary so it stays on its row", () => {
    const line = auditLine(entry({ summary: "x".repeat(500) }), NOW);
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(300);
  });
});

describe("formatConfigAuditView", () => {
  it("marks an empty trail", () => {
    const view = formatConfigAuditView([], NOW);
    expect(view.empty).toBe(true);
    expect(view.lines).toEqual([]);
  });

  it("preserves the caller's newest-first ordering, one line per row", () => {
    const rows = [
      entry({ id: "cfg-newest", summary: "newest" }),
      entry({ id: "cfg-older", summary: "older" }),
    ];
    const view = formatConfigAuditView(rows, NOW);
    expect(view.empty).toBe(false);
    expect(view.lines).toHaveLength(2);
    expect(view.lines[0]).toContain("newest");
    expect(view.lines[1]).toContain("older");
  });
});

describe("findAuditEntry", () => {
  const rows = [entry({ id: "cfg-abc12345def" }), entry({ id: "cfg-zzz99" })];

  it("matches on the full id", () => {
    expect(findAuditEntry(rows, "cfg-abc12345def")?.id).toBe("cfg-abc12345def");
  });

  it("matches on the short id shown in the summary line", () => {
    expect(findAuditEntry(rows, "abc12345")?.id).toBe("cfg-abc12345def");
  });

  it("returns undefined for an unknown id", () => {
    expect(findAuditEntry(rows, "nope")).toBeUndefined();
  });
});

describe("truncatePayload", () => {
  it("pretty-prints valid JSON", () => {
    expect(truncatePayload('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("shows non-JSON verbatim rather than dropping it", () => {
    expect(truncatePayload("not json at all")).toBe("not json at all");
  });

  it("hard-truncates a long rider payload with a char-count marker", () => {
    // A giant rider stored as a JSON string — the sort of payload that must not
    // break the render.
    const rider = "r".repeat(5000);
    const out = truncatePayload(JSON.stringify({ rider }));
    expect(out.length).toBeLessThanOrEqual(AUDIT_PAYLOAD_MAX + 40);
    expect(out).toContain("…[+");
    expect(out).toContain("chars]");
  });
});

describe("formatConfigAuditDetail", () => {
  it("exposes the before→after snapshots and actor/tier/scope/when meta", () => {
    const detail = formatConfigAuditDetail(entry(), NOW);
    expect(detail.before).toContain("claude-sonnet-5");
    expect(detail.after).toContain("claude-opus-4-8");
    const labels = detail.meta.map((m) => m.label);
    expect(labels).toEqual(["actor", "tier", "scope", "when", "correlation"]);
    const actor = detail.meta.find((m) => m.label === "actor")!.value;
    expect(actor).toBe("jesse (9001)");
  });

  it("omits the correlation row when there is none", () => {
    const detail = formatConfigAuditDetail(entry({ correlationId: null }), NOW);
    expect(detail.meta.some((m) => m.label === "correlation")).toBe(false);
  });

  it("truncates a long rider in the after snapshot", () => {
    const afterJson = JSON.stringify({ rider: "r".repeat(5000) });
    const detail = formatConfigAuditDetail(entry({ afterJson }), NOW);
    expect(detail.after).toContain("…[+");
    expect(detail.after.length).toBeLessThanOrEqual(AUDIT_PAYLOAD_MAX + 40);
  });
});
