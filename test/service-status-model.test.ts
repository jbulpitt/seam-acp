import { describe, expect, it } from "vitest";

import {
  computeEffectiveStatus,
  statusRank,
  worstStatus,
  isServiceStatusLevel,
} from "../packages/core/src/core/service-status/severity.js";
import {
  fetchBoundedText,
  sanitizeErrorMessage,
  REDACTED,
} from "../packages/core/src/core/service-status/http.js";
import { validateAdapterResult } from "../packages/core/src/core/service-status/validate.js";
import { stableHash } from "../packages/core/src/core/service-status/sources/shared.js";
import {
  diffSnapshots,
  incidentSignature,
} from "../packages/core/src/core/service-status/events.js";
import {
  SERVICE_STATUS_LEVELS,
  type NormalizedIncidentUpdate,
  type ServiceStatusAdapterResult,
  type ServiceStatusComponent,
  type ServiceStatusIncident,
  type ServiceStatusLevel,
  type ServiceStatusSnapshot,
} from "../packages/core/src/core/service-status/types.js";

const NOW = "2026-09-03T12:00:00.000Z";

function result(overrides: Partial<ServiceStatusAdapterResult> = {}): ServiceStatusAdapterResult {
  return {
    sourceId: "github",
    fetchedAt: NOW,
    baseline: { status: "operational", description: null, derived: false },
    components: [],
    incidents: [],
    notes: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<ServiceStatusSnapshot> = {}): ServiceStatusSnapshot {
  return {
    sourceId: "github",
    label: "GitHub",
    provenance: "official",
    baseline: { status: "operational", description: null, derived: false },
    effectiveStatus: "operational",
    reportedAt: NOW,
    observation: {
      health: "ok",
      lastAttemptAt: NOW,
      lastSuccessAt: NOW,
      lastErrorAt: null,
      lastError: null,
      consecutiveFailures: 0,
      lastDurationMs: 10,
    },
    components: [],
    incidents: [],
    notes: [],
    ...overrides,
  };
}

describe("severity model", () => {
  it("ranks levels from healthy to worst, with `unknown` above `degraded`", () => {
    expect([...SERVICE_STATUS_LEVELS]).toEqual([
      "operational",
      "maintenance",
      "degraded",
      "unknown",
      "partial_outage",
      "major_outage",
    ]);
    // An ungraded provider report must not read as milder than a graded
    // degradation, nor worse than a declared partial outage.
    expect(statusRank("unknown")).toBeGreaterThan(statusRank("degraded"));
    expect(statusRank("unknown")).toBeLessThan(statusRank("partial_outage"));
    expect(isServiceStatusLevel("major_outage")).toBe(true);
    expect(isServiceStatusLevel("catastrophic")).toBe(false);
    expect(() => statusRank("catastrophic" as ServiceStatusLevel)).toThrow(/unknown service status level/);
  });

  it("treats an empty input as operational and otherwise takes the maximum", () => {
    expect(worstStatus([])).toBe("operational");
    expect(worstStatus(["operational", "maintenance"])).toBe("maintenance");
    expect(worstStatus(["major_outage", "operational"])).toBe("major_outage");
  });

  it("computes effective status from three independent inputs", () => {
    const baseline = { status: "operational" as const, description: null, derived: false };

    expect(
      computeEffectiveStatus({ baseline, components: [], activeIncidents: [] })
    ).toBe("operational");

    // Baseline alone can carry an outage.
    expect(
      computeEffectiveStatus({
        baseline: { status: "major_outage", description: null, derived: false },
        components: [{ status: "operational", selected: true }],
        activeIncidents: [],
      })
    ).toBe("major_outage");

    // A component alone can carry an outage.
    expect(
      computeEffectiveStatus({
        baseline,
        components: [{ status: "partial_outage", selected: true }],
        activeIncidents: [],
      })
    ).toBe("partial_outage");

    // An active incident alone can carry an outage.
    expect(
      computeEffectiveStatus({ baseline, components: [], activeIncidents: [{ impact: "degraded" }] })
    ).toBe("degraded");

    // Unselected components are excluded.
    expect(
      computeEffectiveStatus({
        baseline,
        components: [{ status: "major_outage", selected: false }],
        activeIncidents: [],
      })
    ).toBe("operational");
  });

  it("stays reconstructible when one incident is filtered out", () => {
    const baseline = { status: "degraded" as const, description: null, derived: false };
    const components = [{ status: "partial_outage" as const, selected: true }];
    const incidents = [{ impact: "major_outage" as const }, { impact: "degraded" as const }];

    expect(computeEffectiveStatus({ baseline, components, activeIncidents: incidents })).toBe(
      "major_outage"
    );
    // Dropping the worst incident removes exactly its contribution — the page
    // and component verdicts survive untouched.
    expect(computeEffectiveStatus({ baseline, components, activeIncidents: incidents.slice(1) })).toBe(
      "partial_outage"
    );
    expect(computeEffectiveStatus({ baseline, components: [], activeIncidents: [] })).toBe("degraded");
  });
});

describe("adapter result validation", () => {
  it("accepts a well-formed result", () => {
    expect(() =>
      validateAdapterResult(
        result({
          components: [
            {
              id: "api",
              name: "API",
              status: "operational",
              description: null,
              groupId: null,
              isGroup: false,
              selected: true,
              updatedAt: NOW,
            },
          ],
          incidents: [
            {
              externalId: "INC-1",
              title: "outage",
              stage: "resolved",
              lifecycle: "resolved",
              impact: "degraded",
              url: null,
              startedAt: NOW,
              updatedAt: NOW,
              resolvedAt: NOW,
              componentIds: ["api"],
              updates: [
                { id: "u1", lifecycle: "investigating", body: "", createdAt: NOW, order: 0 },
                { id: "u2", lifecycle: "resolved", body: "", createdAt: NOW, order: 1 },
              ],
            },
          ],
          notes: ["a note"],
        })
      )
    ).not.toThrow();
  });

  const cases: [string, () => ServiceStatusAdapterResult, RegExp][] = [
    ["a missing source id", () => result({ sourceId: "" }), /sourceId/],
    ["an unparseable fetchedAt", () => result({ fetchedAt: "not a date" }), /fetchedAt/],
    [
      "an unknown baseline level",
      () => result({ baseline: { status: "sideways" as ServiceStatusLevel, description: null, derived: false } }),
      /baseline\.status/,
    ],
    [
      "a duplicate component id",
      () =>
        result({
          components: [
            { id: "api", name: "a", status: "operational", description: null, groupId: null, isGroup: false, selected: true, updatedAt: null },
            { id: "api", name: "b", status: "operational", description: null, groupId: null, isGroup: false, selected: true, updatedAt: null },
          ],
        }),
      /duplicate component id/,
    ],
    [
      "an unknown component status",
      () =>
        result({
          components: [
            { id: "api", name: "a", status: "sideways" as ServiceStatusLevel, description: null, groupId: null, isGroup: false, selected: true, updatedAt: null },
          ],
        }),
      /unknown status/,
    ],
    [
      "a duplicate incident id",
      () =>
        result({
          incidents: [
            { externalId: "INC-1", title: "a", stage: "active", lifecycle: "x", impact: "degraded", url: null, startedAt: NOW, updatedAt: NOW, resolvedAt: null, componentIds: [], updates: [] },
            { externalId: "INC-1", title: "b", stage: "active", lifecycle: "x", impact: "degraded", url: null, startedAt: NOW, updatedAt: NOW, resolvedAt: null, componentIds: [], updates: [] },
          ],
        }),
      /duplicate incident externalId/,
    ],
    [
      "an active incident that carries a resolution time",
      () =>
        result({
          incidents: [
            { externalId: "INC-1", title: "a", stage: "active", lifecycle: "x", impact: "degraded", url: null, startedAt: NOW, updatedAt: NOW, resolvedAt: NOW, componentIds: [], updates: [] },
          ],
        }),
      /active but carries a resolvedAt/,
    ],
    [
      "an unknown incident stage",
      () =>
        result({
          incidents: [
            { externalId: "INC-1", title: "a", stage: "zombie" as never, lifecycle: "x", impact: "degraded", url: null, startedAt: NOW, updatedAt: NOW, resolvedAt: null, componentIds: [], updates: [] },
          ],
        }),
      /unknown stage/,
    ],
    [
      "duplicate update ids inside one incident",
      () =>
        result({
          incidents: [
            {
              externalId: "INC-1", title: "a", stage: "active", lifecycle: "x", impact: "degraded", url: null,
              startedAt: NOW, updatedAt: NOW, resolvedAt: null, componentIds: [],
              updates: [
                { id: "u1", lifecycle: "x", body: "", createdAt: NOW, order: 0 },
                { id: "u1", lifecycle: "x", body: "", createdAt: NOW, order: 1 },
              ],
            },
          ],
        }),
      /duplicate update id/,
    ],
    [
      "updates that are not in ascending order",
      () =>
        result({
          incidents: [
            {
              externalId: "INC-1", title: "a", stage: "active", lifecycle: "x", impact: "degraded", url: null,
              startedAt: NOW, updatedAt: NOW, resolvedAt: null, componentIds: [],
              updates: [
                { id: "u1", lifecycle: "x", body: "", createdAt: NOW, order: 3 },
                { id: "u2", lifecycle: "x", body: "", createdAt: NOW, order: 1 },
              ],
            },
          ],
        }),
      /not in ascending order/,
    ],
    [
      "a non-string component id nested inside an incident",
      () =>
        result({
          incidents: [
            { externalId: "INC-1", title: "a", stage: "active", lifecycle: "x", impact: "degraded", url: null, startedAt: NOW, updatedAt: NOW, resolvedAt: null, componentIds: [42 as never], updates: [] },
          ],
        }),
      /componentIds entry/,
    ],
  ];

  for (const [name, build, pattern] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => validateAdapterResult(build())).toThrow(pattern);
    });
  }
});

describe("bounded reads", () => {
  const label = "Test feed";

  function respond(body: string, headers: Record<string, string>, status = 200): typeof fetch {
    return (async () => new Response(body, { status, headers })) as unknown as typeof fetch;
  }

  it("reads a well-formed response", async () => {
    const response = await fetchBoundedText({
      label,
      url: "https://example.test/x.json",
      expectContentType: /application\/json/,
      fetchImpl: respond('{"ok":true}', { "content-type": "application/json" }),
    });
    expect(response.text).toBe('{"ok":true}');
    expect(response.status).toBe(200);
    expect(response.bytes).toBe(11);
  });

  it("rejects a non-2xx status without echoing the body", async () => {
    await expect(
      fetchBoundedText({
        label,
        url: "https://example.test/x.json",
        expectContentType: /application\/json/,
        fetchImpl: respond("internal stack trace", { "content-type": "application/json" }, 500),
      })
    ).rejects.toThrow(/^Test feed: HTTP 500$/);
  });

  it("rejects an unexpected content type", async () => {
    await expect(
      fetchBoundedText({
        label,
        url: "https://example.test/x.json",
        expectContentType: /application\/json/,
        fetchImpl: respond("<html></html>", { "content-type": "text/html" }),
      })
    ).rejects.toThrow(/unexpected content-type "text\/html"/);
  });

  it("rejects an oversized response declared by content-length", async () => {
    await expect(
      fetchBoundedText({
        label,
        url: "https://example.test/x.json",
        expectContentType: /application\/json/,
        maxBytes: 10,
        fetchImpl: respond("{}", { "content-type": "application/json", "content-length": "9999" }),
      })
    ).rejects.toThrow(/response too large \(9999 > 10 bytes\)/);
  });

  it("rejects an oversized response while streaming, even without content-length", async () => {
    const big = "x".repeat(4096);
    const streaming = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(big));
            controller.enqueue(new TextEncoder().encode(big));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    await expect(
      fetchBoundedText({
        label,
        url: "https://example.test/x.json",
        expectContentType: /application\/json/,
        maxBytes: 5_000,
        fetchImpl: streaming,
      })
    ).rejects.toThrow(/exceeded 5000 bytes/);
  });

  it("times a hanging request out", async () => {
    const hanging = (async (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;

    await expect(
      fetchBoundedText({
        label,
        url: "https://example.test/x.json",
        expectContentType: /application\/json/,
        timeoutMs: 20,
        fetchImpl: hanging,
      })
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it("honours a caller-supplied abort signal", async () => {
    const controller = new AbortController();
    const hanging = (async (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted by caller"));
        });
      })) as unknown as typeof fetch;

    const pending = fetchBoundedText({
      label,
      url: "https://example.test/x.json",
      expectContentType: /application\/json/,
      timeoutMs: 5_000,
      signal: controller.signal,
      fetchImpl: hanging,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/request failed/);
  });
});

describe("error sanitization", () => {
  it("redacts credentials and bounds the message", () => {
    expect(sanitizeErrorMessage("failed with key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toBe(
      `failed with key ${REDACTED}`
    );
    expect(sanitizeErrorMessage("Authorization: Bearer abcdef0123456789")).toContain(REDACTED);
    expect(sanitizeErrorMessage("GET https://x.test/a?key=supersecretvalue&b=1")).toBe(
      `GET https://x.test/a?key=${REDACTED}&b=1`
    );
    expect(sanitizeErrorMessage("x".repeat(500))).toHaveLength(300);
    expect(sanitizeErrorMessage("multi\n  line   message")).toBe("multi line message");
  });
});

function update(
  id: string,
  body: string,
  createdAt = "2026-09-03T12:00:00.000Z"
): NormalizedIncidentUpdate {
  return { id, lifecycle: "investigating", body, createdAt, order: 0 };
}

function storedIncident(overrides: Partial<ServiceStatusIncident> = {}): ServiceStatusIncident {
  return {
    sourceId: "github",
    externalId: "INC-1",
    title: "outage",
    stage: "active",
    lifecycle: "investigating",
    resolutionSource: "none",
    impact: "degraded",
    url: "https://stspg.io/x",
    startedAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
    componentIds: [],
    updates: [],
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function storedComponent(
  id: string,
  status: ServiceStatusLevel,
  position = 0
): ServiceStatusComponent {
  return {
    id,
    name: id,
    status,
    description: null,
    groupId: null,
    isGroup: false,
    selected: true,
    position,
    updatedAt: null,
  };
}

describe("event diffing", () => {
  it("emits the initial state of a source it has never seen", () => {
    const events = diffSnapshots(null, snapshot({ effectiveStatus: "degraded" }), NOW);
    expect(events.map((event) => event.kind).sort()).toEqual(["baseline", "fetch_health", "source"]);
    expect(events.find((event) => event.kind === "source")!.previous).toBeNull();
  });

  it("records every component of a first-ever inventory, healthy or not", () => {
    const next = snapshot({
      components: [
        storedComponent("api", "operational", 0),
        storedComponent("git", "major_outage", 1),
      ],
    });
    const events = diffSnapshots(null, next, NOW).filter((event) =>
      event.kind.startsWith("component")
    );
    expect(events.map((event) => [event.kind, event.subjectId, event.current])).toEqual([
      ["component_added", "api", "operational"],
      ["component_added", "git", "major_outage"],
    ]);
  });

  it("records a component leaving the inventory", () => {
    const before = snapshot({
      components: [storedComponent("api", "operational", 0), storedComponent("git", "degraded", 1)],
    });
    const after = snapshot({ components: [storedComponent("api", "operational", 0)] });
    const events = diffSnapshots(before, after, NOW);
    expect(events.map((event) => [event.kind, event.subjectId, event.previous, event.current])).toEqual([
      ["component_removed", "git", "degraded", "removed"],
    ]);

    // …and going to an empty inventory removes them all, deterministically.
    const emptied = diffSnapshots(before, snapshot({ components: [] }), NOW);
    expect(emptied.map((event) => [event.kind, event.subjectId])).toEqual([
      ["component_removed", "api"],
      ["component_removed", "git"],
    ]);
  });

  it("orders additions before status changes before removals", () => {
    const before = snapshot({
      components: [storedComponent("api", "operational", 0), storedComponent("gone", "degraded", 1)],
    });
    const after = snapshot({
      components: [storedComponent("api", "major_outage", 0), storedComponent("new", "operational", 1)],
    });
    const events = diffSnapshots(before, after, NOW).filter((event) =>
      event.kind.startsWith("component")
    );
    expect(events.map((event) => event.kind)).toEqual([
      "component_added",
      "component",
      "component_removed",
    ]);
  });

  it("emits nothing for two identical snapshots", () => {
    expect(diffSnapshots(snapshot(), snapshot(), NOW)).toEqual([]);
  });

  it("separates the provider axis from the observation axis", () => {
    const before = snapshot();
    const after = snapshot({
      observation: { ...before.observation, health: "fetch_error", lastError: "boom" },
    });
    const events = diffSnapshots(before, after, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("fetch_health");
    expect(events[0]!.previous).toBe("ok");
    expect(events[0]!.detail).toBe("boom");
  });

  it("records an incident impact change without a stage change", () => {
    const incident = {
      sourceId: "github",
      externalId: "INC-1",
      title: "outage",
      stage: "active" as const,
      lifecycle: "investigating",
      resolutionSource: "none" as const,
      impact: "degraded" as ServiceStatusLevel,
      url: "https://stspg.io/x",
      startedAt: NOW,
      updatedAt: NOW,
      resolvedAt: null,
      componentIds: [],
      updates: [],
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    };
    const before = snapshot({ incidents: [incident] });
    const after = snapshot({ incidents: [{ ...incident, impact: "major_outage" }] });
    const events = diffSnapshots(before, after, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("incident");
    expect(events[0]!.previous).toBe(incidentSignature(incident));
    expect(events[0]!.current).toBe(incidentSignature({ ...incident, impact: "major_outage" }));
    expect(events[0]!.current).toBe("active/major_outage/investigating/c0-empty/u0-empty");
    expect(events[0]!.detail).toBe("impact degraded → major_outage");
  });

  it("records a lifecycle step that leaves severity unchanged", () => {
    const incident = storedIncident();
    const before = snapshot({ incidents: [incident] });
    const after = snapshot({
      incidents: [{ ...incident, lifecycle: "identified" }],
    });
    const events = diffSnapshots(before, after, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("incident");
    expect(events[0]!.detail).toBe("lifecycle investigating → identified");
  });

  it("records a newly added advisory even when nothing else moved", () => {
    const incident = storedIncident();
    const before = snapshot({ incidents: [incident] });
    const after = snapshot({
      incidents: [{ ...incident, updates: [update("u1", "we are looking into it")] }],
    });
    const events = diffSnapshots(before, after, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toBe("1 new update");

    // A second poll with the same advisory is not a transition.
    expect(diffSnapshots(after, after, NOW)).toEqual([]);
  });

  it("ignores advisory reordering and whitespace-only rewording", () => {
    const first = update("u1", "we are   looking\n  into it");
    const second = update("u2", "mitigation under way", "2026-09-03T12:05:00.000Z");
    const before = snapshot({ incidents: [{ ...storedIncident(), updates: [first, second] }] });

    const reordered = snapshot({
      incidents: [
        {
          ...storedIncident(),
          // Same advisories, opposite order, and one of them reflowed.
          updates: [
            { ...second, order: 0 },
            { ...first, body: "we are looking into it", order: 1 },
          ],
        },
      ],
    });
    expect(diffSnapshots(before, reordered, NOW)).toEqual([]);
  });

  it("treats the incident's component scope as material", () => {
    const narrow = storedIncident({ componentIds: ["api"] });
    const wide = storedIncident({ componentIds: ["api", "git", "actions"] });

    const widened = diffSnapshots(
      snapshot({ incidents: [narrow] }),
      snapshot({ incidents: [wide] }),
      NOW
    );
    expect(widened).toHaveLength(1);
    expect(widened[0]!.kind).toBe("incident");
    expect(widened[0]!.detail).toBe("components 1 → 3");

    const narrowed = diffSnapshots(
      snapshot({ incidents: [wide] }),
      snapshot({ incidents: [narrow] }),
      NOW
    );
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]!.detail).toBe("components 3 → 1");

    // Order is not material — the same scope listed differently is no change.
    const reordered = storedIncident({ componentIds: ["actions", "api", "git"] });
    expect(
      diffSnapshots(snapshot({ incidents: [wide] }), snapshot({ incidents: [reordered] }), NOW)
    ).toEqual([]);
  });

  it("cannot be fooled by a separator character inside a field", () => {
    // Built with fromCharCode so the control character exists at runtime
    // without a literal control byte in this file.
    const sep = String.fromCharCode(1);

    // Under a U+0001-delimited join these two incidents encode to identical
    // bytes. They are different incidents and must not share a signature.
    const left = storedIncident({
      updates: [{ ...update("u1", "z"), lifecycle: `x${sep}y` }],
    });
    const right = storedIncident({
      updates: [{ ...update("u1", `y${sep}z`), lifecycle: "x" }],
    });
    expect(incidentSignature(left)).not.toBe(incidentSignature(right));
    expect(
      diffSnapshots(snapshot({ incidents: [left] }), snapshot({ incidents: [right] }), NOW)
    ).toHaveLength(1);

    // The same trap across the component scope, and across advisory boundaries.
    expect(incidentSignature(storedIncident({ componentIds: [`a${sep}b`, "c"] }))).not.toBe(
      incidentSignature(storedIncident({ componentIds: ["a", `b${sep}c`] }))
    );
    expect(
      incidentSignature(
        storedIncident({ updates: [update("u1", "a"), { ...update("u2", "b"), order: 1 }] })
      )
    ).not.toBe(incidentSignature(storedIncident({ updates: [update("u1", "au2b")] })));
  });

  it("stableHash is unambiguous across part boundaries", () => {
    const nul = String.fromCharCode(0);
    // A NUL-joined hash collides on this pair; a JSON-encoded one does not.
    expect(stableHash(`a${nul}b`, "c")).not.toBe(stableHash("a", `b${nul}c`));
    expect(stableHash("ab", "c")).not.toBe(stableHash("a", "bc"));
    // …while identical inputs still hash identically.
    expect(stableHash("a", "b")).toBe(stableHash("a", "b"));
  });

  it("records a revised advisory that keeps the update count", () => {
    const before = snapshot({
      incidents: [{ ...storedIncident(), updates: [update("u1", "original text")] }],
    });
    const after = snapshot({
      incidents: [{ ...storedIncident(), updates: [update("u1", "materially different text")] }],
    });
    const events = diffSnapshots(before, after, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toBe("updates revised");
  });
});
