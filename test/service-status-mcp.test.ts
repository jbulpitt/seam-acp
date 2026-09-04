import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ServiceStatusStore } from "../packages/core/src/core/service-status/store.js";
import { ServiceStatusRefreshManager } from "../packages/core/src/core/service-status/manager.js";
import { createServiceStatusMcpView } from "../packages/core/src/core/service-status/mcp-view.js";
import { createDefaultServiceStatusSources } from "../packages/core/src/core/service-status/sources/registry.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type {
  ServiceStatusAdapterResult,
  ServiceStatusSourceDefinition,
} from "../packages/core/src/core/service-status/types.js";

const tempDirs: string[] = [];
const openStores: ServiceStatusStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-04T12:00:00.000Z");

function tempStore(): ServiceStatusStore {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-status-mcp-"));
  tempDirs.push(dir);
  const store = new ServiceStatusStore(path.join(dir, "service-status.sqlite"));
  openStores.push(store);
  return store;
}

function okResult(
  sourceId: string,
  overrides: Partial<ServiceStatusAdapterResult> = {}
): ServiceStatusAdapterResult {
  return {
    sourceId,
    fetchedAt: NOW.toISOString(),
    baseline: { status: "operational", description: "All Systems Operational", derived: false },
    components: [],
    incidents: [],
    notes: [],
    ...overrides,
  };
}

function source(
  id: string,
  fetchImpl: () => Promise<ServiceStatusAdapterResult>
): ServiceStatusSourceDefinition {
  return {
    id,
    label: id.toUpperCase(),
    provenance: "official",
    homepage: `https://status.${id}.test`,
    scopeNote: `${id} test source`,
    fetch: fetchImpl,
  };
}

function component(id: string, status: "operational" | "degraded" | "major_outage") {
  return {
    id,
    name: id,
    status,
    description: null,
    groupId: null,
    isGroup: false,
    selected: true,
    updatedAt: null,
  };
}

function incident(externalId: string, stage: "active" | "resolved", impact: "degraded" | "major_outage") {
  return {
    externalId,
    title: `incident ${externalId}`,
    stage,
    lifecycle: stage === "active" ? "investigating" : "resolved",
    impact,
    url: `https://status.test/${externalId}`,
    startedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    resolvedAt: stage === "resolved" ? NOW.toISOString() : null,
    componentIds: ["api"],
    updates: [
      { id: "u1", lifecycle: "investigating", body: "looking into it", createdAt: NOW.toISOString(), order: 0 },
      { id: "u2", lifecycle: "identified", body: "root cause found", createdAt: NOW.toISOString(), order: 1 },
      { id: "u3", lifecycle: "monitoring", body: "fix deployed", createdAt: NOW.toISOString(), order: 2 },
    ],
  };
}

/** A view over sources that never touch the network unless a test says so. */
function harness(sources: ServiceStatusSourceDefinition[]) {
  const store = tempStore();
  const clock = { nowMs: NOW.getTime() };
  const now = () => new Date(clock.nowMs);
  const manager = new ServiceStatusRefreshManager({ store, sources, now });
  const view = createServiceStatusMcpView({ store, manager, sources, now });
  /** Move past the manager's forced-refresh cooldown. */
  const advance = (ms: number) => {
    clock.nowMs += ms;
  };
  return { store, manager, view, advance };
}

describe("service-status MCP view — cached reads", () => {
  it("performs no network work and lists every registered source", () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network must not be touched")));
    const { view } = harness([source("alpha", fetchSpy), source("beta", fetchSpy)]);

    const result = view.read();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.cached).toBe(true);
    expect(result.generatedAt).toBe(NOW.toISOString());
    // Registering the sources is what makes an unfetched source visible rather
    // than silently absent.
    expect(result.sources.map((entry) => entry.sourceId)).toEqual(["alpha", "beta"]);
    expect(result.sources[0]!.observation.health).toBe("never_fetched");
    expect(result.sources[0]!.observation.hasProviderData).toBe(false);
    expect(result.sources[0]!.reportedStatus).toBe("unknown");
    expect(result.sources[0]!.url).toBe("https://status.alpha.test");
  });

  it("keeps the provider verdict and Seam's own fetch health as separate axes", async () => {
    let failing = false;
    const { view, manager, advance } = harness([
      source("alpha", () =>
        failing
          ? Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1:443"))
          : Promise.resolve(
              okResult("alpha", {
                baseline: { status: "major_outage", description: "Major Outage", derived: false },
              })
            )
      ),
    ]);

    await manager.refreshSource("alpha", { force: true });
    const healthy = view.read().sources[0]!;
    expect(healthy.reportedStatus).toBe("major_outage");
    expect(healthy.observation.health).toBe("ok");
    expect(healthy.observation.providerStatusIsCurrent).toBe(true);
    expect(healthy.observation.hasProviderData).toBe(true);
    expect(healthy.fetchedAt).toBe(NOW.toISOString());

    // Now polling breaks. The provider's last-known-good verdict is retained,
    // but the observation axis says we can no longer confirm it. Move past the
    // forced-refresh cooldown first, or the second call is rate limited.
    failing = true;
    advance(60_000);
    await manager.refreshSource("alpha", { force: true });
    const stale = view.read().sources[0]!;
    expect(stale.reportedStatus).toBe("major_outage");
    expect(stale.observation.health).toBe("fetch_error");
    expect(stale.observation.providerStatusIsCurrent).toBe(false);
    // Still have provider data — it is simply not current.
    expect(stale.observation.hasProviderData).toBe(true);
    expect(stale.observation.lastError).toContain("ECONNREFUSED");
    expect(stale.observation.consecutiveFailures).toBe(1);
  });

  it("projects components, incidents and history behind explicit flags", async () => {
    const { view, manager } = harness([
      source("alpha", () =>
        Promise.resolve(
          okResult("alpha", {
            components: [
              component("api", "operational"),
              component("git", "major_outage"),
              component("pages", "degraded"),
            ],
            incidents: [incident("INC-1", "active", "major_outage")],
          })
        )
      ),
    ]);
    await manager.refreshSource("alpha", { force: true });

    // Default: summary counts, active incidents, no component or history detail.
    const summary = view.read().sources[0]!;
    expect(summary.components).toBeUndefined();
    expect(summary.history).toBeUndefined();
    expect(summary.componentTotal).toBe(3);
    expect(summary.unhealthyComponentCount).toBe(2);
    expect(summary.activeIncidentCount).toBe(1);
    expect(summary.incidents).toHaveLength(1);
    expect(summary.incidents![0]!.updateCount).toBe(3);
    // Advisories are newest-first and bounded by the default update limit.
    expect(summary.incidents![0]!.updates.map((u) => u.lifecycle)).toEqual([
      "monitoring",
      "identified",
      "investigating",
    ]);

    const detailed = view.read({
      includeComponents: true,
      includeHistory: true,
      componentLimit: 2,
      updateLimit: 1,
    }).sources[0]!;
    // Worst first, so a truncated component list still shows what matters.
    expect(detailed.components!.map((c) => c.id)).toEqual(["git", "pages"]);
    expect(detailed.componentsTruncated).toBe(true);
    expect(detailed.incidents![0]!.updates).toHaveLength(1);
    expect(detailed.incidents![0]!.updates[0]!.lifecycle).toBe("monitoring");
    expect(detailed.history!.length).toBeGreaterThan(0);
    expect(detailed.history!.every((event) => typeof event.occurredAt === "string")).toBe(true);
  });

  it("returns only active incidents unless resolved ones are asked for", async () => {
    const { view, manager } = harness([
      source("alpha", () =>
        Promise.resolve(
          okResult("alpha", {
            incidents: [incident("INC-1", "active", "degraded"), incident("INC-2", "resolved", "major_outage")],
          })
        )
      ),
    ]);
    await manager.refreshSource("alpha", { force: true });

    expect(view.read().sources[0]!.incidents!.map((i) => i.externalId)).toEqual(["INC-1"]);
    const withResolved = view.read({ includeResolvedIncidents: true }).sources[0]!;
    expect(withResolved.incidents!.map((i) => i.externalId).sort()).toEqual(["INC-1", "INC-2"]);
    // Active first, so truncation never hides a live incident.
    expect(withResolved.incidents![0]!.stage).toBe("active");
  });

  it("can be narrowed to selected source ids", async () => {
    const { view, manager } = harness([
      source("alpha", () => Promise.resolve(okResult("alpha"))),
      source("beta", () => Promise.resolve(okResult("beta"))),
    ]);
    await manager.refresh({ force: true });

    expect(view.read({ sourceIds: ["beta"] }).sources.map((s) => s.sourceId)).toEqual(["beta"]);
    // An empty array is "unset", not "none" — never silently zero sources.
    expect(view.read({ sourceIds: [] }).sources).toHaveLength(2);
  });
});

describe("service-status MCP view — validation", () => {
  it("rejects unknown source ids and names the registered ones", () => {
    const { view } = harness([source("alpha", () => Promise.resolve(okResult("alpha")))]);
    expect(() => view.read({ sourceIds: ["nope"] })).toThrow(
      /unknown service status source id\(s\): "nope"\. Registered ids: alpha/
    );
    // The same gate guards the refresh path, before any network work.
    return expect(view.refresh({ sourceIds: ["alpha", "nope"] })).rejects.toThrow(
      /unknown service status source/
    );
  });

  it("bounds every list limit explicitly", () => {
    const { view } = harness([source("alpha", () => Promise.resolve(okResult("alpha")))]);
    expect(() => view.read({ componentLimit: 0 })).toThrow(/components limit/);
    expect(() => view.read({ incidentLimit: -1 })).toThrow(/incidents limit/);
    expect(() => view.read({ updateLimit: 1.5 })).toThrow(/updates limit/);
    expect(() => view.read({ historyLimit: Number.NaN })).toThrow(/history limit/);
    // Excessive values clamp rather than erroring.
    expect(() => view.read({ componentLimit: 10_000 })).not.toThrow();
  });

  it("exposes only the static registry — no URL or credential can be passed", () => {
    const sources = createDefaultServiceStatusSources();
    const store = tempStore();
    const manager = new ServiceStatusRefreshManager({ store, sources, now: () => NOW });
    const view = createServiceStatusMcpView({ store, manager, sources, now: () => NOW });

    expect(view.registeredSourceIds()).toEqual([
      "anthropic",
      "github",
      "google-ai-studio",
      "google-cloud",
      "linkworks-ollama",
      "openai",
      "xai",
    ]);
    // A URL-shaped id is just an unknown id; there is no field that accepts one.
    expect(() => view.read({ sourceIds: ["https://evil.test/steal"] })).toThrow(
      /unknown service status source/
    );
    manager.stop();
  });
});

describe("service-status MCP view — bounded refresh", () => {
  it("awaits fresh upstream attempts rather than returning the cached snapshot", async () => {
    let calls = 0;
    const { view } = harness([
      source("alpha", () => {
        calls += 1;
        return Promise.resolve(
          okResult("alpha", {
            baseline: { status: "degraded", description: "Minor", derived: false },
          })
        );
      }),
    ]);

    const before = view.read().sources[0]!;
    expect(before.observation.health).toBe("never_fetched");
    expect(calls).toBe(0);

    const refreshed = await view.refresh();
    expect(calls).toBe(1);
    expect(refreshed.outcome).toBe("succeeded");
    const entry = refreshed.sources[0]!;
    expect(entry.disposition).toBe("executed");
    expect(entry.attempted).toBe(true);
    expect(entry.succeeded).toBe(true);
    expect(entry.reportedStatus).toBe("degraded");
    expect(entry.fetchedAt).toBe(NOW.toISOString());
    expect(entry.observation!.health).toBe("ok");
    expect(entry.label).toBe("ALPHA");
  });

  it("shares one in-flight attempt between parallel callers", async () => {
    let calls = 0;
    let release!: (value: ServiceStatusAdapterResult) => void;
    const pending = new Promise<ServiceStatusAdapterResult>((resolve) => {
      release = resolve;
    });
    const { view } = harness([
      source("alpha", () => {
        calls += 1;
        return pending;
      }),
    ]);

    const first = view.refresh();
    const second = view.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);

    release(okResult("alpha"));
    const [a, b] = await Promise.all([first, second]);

    // One upstream fetch; both callers get the outcome, and the second says
    // plainly that it did not cause the fetch.
    expect(calls).toBe(1);
    const dispositions = [a.sources[0]!.disposition, b.sources[0]!.disposition].sort();
    expect(dispositions).toEqual(["coalesced", "executed"]);
    expect(a.sources[0]!.succeeded).toBe(true);
    expect(b.sources[0]!.succeeded).toBe(true);
    const attempted = [a.sources[0]!.attempted, b.sources[0]!.attempted].sort();
    expect(attempted).toEqual([false, true]);
  });

  it("reports a repeat call as rate limited instead of re-fetching", async () => {
    let calls = 0;
    const { view } = harness([
      source("alpha", () => {
        calls += 1;
        return Promise.resolve(okResult("alpha"));
      }),
    ]);

    await view.refresh();
    expect(calls).toBe(1);

    const again = await view.refresh();
    expect(calls).toBe(1);
    const entry = again.sources[0]!;
    expect(entry.disposition).toBe("rate_limited");
    expect(entry.attempted).toBe(false);
    expect(entry.succeeded).toBeNull();
    expect(entry.reason).toMatch(/cooldown/);
    // A cooldown is not a failure.
    expect(again.outcome).toBe("skipped");
    // The cached snapshot still comes back with it.
    expect(entry.reportedStatus).toBe("operational");
  });

  it("returns successful sources and per-source errors together", async () => {
    const { view } = harness([
      source("alpha", () => Promise.resolve(okResult("alpha"))),
      source("beta", () => Promise.reject(new Error("upstream exploded"))),
      source("gamma", () => Promise.resolve(okResult("gamma"))),
    ]);

    const result = await view.refresh();
    expect(result.outcome).toBe("mixed");
    const byId = new Map(result.sources.map((entry) => [entry.sourceId, entry]));
    expect(byId.get("alpha")!.succeeded).toBe(true);
    expect(byId.get("gamma")!.succeeded).toBe(true);
    const failed = byId.get("beta")!;
    expect(failed.succeeded).toBe(false);
    expect(failed.error).toContain("upstream exploded");
    expect(failed.observation!.health).toBe("fetch_error");
    // One failing provider does not fail the call or the other sources.
    expect(result.sources).toHaveLength(3);
  });

  it("refreshes only the requested subset", async () => {
    const calls: string[] = [];
    const { view } = harness([
      source("alpha", () => {
        calls.push("alpha");
        return Promise.resolve(okResult("alpha"));
      }),
      source("beta", () => {
        calls.push("beta");
        return Promise.resolve(okResult("beta"));
      }),
    ]);

    const result = await view.refresh({ sourceIds: ["beta"] });
    expect(calls).toEqual(["beta"]);
    expect(result.sources.map((entry) => entry.sourceId)).toEqual(["beta"]);
  });
});

describe("service-status MCP tools", () => {
  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as never;

  async function withServer(
    deps: Record<string, unknown>,
    run: (call: (name: string, args?: unknown) => Promise<any>) => Promise<void>
  ): Promise<void> {
    const server = new SeamMcpServer({
      logger,
      resolveSession: (token) => (token === "ok" ? ({} as SessionRecord) : undefined),
      enqueueDispatch: async () => undefined,
      ...deps,
    } as never);
    await server.start();
    try {
      let id = 0;
      const call = async (method: string, params?: unknown) => {
        id += 1;
        const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-seam-session": "ok" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        return (await response.json()) as any;
      };
      await run(call);
    } finally {
      await server.stop();
    }
  }

  it("advertises both tools with bounded, credential-free schemas", async () => {
    await withServer(
      { readServiceStatus: () => ({ generatedAt: "", cached: true, sources: [] }) },
      async (call) => {
        const body = await call("tools/list");
        const tools = body.result.tools as { name: string; inputSchema: any; description: string }[];
        const read = tools.find((tool) => tool.name === "service_status");
        const refresh = tools.find((tool) => tool.name === "service_status_refresh");
        expect(read).toBeDefined();
        expect(refresh).toBeDefined();

        // No argument may carry a URL, header or credential.
        const readProps = Object.keys(read!.inputSchema.properties).sort();
        expect(readProps).toEqual([
          "componentLimit",
          "historyLimit",
          "incidentLimit",
          "includeAllComponents",
          "includeComponents",
          "includeHistory",
          "includeIncidents",
          "includeResolvedIncidents",
          "sourceIds",
          "updateLimit",
        ]);
        expect(Object.keys(refresh!.inputSchema.properties)).toEqual(["sourceIds"]);
        for (const tool of [read!, refresh!]) {
          expect(tool.inputSchema.required).toEqual([]);
          for (const [key, schema] of Object.entries<any>(tool.inputSchema.properties)) {
            // No argument NAME may suggest a network or credential surface…
            expect(key).not.toMatch(/url|uri|header|token|credential|auth|secret|key/i);
            // …and every argument is a plain id list, flag or bounded number.
            expect(["array", "boolean", "number"]).toContain(schema.type);
            if (schema.type === "array") expect(schema.items.type).toBe("string");
          }
        }
        // Every numeric limit is capped in the schema itself.
        for (const key of ["componentLimit", "incidentLimit", "updateLimit", "historyLimit"]) {
          expect(read!.inputSchema.properties[key].maximum).toBeGreaterThan(0);
        }
      }
    );
  });

  it("returns structured cached status and mirrors it as text", async () => {
    const { view, manager } = harness([
      source("alpha", () =>
        Promise.resolve(
          okResult("alpha", {
            baseline: { status: "degraded", description: "Minor", derived: false },
          })
        )
      ),
    ]);
    await manager.refreshSource("alpha", { force: true });

    await withServer(
      { readServiceStatus: (options: never) => view.read(options) },
      async (call) => {
        const body = await call("tools/call", {
          name: "service_status",
          arguments: { sourceIds: ["alpha"], includeComponents: true },
        });
        expect(body.result.isError).toBeUndefined();
        expect(body.result.structuredContent.cached).toBe(true);
        expect(body.result.structuredContent.sources[0].reportedStatus).toBe("degraded");
        expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
      }
    );
  });

  it("surfaces a validation error as a failed tool result, not a protocol error", async () => {
    const { view } = harness([source("alpha", () => Promise.resolve(okResult("alpha")))]);
    await withServer(
      { readServiceStatus: (options: never) => view.read(options) },
      async (call) => {
        const body = await call("tools/call", {
          name: "service_status",
          arguments: { sourceIds: ["nope"] },
        });
        expect(body.error).toBeUndefined();
        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toMatch(/unknown service status source id\(s\): "nope"/);
        expect(body.result.content[0].text).toMatch(/Registered ids: alpha/);
      }
    );
  });

  it("rejects a malformed argument type before reaching the view", async () => {
    const read = vi.fn();
    await withServer({ readServiceStatus: read }, async (call) => {
      const body = await call("tools/call", {
        name: "service_status",
        arguments: { sourceIds: "alpha" },
      });
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toMatch(/"sourceIds" must be an array of strings/);
      expect(read).not.toHaveBeenCalled();
    });
  });

  it("awaits the live refresh through the tool and reports partial failure", async () => {
    const { view } = harness([
      source("alpha", () => Promise.resolve(okResult("alpha"))),
      source("beta", () => Promise.reject(new Error("provider down"))),
    ]);
    await withServer(
      { refreshServiceStatus: (options: never) => view.refresh(options) },
      async (call) => {
        const body = await call("tools/call", {
          name: "service_status_refresh",
          arguments: {},
        });
        const result = body.result.structuredContent;
        expect(result.outcome).toBe("mixed");
        const byId = new Map(result.sources.map((entry: any) => [entry.sourceId, entry]));
        expect((byId.get("alpha") as any).succeeded).toBe(true);
        expect((byId.get("beta") as any).error).toContain("provider down");
      }
    );
  });

  it("reports both tools as unsupported when the subsystem is disabled", async () => {
    await withServer({}, async (call) => {
      for (const name of ["service_status", "service_status_refresh"]) {
        const body = await call("tools/call", { name, arguments: {} });
        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toMatch(/not enabled on this deployment/);
      }
    });
  });
});
