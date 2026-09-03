import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureColumns } from "../packages/core/src/core/service-status/store-schema.js";
import {
  ServiceStatusStore,
  incidentClocks,
  resolveQueryLimit,
  type RegisteredSource,
} from "../packages/core/src/core/service-status/store.js";
import { HISTORY_RETENTION_MS } from "../packages/core/src/core/service-status/types.js";
import type {
  NormalizedComponent,
  NormalizedIncident,
  ServiceStatusAdapterResult,
  ServiceStatusLevel,
} from "../packages/core/src/core/service-status/types.js";

const SOURCE: RegisteredSource = { id: "github", label: "GitHub", provenance: "official" };
const OTHER: RegisteredSource = { id: "xai", label: "xAI", provenance: "official" };

const T0 = new Date("2026-09-03T12:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

function component(
  id: string,
  status: ServiceStatusLevel,
  overrides: Partial<NormalizedComponent> = {}
): NormalizedComponent {
  return {
    id,
    name: id,
    status,
    description: null,
    groupId: null,
    isGroup: false,
    selected: true,
    updatedAt: null,
    ...overrides,
  };
}

function incident(
  externalId: string,
  stage: "active" | "resolved",
  impact: ServiceStatusLevel,
  overrides: Partial<NormalizedIncident> = {}
): NormalizedIncident {
  return {
    externalId,
    title: `incident ${externalId}`,
    stage,
    lifecycle: stage === "resolved" ? "resolved" : "investigating",
    impact,
    url: null,
    startedAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    resolvedAt: stage === "resolved" ? T0.toISOString() : null,
    componentIds: [],
    updates: [],
    ...overrides,
  };
}

function adapterResult(
  overrides: Partial<ServiceStatusAdapterResult> = {}
): ServiceStatusAdapterResult {
  return {
    sourceId: SOURCE.id,
    fetchedAt: T0.toISOString(),
    baseline: { status: "operational", description: "All Systems Operational", derived: false },
    components: [],
    incidents: [],
    notes: [],
    ...overrides,
  };
}

describe("ServiceStatusStore", () => {
  let dir: string;
  let dbPath: string;
  let store: ServiceStatusStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "seam-service-status-"));
    dbPath = path.join(dir, "seam.db");
    store = new ServiceStatusStore(dbPath);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  describe("registration and cold boot", () => {
    it("lists a registered source before anything has been fetched", () => {
      store.registerSources([SOURCE, OTHER]);
      const snapshots = store.listSnapshots(T0);
      expect(snapshots.map((snapshot) => snapshot.sourceId)).toEqual(["github", "xai"]);
      expect(snapshots[0]!.observation.health).toBe("never_fetched");
      expect(snapshots[0]!.effectiveStatus).toBe("unknown");
      expect(snapshots[0]!.reportedAt).toBeNull();
      expect(snapshots[0]!.observation.lastAttemptAt).toBeNull();
    });

    it("re-opens the database and immediately exposes the last-known-good snapshot", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          components: [component("api", "degraded")],
          incidents: [incident("INC-1", "active", "partial_outage")],
        }),
        durationMs: 42,
        observedAt: T0,
      });
      store.close();

      const reopened = new ServiceStatusStore(dbPath);
      try {
        const snapshot = reopened.getSnapshot(SOURCE.id, at(60_000))!;
        expect(snapshot.effectiveStatus).toBe("partial_outage");
        expect(snapshot.components).toHaveLength(1);
        expect(snapshot.incidents).toHaveLength(1);
        expect(snapshot.observation.health).toBe("ok");
        expect(snapshot.reportedAt).toBe(T0.toISOString());

        // A cold boot long after the last success still returns the data, but
        // marks it stale rather than pretending it is current.
        const later = reopened.getSnapshot(SOURCE.id, at(24 * 60 * 60_000))!;
        expect(later.observation.health).toBe("stale");
        expect(later.effectiveStatus).toBe("partial_outage");
      } finally {
        reopened.close();
      }
    });

    it("throws once closed", () => {
      store.registerSources([SOURCE]);
      store.close();
      expect(() => store.listSnapshots(T0)).toThrow();
    });

    it("uses WAL and re-applies its schema idempotently", () => {
      store.registerSources([SOURCE]);
      store.close();

      const reopened = new Database(dbPath);
      try {
        expect(reopened.pragma("journal_mode", { simple: true })).toBe("wal");
      } finally {
        reopened.close();
      }

      // Opening the same database again must not disturb existing rows.
      const second = new ServiceStatusStore(dbPath);
      try {
        expect(second.listSnapshots(T0).map((snapshot) => snapshot.sourceId)).toEqual(["github"]);
      } finally {
        second.close();
      }
    });

    it("adds a column an older database is missing, and leaves present ones alone", () => {
      const db = new Database(path.join(dir, "migrate.db"));
      try {
        db.exec("CREATE TABLE example (id TEXT PRIMARY KEY, kept TEXT)");
        db.prepare("INSERT INTO example (id, kept) VALUES (?, ?)").run("row-1", "value");

        expect(ensureColumns(db, "example", { kept: "TEXT", added: "TEXT" })).toEqual(["added"]);
        expect(ensureColumns(db, "example", { kept: "TEXT", added: "TEXT" })).toEqual([]);
        expect(ensureColumns(db, "example", {})).toEqual([]);

        const row = db.prepare("SELECT * FROM example").get() as Record<string, unknown>;
        expect(row).toEqual({ id: "row-1", kept: "value", added: null });
      } finally {
        db.close();
      }
    });
  });

  describe("effective status aggregation", () => {
    it("takes the worst of baseline, selected components, and active incidents", () => {
      const outcome = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          baseline: { status: "degraded", description: "Minor Service Outage", derived: false },
          components: [component("api", "operational"), component("git", "partial_outage")],
          incidents: [incident("INC-1", "active", "major_outage")],
        }),
        durationMs: 10,
        observedAt: T0,
      });
      expect(outcome.snapshot.effectiveStatus).toBe("major_outage");
      expect(outcome.snapshot.baseline.status).toBe("degraded");
    });

    it("ignores components outside the relevant selection", () => {
      const outcome = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          components: [
            component("api", "operational"),
            component("marketing", "major_outage", { selected: false }),
          ],
        }),
        durationMs: 10,
        observedAt: T0,
      });
      expect(outcome.snapshot.effectiveStatus).toBe("operational");
    });

    it("keeps a page-level outage visible when every component reads operational", () => {
      const outcome = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          baseline: { status: "partial_outage", description: "Partial Outage", derived: false },
          components: [component("api", "operational")],
        }),
        durationMs: 10,
        observedAt: T0,
      });
      expect(outcome.snapshot.effectiveStatus).toBe("partial_outage");
    });
  });

  describe("observation axis", () => {
    it("keeps the last-known-good provider state across a failed refresh", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          components: [component("api", "degraded")],
          incidents: [incident("INC-1", "active", "degraded")],
        }),
        durationMs: 10,
        observedAt: T0,
      });

      const outcome = store.recordFailure({
        source: SOURCE,
        error: new Error("connect ECONNREFUSED"),
        durationMs: 9_000,
        observedAt: at(60_000),
      });

      expect(outcome.snapshot.effectiveStatus).toBe("degraded");
      expect(outcome.snapshot.components).toHaveLength(1);
      expect(outcome.snapshot.incidents).toHaveLength(1);
      expect(outcome.snapshot.reportedAt).toBe(T0.toISOString());
      expect(outcome.snapshot.observation.health).toBe("fetch_error");
      expect(outcome.snapshot.observation.lastError).toContain("ECONNREFUSED");
      expect(outcome.snapshot.observation.lastSuccessAt).toBe(T0.toISOString());
      expect(outcome.snapshot.observation.consecutiveFailures).toBe(1);
      expect(outcome.snapshot.observation.lastDurationMs).toBe(9_000);
    });

    it("reports repeated first-ever failures as fetch_error, never as stale", () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const outcome = store.recordFailure({
          source: SOURCE,
          error: new Error(`attempt ${String(attempt)} failed`),
          durationMs: 100,
          observedAt: at(attempt * 60_000),
        });
        expect(outcome.snapshot.observation.health).toBe("fetch_error");
        expect(outcome.snapshot.observation.consecutiveFailures).toBe(attempt);
        expect(outcome.snapshot.observation.lastSuccessAt).toBeNull();
        // No provider state has ever been observed, so nothing may be asserted
        // about the provider itself.
        expect(outcome.snapshot.effectiveStatus).toBe("unknown");
        expect(outcome.snapshot.reportedAt).toBeNull();
      }

      // Even a year later it is an error, not stale data we never had.
      expect(store.getSnapshot(SOURCE.id, at(365 * 24 * 60 * 60_000))!.observation.health).toBe(
        "fetch_error"
      );
    });

    it("moves fresh → stale → error → recovered and records each transition once", () => {
      const staleAfterMs = 15 * 60_000;
      const fresh = new ServiceStatusStore(path.join(dir, "fresh.db"), { staleAfterMs });
      try {
        fresh.recordSuccess({
          source: SOURCE,
          result: adapterResult(),
          durationMs: 10,
          observedAt: T0,
        });
        expect(fresh.getSnapshot(SOURCE.id, at(60_000))!.observation.health).toBe("ok");
        expect(fresh.getSnapshot(SOURCE.id, at(staleAfterMs + 1))!.observation.health).toBe("stale");

        const failed = fresh.recordFailure({
          source: SOURCE,
          error: new Error("gateway timeout"),
          durationMs: 10_000,
          observedAt: at(staleAfterMs + 60_000),
        });
        expect(failed.snapshot.observation.health).toBe("fetch_error");
        expect(failed.events.map((event) => event.kind)).toEqual(["fetch_health"]);
        expect(failed.events[0]!.previous).toBe("stale");

        const recovered = fresh.recordSuccess({
          source: SOURCE,
          result: adapterResult({ fetchedAt: at(staleAfterMs + 120_000).toISOString() }),
          durationMs: 10,
          observedAt: at(staleAfterMs + 120_000),
        });
        expect(recovered.snapshot.observation.health).toBe("ok");
        expect(recovered.snapshot.observation.consecutiveFailures).toBe(0);
        expect(recovered.events.map((event) => event.kind)).toEqual(["fetch_health"]);
        expect(recovered.events[0]!.previous).toBe("fetch_error");
      } finally {
        fresh.close();
      }
    });

    it("does not repeat a fetch-health event while the health is unchanged", () => {
      store.recordFailure({
        source: SOURCE,
        error: new Error("first"),
        durationMs: 10,
        observedAt: at(1_000),
      });
      const second = store.recordFailure({
        source: SOURCE,
        error: new Error("second"),
        durationMs: 10,
        observedAt: at(2_000),
      });
      expect(second.events).toEqual([]);
      expect(store.listEvents({ sourceId: SOURCE.id, kinds: ["fetch_health"] })).toHaveLength(1);
    });
  });

  describe("event diffing", () => {
    it("emits nothing at all for an identical repeated poll", () => {
      const result = adapterResult({
        components: [component("api", "degraded")],
        incidents: [incident("INC-1", "active", "degraded")],
      });

      const first = store.recordSuccess({ source: SOURCE, result, durationMs: 10, observedAt: T0 });
      expect(first.events.length).toBeGreaterThan(0);

      const second = store.recordSuccess({
        source: SOURCE,
        result,
        durationMs: 10,
        observedAt: at(60_000),
      });
      expect(second.events).toEqual([]);
      const third = store.recordSuccess({
        source: SOURCE,
        result,
        durationMs: 10,
        observedAt: at(120_000),
      });
      expect(third.events).toEqual([]);
      expect(store.listEvents({ sourceId: SOURCE.id })).toHaveLength(first.events.length);
    });

    it("records inventory additions, status changes and removals distinctly", () => {
      const first = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ components: [component("api", "operational")] }),
        durationMs: 10,
        observedAt: T0,
      });
      // A component entering the inventory is material even while healthy.
      expect(
        first.events.filter((event) => event.kind === "component_added").map((event) => event.subjectId)
      ).toEqual(["api"]);

      const second = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          components: [component("api", "degraded"), component("actions", "operational")],
        }),
        durationMs: 10,
        observedAt: at(60_000),
      });
      expect(
        second.events
          .filter((event) => event.kind.startsWith("component"))
          .map((event) => [event.kind, event.subjectId, event.previous, event.current])
      ).toEqual([
        ["component_added", "actions", null, "operational"],
        ["component", "api", "operational", "degraded"],
      ]);

      const third = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ components: [component("api", "degraded")] }),
        durationMs: 10,
        observedAt: at(120_000),
      });
      expect(
        third.events
          .filter((event) => event.kind.startsWith("component"))
          .map((event) => [event.kind, event.subjectId, event.previous, event.current])
      ).toEqual([["component_removed", "actions", "operational", "removed"]]);

      // Emptying the inventory removes what is left, and nothing more.
      const fourth = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ components: [] }),
        durationMs: 10,
        observedAt: at(180_000),
      });
      expect(
        fourth.events.filter((event) => event.kind.startsWith("component")).map((event) => event.kind)
      ).toEqual(["component_removed"]);
      expect(store.getSnapshot(SOURCE.id, at(180_000))!.components).toEqual([]);
    });

    it("emits an incident event for a lifecycle step with unchanged severity", () => {
      const advisory = (id: string, body: string) => ({
        id,
        lifecycle: "investigating",
        body,
        createdAt: T0.toISOString(),
        order: 0,
      });

      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "active", "degraded", {
              lifecycle: "investigating",
              updates: [advisory("u1", "looking into it")],
            }),
          ],
        }),
        durationMs: 10,
        observedAt: T0,
      });

      const progressed = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "active", "degraded", {
              lifecycle: "identified",
              updates: [advisory("u1", "looking into it")],
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(60_000),
      });
      const lifecycleEvents = progressed.events.filter((event) => event.kind === "incident");
      expect(lifecycleEvents).toHaveLength(1);
      expect(lifecycleEvents[0]!.detail).toBe("lifecycle investigating → identified");
      // Severity did not move, so the aggregate did not either.
      expect(progressed.events.some((event) => event.kind === "source")).toBe(false);

      const advised = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "active", "degraded", {
              lifecycle: "identified",
              updates: [
                advisory("u1", "looking into it"),
                { ...advisory("u2", "mitigation under way"), order: 1 },
              ],
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(120_000),
      });
      expect(advised.events.filter((event) => event.kind === "incident")).toHaveLength(1);
      expect(advised.events[0]!.detail).toBe("1 new update");

      // Re-polling the same advisories, reflowed and reordered, is not a change.
      const unchanged = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "active", "degraded", {
              lifecycle: "identified",
              updates: [
                { ...advisory("u2", "mitigation   under\n way"), order: 0 },
                { ...advisory("u1", "looking into it"), order: 1 },
              ],
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(180_000),
      });
      expect(unchanged.events).toEqual([]);
    });
  });

  describe("incident monotonicity", () => {
    it("refuses to reopen a resolved incident from a stale payload inside the window", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [incident("INC-1", "active", "partial_outage")] }),
        durationMs: 10,
        observedAt: T0,
      });
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "resolved", "partial_outage", {
              resolvedAt: at(60_000).toISOString(),
              updatedAt: at(60_000).toISOString(),
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(60_000),
      });

      const stale = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [incident("INC-1", "active", "partial_outage")] }),
        durationMs: 10,
        observedAt: at(120_000),
      });

      expect(stale.suppressedReopens).toEqual(["INC-1"]);
      expect(stale.snapshot.incidents[0]!.stage).toBe("resolved");
      expect(stale.snapshot.incidents[0]!.resolvedAt).toBe(at(60_000).toISOString());
      expect(stale.snapshot.effectiveStatus).toBe("operational");
      expect(stale.snapshot.incidents[0]!.lastSeenAt).toBe(at(120_000).toISOString());
      expect(stale.events).toEqual([]);
    });

    it("suppresses only the stale incident while recording a genuine new outage", () => {
      // 1. An incident is active.
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          components: [component("api", "operational"), component("actions", "operational")],
          incidents: [incident("INC-1", "active", "partial_outage")],
        }),
        durationMs: 10,
        observedAt: T0,
      });
      // 2. It resolves.
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          components: [component("api", "operational"), component("actions", "operational")],
          incidents: [
            incident("INC-1", "resolved", "partial_outage", {
              resolvedAt: at(60_000).toISOString(),
              updatedAt: at(60_000).toISOString(),
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(60_000),
      });

      // 3. A stale payload resurrects it, while the page really is degraded and
      //    a different component really is down.
      const mixed = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          baseline: { status: "degraded", description: "Minor Service Outage", derived: false },
          components: [component("api", "operational"), component("actions", "major_outage")],
          incidents: [
            incident("INC-1", "active", "partial_outage"),
            incident("INC-2", "active", "degraded", { updatedAt: at(120_000).toISOString() }),
          ],
        }),
        durationMs: 10,
        observedAt: at(120_000),
      });

      expect(mixed.suppressedReopens).toEqual(["INC-1"]);
      const byId = new Map(mixed.snapshot.incidents.map((entry) => [entry.externalId, entry]));
      expect(byId.get("INC-1")!.stage).toBe("resolved");
      expect(byId.get("INC-2")!.stage).toBe("active");

      // The stale incident contributes nothing, but neither the page verdict
      // nor the genuinely broken component is masked.
      expect(mixed.snapshot.effectiveStatus).toBe("major_outage");
      expect(mixed.snapshot.baseline.status).toBe("degraded");

      const kinds = mixed.events.map((event) => `${event.kind}:${String(event.subjectId)}`);
      expect(kinds).toContain("component:actions");
      expect(kinds).toContain("incident:INC-2");
      expect(kinds).toContain("baseline:null");
      expect(kinds).toContain("source:null");
      // No event is emitted for the suppressed incident: nothing about it changed.
      expect(kinds).not.toContain("incident:INC-1");

      // 4. When the real outage clears, the suppressed incident's severity is
      //    not left behind.
      const cleared = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          components: [component("api", "operational"), component("actions", "operational")],
          incidents: [
            incident("INC-1", "active", "partial_outage"),
            incident("INC-2", "resolved", "degraded", {
              resolvedAt: at(180_000).toISOString(),
              updatedAt: at(180_000).toISOString(),
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(180_000),
      });
      expect(cleared.snapshot.effectiveStatus).toBe("operational");
    });

    it("resolves an active incident that a successful payload no longer reports", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [incident("INC-1", "active", "major_outage")] }),
        durationMs: 10,
        observedAt: T0,
      });
      const gone = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [] }),
        durationMs: 10,
        observedAt: at(60_000),
      });

      const stored = gone.snapshot.incidents[0]!;
      expect(stored.stage).toBe("resolved");
      expect(stored.lifecycle).toBe("no_longer_reported");
      expect(stored.resolutionSource).toBe("not_reported");
      // No resolution time is invented for it.
      expect(stored.resolvedAt).toBeNull();
      expect(gone.snapshot.effectiveStatus).toBe("operational");
    });

    it("refuses to let an older active record overwrite a newer one", () => {
      // The false-green shape: a lagging feed copy of the same still-active
      // incident, reporting an earlier lifecycle and a milder impact.
      const newer = incident("INC-1", "active", "major_outage", {
        lifecycle: "monitoring",
        updatedAt: at(120_000).toISOString(),
        componentIds: ["api", "git"],
      });
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [newer] }),
        durationMs: 10,
        observedAt: at(120_000),
      });
      expect(store.getSnapshot(SOURCE.id, at(120_000))!.effectiveStatus).toBe("major_outage");

      const stale = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "active", "operational", {
              lifecycle: "investigating",
              updatedAt: at(60_000).toISOString(),
              componentIds: [],
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(180_000),
      });

      expect(stale.skippedStale).toEqual(["INC-1"]);
      const stored = stale.snapshot.incidents[0]!;
      expect(stored.impact).toBe("major_outage");
      expect(stored.lifecycle).toBe("monitoring");
      expect(stored.componentIds).toEqual(["api", "git"]);
      expect(stored.updatedAt).toBe(at(120_000).toISOString());
      // Still red, and nothing changed, so no event.
      expect(stale.snapshot.effectiveStatus).toBe("major_outage");
      expect(stale.events).toEqual([]);
      // We did still see it upstream.
      expect(stored.lastSeenAt).toBe(at(180_000).toISOString());
    });

    it("refuses to let an older resolved record rewind the retention clock", () => {
      const resolvedAt = at(120_000).toISOString();
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "resolved", "major_outage", { resolvedAt, updatedAt: resolvedAt }),
          ],
        }),
        durationMs: 10,
        observedAt: at(120_000),
      });

      // An older resolved copy — still inside the window, so it is eligible to
      // be written — naming an earlier resolution time. Accepting it would move
      // `retention_at` back and expire the row early.
      const earlier = at(30_000).toISOString();
      const rewound = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "resolved", "major_outage", {
              resolvedAt: earlier,
              updatedAt: earlier,
              startedAt: earlier,
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(180_000),
      });
      expect(rewound.skippedExpired).toEqual([]);
      expect(rewound.skippedStale).toEqual(["INC-1"]);
      expect(rewound.snapshot.incidents[0]!.resolvedAt).toBe(resolvedAt);
      expect(rewound.snapshot.incidents[0]!.updatedAt).toBe(resolvedAt);

      // The window is intact, so a stale active copy still cannot reopen it.
      const reopen = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "active", "major_outage", { updatedAt: at(240_000).toISOString() }),
          ],
        }),
        durationMs: 10,
        observedAt: at(240_000),
      });
      expect(reopen.suppressedReopens).toEqual(["INC-1"]);
      expect(reopen.snapshot.incidents[0]!.stage).toBe("resolved");
      expect(reopen.snapshot.effectiveStatus).toBe("operational");
    });

    it("cannot rewind the clocks via an accepted newer record naming an earlier resolution", () => {
      // The subtle one: the incoming record is genuinely *newer* by
      // `updatedAt`, so it is applied — but it names an earlier `resolvedAt`.
      // Writing that through would rewind both the resolution time and the
      // retention window, expiring the incident ahead of schedule.
      const resolvedAt = at(120_000).toISOString();
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "resolved", "major_outage", { resolvedAt, updatedAt: resolvedAt }),
          ],
        }),
        durationMs: 10,
        observedAt: at(120_000),
      });

      const earlier = at(30_000).toISOString();
      const applied = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "resolved", "major_outage", {
              startedAt: earlier,
              resolvedAt: earlier,
              // Newer overall, so this record is accepted, not skipped.
              updatedAt: at(180_000).toISOString(),
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(180_000),
      });

      expect(applied.skippedStale).toEqual([]);
      expect(applied.skippedExpired).toEqual([]);
      // The record was applied — its newer updatedAt is stored…
      expect(applied.snapshot.incidents[0]!.updatedAt).toBe(at(180_000).toISOString());
      // …but neither clock moved backward.
      expect(applied.snapshot.incidents[0]!.resolvedAt).toBe(resolvedAt);

      // Retention is observable through the boundary: the window must still be
      // measured from the later resolution, not the earlier one it named.
      const fromEarlier = at(30_000 + HISTORY_RETENTION_MS + 1);
      expect(
        store.listIncidents({ sourceId: SOURCE.id, limit: 10 }, fromEarlier).map((e) => e.externalId)
      ).toEqual(["INC-1"]);
      const fromLater = at(120_000 + HISTORY_RETENTION_MS + 1);
      expect(store.listIncidents({ sourceId: SOURCE.id, limit: 10 }, fromLater)).toEqual([]);
    });

    it("reopens an inferred resolution as a fully consistent active row", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [incident("INC-1", "active", "major_outage")] }),
        durationMs: 10,
        observedAt: T0,
      });
      const vanished = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [] }),
        durationMs: 10,
        observedAt: at(60_000),
      });
      expect(vanished.snapshot.incidents[0]!.resolutionSource).toBe("not_reported");

      const reopened = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "active", "major_outage", { updatedAt: at(120_000).toISOString() }),
          ],
        }),
        durationMs: 10,
        observedAt: at(120_000),
      });

      // An active row must be coherent: no resolution time, no resolution
      // source. Clamping the stored inferred-resolution bookkeeping forward
      // would leave an active incident claiming it had been resolved.
      const row = reopened.snapshot.incidents[0]!;
      expect(row.stage).toBe("active");
      expect(row.resolvedAt).toBeNull();
      expect(row.resolutionSource).toBe("none");
      expect(row.firstSeenAt).toBe(T0.toISOString());
      expect(reopened.snapshot.effectiveStatus).toBe("major_outage");

      // And it is still visible far beyond any retention window, because active
      // incidents are never pruned or filtered.
      expect(
        store
          .listIncidents({ sourceId: SOURCE.id, limit: 10 }, at(HISTORY_RETENTION_MS * 2))
          .map((entry) => entry.externalId)
      ).toEqual(["INC-1"]);
    });

    it("reopens after a transient omission even when upstream never touched its clock", () => {
      // A provider that briefly drops an incident from its payload and then
      // republishes it byte for byte does not advance `updatedAt`. Treating
      // that as a resolved-wins tie would hold a live major outage green until
      // the provider happened to touch its clock.
      const original = incident("INC-1", "active", "major_outage", {
        updatedAt: T0.toISOString(),
      });

      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [original] }),
        durationMs: 10,
        observedAt: T0,
      });
      expect(store.getSnapshot(SOURCE.id, T0)!.effectiveStatus).toBe("major_outage");

      // T1: the incident is missing from an otherwise successful payload.
      const omitted = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [] }),
        durationMs: 10,
        observedAt: at(60_000),
      });
      expect(omitted.snapshot.incidents[0]!.stage).toBe("resolved");
      expect(omitted.snapshot.incidents[0]!.resolutionSource).toBe("not_reported");
      expect(omitted.snapshot.effectiveStatus).toBe("operational");

      // T2: the identical record returns — same `updatedAt` as the original.
      const returned = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [original] }),
        durationMs: 10,
        observedAt: at(120_000),
      });

      expect(returned.suppressedReopens).toEqual([]);
      expect(returned.skippedStale).toEqual([]);
      const row = returned.snapshot.incidents[0]!;
      expect(row.stage).toBe("active");
      expect(row.impact).toBe("major_outage");
      expect(row.resolutionSource).toBe("none");
      expect(row.resolvedAt).toBeNull();
      expect(row.updatedAt).toBe(T0.toISOString());
      expect(row.firstSeenAt).toBe(T0.toISOString());
      expect(returned.snapshot.effectiveStatus).toBe("major_outage");
      expect(
        returned.events.filter((event) => event.kind === "incident").map((event) => event.detail)
      ).toEqual(["stage resolved → active, lifecycle no_longer_reported → investigating"]);
    });

    it("still suppresses an equal-time active copy of an upstream resolution", () => {
      // The mirror of the case above: when the provider itself declared the
      // resolution, an equal-timestamp active copy is a stale feed record and
      // must not reopen it.
      const sameMoment = at(60_000).toISOString();
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "resolved", "major_outage", {
              updatedAt: sameMoment,
              resolvedAt: sameMoment,
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(60_000),
      });
      expect(store.getSnapshot(SOURCE.id, at(60_000))!.incidents[0]!.resolutionSource).toBe(
        "upstream"
      );

      const stale = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [incident("INC-1", "active", "major_outage", { updatedAt: sameMoment })],
        }),
        durationMs: 10,
        observedAt: at(120_000),
      });
      expect(stale.suppressedReopens).toEqual(["INC-1"]);
      expect(stale.snapshot.incidents[0]!.stage).toBe("resolved");
      expect(stale.snapshot.incidents[0]!.resolvedAt).toBe(sameMoment);
      expect(stale.snapshot.effectiveStatus).toBe("operational");
    });

    it("prefers resolved over active when the timestamps are equal", () => {
      const sameMoment = at(60_000).toISOString();
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [incident("INC-1", "active", "major_outage", { updatedAt: sameMoment })],
        }),
        durationMs: 10,
        observedAt: at(60_000),
      });

      // Equal timestamps, resolved copy: it wins.
      const resolved = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "resolved", "major_outage", {
              updatedAt: sameMoment,
              resolvedAt: sameMoment,
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(120_000),
      });
      expect(resolved.skippedStale).toEqual([]);
      expect(resolved.snapshot.incidents[0]!.stage).toBe("resolved");

      // …and the active copy at that same moment does not win it back.
      const backToActive = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [incident("INC-1", "active", "major_outage", { updatedAt: sameMoment })],
        }),
        durationMs: 10,
        observedAt: at(180_000),
      });
      expect(backToActive.snapshot.incidents[0]!.stage).toBe("resolved");
      expect(backToActive.snapshot.effectiveStatus).toBe("operational");
    });

    it("does not let a stale incident mask unrelated new degradation", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          components: [component("api", "operational")],
          incidents: [
            incident("INC-1", "active", "degraded", { updatedAt: at(120_000).toISOString() }),
          ],
        }),
        durationMs: 10,
        observedAt: at(120_000),
      });

      const mixed = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          baseline: { status: "degraded", description: "Minor Service Outage", derived: false },
          components: [component("api", "major_outage")],
          incidents: [
            // Stale copy of the same incident…
            incident("INC-1", "active", "operational", { updatedAt: at(60_000).toISOString() }),
          ],
        }),
        durationMs: 10,
        observedAt: at(180_000),
      });

      expect(mixed.skippedStale).toEqual(["INC-1"]);
      // Rejecting the stale incident must not also reject the genuinely new
      // component and page degradation that arrived in the same payload.
      expect(mixed.snapshot.components[0]!.status).toBe("major_outage");
      expect(mixed.snapshot.baseline.status).toBe("degraded");
      expect(mixed.snapshot.effectiveStatus).toBe("major_outage");
      expect(mixed.events.map((event) => event.kind)).toContain("component");
    });

    it("keeps a long-running incident for the full window after it disappears", () => {
      // A hundred-day outage: its own timestamps are far outside the retention
      // window, so the retention clock has to restart when it stops being
      // reported or it would vanish on that very refresh.
      const startedAt = at(-100 * 24 * 60 * 60_000).toISOString();
      const longRunning = incident("INC-LONG", "active", "major_outage", {
        startedAt,
        updatedAt: startedAt,
      });

      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [longRunning] }),
        durationMs: 10,
        observedAt: T0,
      });

      const vanished = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [] }),
        durationMs: 10,
        observedAt: at(60_000),
      });
      const stored = vanished.snapshot.incidents[0]!;
      expect(stored.stage).toBe("resolved");
      expect(stored.resolutionSource).toBe("not_reported");
      expect(stored.resolvedAt).toBeNull();

      // Still queryable at exactly ninety days after the disappearance.
      const boundary = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [] }),
        durationMs: 10,
        observedAt: at(60_000 + HISTORY_RETENTION_MS),
      });
      expect(boundary.snapshot.incidents.map((entry) => entry.externalId)).toEqual(["INC-LONG"]);

      // One millisecond past it, and only then, it is pruned.
      const expired = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [] }),
        durationMs: 10,
        observedAt: at(60_000 + HISTORY_RETENTION_MS + 1),
      });
      expect(expired.snapshot.incidents).toEqual([]);
    });

    it("lets a vanished long-running incident reopen before its window expires", () => {
      const startedAt = at(-100 * 24 * 60 * 60_000).toISOString();
      const longRunning = incident("INC-LONG", "active", "major_outage", {
        startedAt,
        updatedAt: startedAt,
      });
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [longRunning] }),
        durationMs: 10,
        observedAt: T0,
      });
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [] }),
        durationMs: 10,
        observedAt: at(60_000),
      });

      const returned = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-LONG", "active", "major_outage", {
              startedAt,
              updatedAt: at(120_000).toISOString(),
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(120_000),
      });
      expect(returned.suppressedReopens).toEqual([]);
      expect(returned.snapshot.incidents[0]!.stage).toBe("active");
      expect(returned.snapshot.effectiveStatus).toBe("major_outage");
    });

    it("lets an incident Seam only inferred resolved go active again", () => {
      // A transiently truncated payload must not be able to pin a live outage
      // as resolved: monotonicity protects upstream-declared resolutions only.
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [incident("INC-1", "active", "major_outage")] }),
        durationMs: 10,
        observedAt: T0,
      });
      const vanished = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [] }),
        durationMs: 10,
        observedAt: at(60_000),
      });
      expect(vanished.snapshot.incidents[0]!.resolutionSource).toBe("not_reported");

      const returned = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "active", "major_outage", { updatedAt: at(120_000).toISOString() }),
          ],
        }),
        durationMs: 10,
        observedAt: at(120_000),
      });

      expect(returned.suppressedReopens).toEqual([]);
      expect(returned.snapshot.incidents[0]!.stage).toBe("active");
      expect(returned.snapshot.incidents[0]!.resolutionSource).toBe("none");
      expect(returned.snapshot.effectiveStatus).toBe("major_outage");
      // The original sighting is preserved rather than restarted.
      expect(returned.snapshot.incidents[0]!.firstSeenAt).toBe(T0.toISOString());
      const reopened = returned.events.filter((event) => event.kind === "incident");
      expect(reopened).toHaveLength(1);
      expect(reopened[0]!.current).toMatch(/^active\/major_outage\//);
      expect(reopened[0]!.detail).toBe("stage resolved → active, lifecycle no_longer_reported → investigating");
    });

    it("still refuses to reopen an upstream-declared resolution", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "resolved", "major_outage", {
              resolvedAt: T0.toISOString(),
              updatedAt: T0.toISOString(),
            }),
          ],
        }),
        durationMs: 10,
        observedAt: T0,
      });
      expect(store.getSnapshot(SOURCE.id, T0)!.incidents[0]!.resolutionSource).toBe("upstream");

      const stale = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [incident("INC-1", "active", "major_outage")] }),
        durationMs: 10,
        observedAt: at(60_000),
      });
      expect(stale.suppressedReopens).toEqual(["INC-1"]);
      expect(stale.snapshot.incidents[0]!.stage).toBe("resolved");
      expect(stale.snapshot.effectiveStatus).toBe("operational");
    });

    it("retains an incident exactly at the retention boundary and prunes one past it", () => {
      const resolvedAt = T0.toISOString();
      const seed = () => {
        store.recordSuccess({
          source: SOURCE,
          result: adapterResult({
            incidents: [incident("INC-1", "resolved", "major_outage", { resolvedAt, updatedAt: resolvedAt })],
          }),
          durationMs: 10,
          observedAt: T0,
        });
      };
      seed();

      // Exactly 90 days later the row is still inside the window, so a stale
      // active copy is still refused.
      const boundary = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [incident("INC-1", "active", "major_outage")] }),
        durationMs: 10,
        observedAt: at(HISTORY_RETENTION_MS),
      });
      expect(boundary.suppressedReopens).toEqual(["INC-1"]);
      expect(boundary.snapshot.incidents[0]!.stage).toBe("resolved");

      // One millisecond past the window the row is gone and the same upstream
      // id is free to recur.
      const recurrence = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "active", "major_outage", {
              startedAt: at(HISTORY_RETENTION_MS + 1).toISOString(),
              updatedAt: at(HISTORY_RETENTION_MS + 1).toISOString(),
            }),
          ],
        }),
        durationMs: 10,
        observedAt: at(HISTORY_RETENTION_MS + 1),
      });
      expect(recurrence.suppressedReopens).toEqual([]);
      expect(recurrence.snapshot.incidents[0]!.stage).toBe("active");
      expect(recurrence.snapshot.incidents[0]!.firstSeenAt).toBe(
        at(HISTORY_RETENTION_MS + 1).toISOString()
      );
      expect(recurrence.snapshot.effectiveStatus).toBe("major_outage");
    });

    it("never stores an incident the payload still carries but retention excludes", () => {
      // Real feeds publish years of history. Storing an already-expired
      // incident only to prune it on the next poll would re-emit its
      // "appeared" event on every refresh forever — the churn that live
      // traffic exposed and that fixtures inside the window cannot show.
      const ancient = at(-HISTORY_RETENTION_MS - 60_000).toISOString();
      const payload = adapterResult({
        incidents: [
          incident("INC-OLD", "resolved", "major_outage", {
            startedAt: ancient,
            updatedAt: ancient,
            resolvedAt: ancient,
          }),
          incident("INC-RECENT", "resolved", "degraded"),
        ],
      });

      const first = store.recordSuccess({
        source: SOURCE,
        result: payload,
        durationMs: 10,
        observedAt: T0,
      });
      expect(first.skippedExpired).toEqual(["INC-OLD"]);
      expect(first.snapshot.incidents.map((entry) => entry.externalId)).toEqual(["INC-RECENT"]);

      const eventsAfterFirst = store.listEvents({ sourceId: SOURCE.id, limit: 500 }).length;
      for (let poll = 1; poll <= 3; poll += 1) {
        const repeat = store.recordSuccess({
          source: SOURCE,
          result: payload,
          durationMs: 10,
          observedAt: at(poll * 60_000),
        });
        expect(repeat.events).toEqual([]);
        expect(repeat.skippedExpired).toEqual(["INC-OLD"]);
      }
      expect(store.listEvents({ sourceId: SOURCE.id, limit: 500 })).toHaveLength(eventsAfterFirst);
    });

    it("still stores an active incident older than the retention window", () => {
      const ancient = at(-HISTORY_RETENTION_MS - 60_000).toISOString();
      const outcome = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-OLD-ACTIVE", "active", "major_outage", {
              startedAt: ancient,
              updatedAt: ancient,
            }),
          ],
        }),
        durationMs: 10,
        observedAt: T0,
      });
      expect(outcome.skippedExpired).toEqual([]);
      expect(outcome.snapshot.incidents).toHaveLength(1);
      expect(outcome.snapshot.effectiveStatus).toBe("major_outage");
    });

    it("prunes only the refreshed source's incidents", () => {
      // Seed both sources with a resolved incident that is inside the window
      // when written, then move the clock past it for one source only.
      for (const source of [SOURCE, OTHER]) {
        store.recordSuccess({
          source,
          result: adapterResult({
            sourceId: source.id,
            incidents: [incident(`${source.id}-INC`, "resolved", "degraded")],
          }),
          durationMs: 10,
          observedAt: T0,
        });
      }
      expect(store.listIncidents({ limit: 100 })).toHaveLength(2);

      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [] }),
        durationMs: 10,
        observedAt: at(HISTORY_RETENTION_MS + 60_000),
      });

      // The other source's row is untouched by a refresh it did not take part in.
      expect(store.listIncidents({ sourceId: SOURCE.id, limit: 100 })).toHaveLength(0);
      expect(store.listIncidents({ sourceId: OTHER.id, limit: 100 })).toHaveLength(1);
    });

    it("ages resolved history out even when every later poll fails", () => {
      const resolvedAt = T0.toISOString();
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          components: [component("api", "degraded")],
          incidents: [
            incident("INC-DONE", "resolved", "major_outage", { resolvedAt, updatedAt: resolvedAt }),
            incident("INC-OPEN", "active", "partial_outage"),
          ],
        }),
        durationMs: 10,
        observedAt: T0,
      });

      // Exactly at the boundary the resolved incident is still retained.
      const boundary = store.recordFailure({
        source: SOURCE,
        error: new Error("still down"),
        durationMs: 10,
        observedAt: at(HISTORY_RETENTION_MS),
      });
      expect(boundary.snapshot.incidents.map((entry) => entry.externalId).sort()).toEqual([
        "INC-DONE",
        "INC-OPEN",
      ]);

      // One millisecond later — still on a failing poll — it is gone.
      const expired = store.recordFailure({
        source: SOURCE,
        error: new Error("still down"),
        durationMs: 10,
        observedAt: at(HISTORY_RETENTION_MS + 1),
      });
      expect(expired.snapshot.incidents.map((entry) => entry.externalId)).toEqual(["INC-OPEN"]);

      // The last-known-good provider state is untouched by the prune: the
      // failure axis moved, the provider axis did not.
      expect(expired.snapshot.components.map((entry) => entry.status)).toEqual(["degraded"]);
      expect(expired.snapshot.baseline.status).toBe("operational");
      expect(expired.snapshot.reportedAt).toBe(T0.toISOString());
      // A failing last attempt reports as an error, not as stale data.
      expect(expired.snapshot.observation.health).toBe("fetch_error");
      expect(expired.snapshot.observation.consecutiveFailures).toBe(2);

      // Repeated failures keep the same shape — the active incident survives.
      for (let attempt = 3; attempt <= 5; attempt += 1) {
        const again = store.recordFailure({
          source: SOURCE,
          error: new Error("still down"),
          durationMs: 10,
          observedAt: at(HISTORY_RETENTION_MS + attempt),
        });
        expect(again.snapshot.incidents.map((entry) => entry.externalId)).toEqual(["INC-OPEN"]);
      }
    });

    it("hides expired resolved history from queries even with no poll at all", () => {
      const resolvedAt = T0.toISOString();
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-DONE", "resolved", "major_outage", { resolvedAt, updatedAt: resolvedAt }),
            incident("INC-OPEN", "active", "partial_outage"),
          ],
        }),
        durationMs: 10,
        observedAt: T0,
      });

      // No further poll of any kind. Retention is a property of the data, so
      // the read applies it regardless of when a prune last ran.
      const atBoundary = at(HISTORY_RETENTION_MS);
      expect(
        store.listIncidents({ sourceId: SOURCE.id, limit: 100 }, atBoundary).map((e) => e.externalId).sort()
      ).toEqual(["INC-DONE", "INC-OPEN"]);
      expect(store.getSnapshot(SOURCE.id, atBoundary)!.incidents).toHaveLength(2);

      const past = at(HISTORY_RETENTION_MS + 1);
      expect(
        store.listIncidents({ sourceId: SOURCE.id, limit: 100 }, past).map((e) => e.externalId)
      ).toEqual(["INC-OPEN"]);
      expect(store.getSnapshot(SOURCE.id, past)!.incidents.map((e) => e.externalId)).toEqual([
        "INC-OPEN",
      ]);
    });

    it("never prunes a long-running active incident", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [incident("INC-LONG", "active", "partial_outage")] }),
        durationMs: 10,
        observedAt: T0,
      });
      const later = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [incident("INC-LONG", "active", "partial_outage")] }),
        durationMs: 10,
        observedAt: at(HISTORY_RETENTION_MS * 2),
      });
      expect(later.snapshot.incidents).toHaveLength(1);
      expect(later.snapshot.incidents[0]!.stage).toBe("active");
    });

    it("allows a distinct upstream id to be active alongside a resolved one", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [incident("INC-1", "resolved", "major_outage")],
        }),
        durationMs: 10,
        observedAt: T0,
      });
      const outcome = store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          incidents: [
            incident("INC-1", "resolved", "major_outage"),
            incident("INC-2", "active", "degraded", { updatedAt: at(60_000).toISOString() }),
          ],
        }),
        durationMs: 10,
        observedAt: at(60_000),
      });
      expect(outcome.suppressedReopens).toEqual([]);
      expect(outcome.snapshot.effectiveStatus).toBe("degraded");
    });
  });

  describe("source isolation and atomicity", () => {
    it("keeps sources independent", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ components: [component("api", "major_outage")] }),
        durationMs: 10,
        observedAt: T0,
      });
      store.recordSuccess({
        source: OTHER,
        result: adapterResult({ sourceId: OTHER.id, components: [component("api", "operational")] }),
        durationMs: 10,
        observedAt: T0,
      });

      expect(store.getSnapshot(SOURCE.id, T0)!.effectiveStatus).toBe("major_outage");
      expect(store.getSnapshot(OTHER.id, T0)!.effectiveStatus).toBe("operational");
      expect(store.listEvents({ sourceId: OTHER.id }).every((event) => event.sourceId === OTHER.id)).toBe(
        true
      );
    });

    it("rejects a result whose source id does not match the registered source", () => {
      expect(() =>
        store.recordSuccess({
          source: SOURCE,
          result: adapterResult({ sourceId: "someone-else" }),
          durationMs: 10,
          observedAt: T0,
        })
      ).toThrow(/does not match/i);
    });

    it("rejects a non-canonical timestamp before mutating anything", () => {
      // `2026-09-03T13:00:00+02:00` is 11:00Z — *older* than the stored record —
      // but sorts after `…T12:00:00.000Z`. Accepted, it would win every
      // lexicographic comparison in the store and overwrite a live major outage
      // with a green one.
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          components: [component("api", "major_outage")],
          incidents: [
            incident("INC-1", "active", "major_outage", {
              updatedAt: "2026-09-03T12:00:00.000Z",
            }),
          ],
        }),
        durationMs: 10,
        observedAt: T0,
      });
      const before = store.getSnapshot(SOURCE.id, T0)!;
      expect(before.effectiveStatus).toBe("major_outage");

      const noncanonical = adapterResult({
        components: [component("api", "operational")],
        incidents: [
          incident("INC-1", "active", "operational", {
            // Parseable, and later as a string; earlier as an instant.
            updatedAt: "2026-09-03T13:00:00+02:00",
          }),
        ],
      });
      expect(() =>
        store.recordSuccess({
          source: SOURCE,
          result: noncanonical,
          durationMs: 10,
          observedAt: at(60_000),
        })
      ).toThrow(/incident\.updatedAt is not canonical/i);

      // Nothing was written: the last-known-good outage stands.
      const after = store.getSnapshot(SOURCE.id, at(60_000))!;
      expect(after.effectiveStatus).toBe("major_outage");
      expect(after.components.map((entry) => entry.status)).toEqual(["major_outage"]);
      expect(after.incidents[0]!.impact).toBe("major_outage");
      expect(after.incidents[0]!.updatedAt).toBe("2026-09-03T12:00:00.000Z");
      expect(after.reportedAt).toBe(before.reportedAt);
      expect(store.listEvents({ sourceId: SOURCE.id, limit: 100 })).toHaveLength(
        store.listEvents({ sourceId: SOURCE.id, limit: 100 }).length
      );
    });

    it("rejects every non-canonical timestamp field", () => {
      const cases: [string, () => ReturnType<typeof adapterResult>, RegExp][] = [
        [
          "fetchedAt",
          () => adapterResult({ fetchedAt: "2026-09-03T12:00:00Z" }),
          /fetchedAt is not canonical/i,
        ],
        [
          "component.updatedAt",
          () =>
            adapterResult({
              components: [component("api", "operational", { updatedAt: "2026-09-03T12:00:00+00:00" })],
            }),
          /component\.updatedAt is not canonical/i,
        ],
        [
          "incident.startedAt",
          () =>
            adapterResult({
              incidents: [incident("INC-1", "active", "degraded", { startedAt: "2026-09-03T12:00:00Z" })],
            }),
          /incident\.startedAt is not canonical/i,
        ],
        [
          "incident.resolvedAt",
          () =>
            adapterResult({
              incidents: [
                incident("INC-1", "resolved", "degraded", { resolvedAt: "2026-09-03T12:00:00Z" }),
              ],
            }),
          /incident\.resolvedAt is not canonical/i,
        ],
        [
          "update.createdAt",
          () =>
            adapterResult({
              incidents: [
                incident("INC-1", "active", "degraded", {
                  updates: [
                    {
                      id: "u1",
                      lifecycle: "investigating",
                      body: "",
                      createdAt: "2026-09-03T12:00:00Z",
                      order: 0,
                    },
                  ],
                }),
              ],
            }),
          /update\.createdAt is not canonical/i,
        ],
      ];

      for (const [name, build, pattern] of cases) {
        expect(
          () =>
            store.recordSuccess({
              source: SOURCE,
              result: build(),
              durationMs: 10,
              observedAt: T0,
            }),
          name
        ).toThrow(pattern);
      }
      // Validation runs before the transaction opens, so not even the source
      // registration row was written.
      expect(store.getSnapshot(SOURCE.id, T0)).toBeNull();
      expect(store.listIncidents({ limit: 100 })).toEqual([]);
    });

    it("validates before mutating, leaving the previous snapshot untouched", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ components: [component("api", "degraded")] }),
        durationMs: 10,
        observedAt: T0,
      });

      const invalid = adapterResult({
        components: [component("api", "operational"), component("api", "operational")],
      });
      expect(() =>
        store.recordSuccess({ source: SOURCE, result: invalid, durationMs: 10, observedAt: at(60_000) })
      ).toThrow(/duplicate component id/i);

      const snapshot = store.getSnapshot(SOURCE.id, at(60_000))!;
      expect(snapshot.components).toHaveLength(1);
      expect(snapshot.components[0]!.status).toBe("degraded");
      expect(snapshot.reportedAt).toBe(T0.toISOString());
    });

    it("rolls the whole refresh back when a write fails part-way through", () => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ components: [component("api", "operational")] }),
        durationMs: 10,
        observedAt: T0,
      });

      // A structurally valid incident whose update object cannot be serialized:
      // it passes validation and then fails inside the transaction, after an
      // earlier incident in the same payload has already been written.
      const circular: Record<string, unknown> = {
        id: "u1",
        lifecycle: "investigating",
        body: "",
        createdAt: T0.toISOString(),
        order: 0,
      };
      circular.self = circular;

      // The failure must come from the write, not from validation, or this
      // would not exercise rollback at all.
      expect(() =>
        store.recordSuccess({
          source: SOURCE,
          result: adapterResult({
            components: [component("api", "major_outage")],
            incidents: [
              incident("INC-OK", "active", "degraded"),
              incident("INC-BAD", "active", "degraded", {
                updates: [circular as never],
              }),
            ],
          }),
          durationMs: 10,
          observedAt: at(60_000),
        })
      ).toThrow(/circular/i);

      const snapshot = store.getSnapshot(SOURCE.id, at(60_000))!;
      expect(snapshot.incidents).toEqual([]);
      expect(snapshot.components.map((entry) => entry.status)).toEqual(["operational"]);
      expect(snapshot.effectiveStatus).toBe("operational");
    });
  });

  describe("incident clocks", () => {
    // Tested directly rather than only through the store: today
    // `decideIncidentWrite` happens to block the one path that would reach an
    // active record while a resolution is stored, so the integration tests
    // cannot distinguish stage-aware clamping from a blanket "keep the later
    // value". These pin the contract itself, so a future change to the
    // decision rules cannot silently reintroduce an incoherent row.
    const upstreamResolved = {
      resolved_at: "2026-09-03T12:02:00.000Z",
      retention_at: "2026-09-03T12:02:00.000Z",
      resolution_source: "upstream",
    };

    it("clears the resolution when the incoming record is active", () => {
      expect(
        incidentClocks(
          { stage: "active", updatedAt: "2026-09-03T12:05:00.000Z", resolvedAt: null },
          upstreamResolved
        )
      ).toEqual({ resolvedAt: null, retentionAt: "2026-09-03T12:05:00.000Z" });
    });

    it("restarts retention from the incident's own clock while active", () => {
      // Not carried forward from the stored row: an active incident is never
      // pruned, so this is only the floor for whenever it does resolve.
      expect(
        incidentClocks(
          { stage: "active", updatedAt: "2026-09-03T12:01:00.000Z", resolvedAt: null },
          { ...upstreamResolved, retention_at: "2026-09-03T18:00:00.000Z" }
        )
      ).toEqual({ resolvedAt: null, retentionAt: "2026-09-03T12:01:00.000Z" });
    });

    it("never moves an upstream resolution or its retention backward", () => {
      expect(
        incidentClocks(
          {
            stage: "resolved",
            updatedAt: "2026-09-03T12:09:00.000Z",
            resolvedAt: "2026-09-03T11:00:00.000Z",
          },
          upstreamResolved
        )
      ).toEqual({
        resolvedAt: "2026-09-03T12:02:00.000Z",
        retentionAt: "2026-09-03T12:02:00.000Z",
      });
    });

    it("adopts a later upstream resolution", () => {
      expect(
        incidentClocks(
          {
            stage: "resolved",
            updatedAt: "2026-09-03T12:09:00.000Z",
            resolvedAt: "2026-09-03T12:08:00.000Z",
          },
          upstreamResolved
        )
      ).toEqual({
        resolvedAt: "2026-09-03T12:08:00.000Z",
        retentionAt: "2026-09-03T12:08:00.000Z",
      });
    });

    it("does not treat an inferred resolution as a resolution time", () => {
      // `not_reported` rows carry no resolved_at, and their retention is Seam
      // bookkeeping — it still may not shorten, but it is not a claim about
      // when the provider resolved anything.
      const inferred = {
        resolved_at: null,
        retention_at: "2026-09-03T12:06:00.000Z",
        resolution_source: "not_reported",
      };
      expect(
        incidentClocks(
          {
            stage: "resolved",
            updatedAt: "2026-09-03T12:07:00.000Z",
            resolvedAt: "2026-09-03T12:03:00.000Z",
          },
          inferred
        )
      ).toEqual({
        resolvedAt: "2026-09-03T12:03:00.000Z",
        retentionAt: "2026-09-03T12:06:00.000Z",
      });
    });

    it("uses the incoming record alone when there is no stored row", () => {
      expect(
        incidentClocks(
          { stage: "resolved", updatedAt: "2026-09-03T12:09:00.000Z", resolvedAt: null },
          undefined
        )
      ).toEqual({
        resolvedAt: null,
        retentionAt: "2026-09-03T12:09:00.000Z",
      });
    });
  });

  describe("queries", () => {
    beforeEach(() => {
      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({
          components: [component("api", "major_outage")],
          incidents: [incident("INC-1", "active", "major_outage")],
        }),
        durationMs: 10,
        observedAt: T0,
      });
    });

    it("reports whether any source has an active incident", () => {
      expect(store.hasActiveIncident()).toBe(true);
      expect(store.hasActiveIncident(SOURCE.id)).toBe(true);
      expect(store.hasActiveIncident(OTHER.id)).toBe(false);

      store.recordSuccess({
        source: SOURCE,
        result: adapterResult({ incidents: [] }),
        durationMs: 10,
        observedAt: at(60_000),
      });
      expect(store.hasActiveIncident()).toBe(false);
    });

    it("filters incidents by source, stage and time", () => {
      expect(store.listIncidents({ sourceId: SOURCE.id, stage: "active" })).toHaveLength(1);
      expect(store.listIncidents({ sourceId: SOURCE.id, stage: "resolved" })).toHaveLength(0);
      expect(store.listIncidents({ since: at(60_000) })).toHaveLength(0);
    });

    it("filters events by kind and time", () => {
      expect(store.listEvents({ kinds: ["incident"] })).toHaveLength(1);
      expect(store.listEvents({ kinds: ["component_added"] })).toHaveLength(1);
      // A never-before-seen component is an addition, not a status change.
      expect(store.listEvents({ kinds: ["component"] })).toHaveLength(0);
      expect(store.listEvents({ kinds: ["component_added", "incident"] })).toHaveLength(2);
      expect(store.listEvents({ since: at(60_000) })).toHaveLength(0);
    });

    it("bounds every query limit explicitly", () => {
      expect(resolveQueryLimit(undefined)).toBe(50);
      expect(resolveQueryLimit(10)).toBe(10);
      expect(resolveQueryLimit(10_000)).toBe(500);
      expect(() => resolveQueryLimit(0)).toThrow(RangeError);
      expect(() => resolveQueryLimit(-1)).toThrow(RangeError);
      expect(() => resolveQueryLimit(1.5)).toThrow(RangeError);
      expect(() => resolveQueryLimit(Number.NaN)).toThrow(RangeError);
      expect(() => resolveQueryLimit(Number.POSITIVE_INFINITY)).toThrow(RangeError);
      expect(() => resolveQueryLimit("20" as never)).toThrow(RangeError);

      expect(() => store.listEvents({ limit: 0 })).toThrow(RangeError);
      expect(() => store.listIncidents({ limit: Number.NaN })).toThrow(RangeError);
      expect(store.listEvents({ limit: 1 })).toHaveLength(1);
    });

    it("prunes events older than the retention window", () => {
      store.recordFailure({
        source: SOURCE,
        error: new Error("later failure"),
        durationMs: 10,
        observedAt: at(HISTORY_RETENTION_MS + 60_000),
      });
      // The four events written at T0 are outside the window and are gone; only
      // the fetch-health transition just recorded survives.
      const events = store.listEvents({ sourceId: SOURCE.id });
      expect(events.map((event) => event.kind)).toEqual(["fetch_health"]);
      expect(events[0]!.occurredAt).toBe(at(HISTORY_RETENTION_MS + 60_000).toISOString());
    });
  });
});
