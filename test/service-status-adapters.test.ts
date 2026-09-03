import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  normalizeStatuspage,
  createStatuspageAdapter,
} from "../packages/core/src/core/service-status/sources/statuspage.js";
import {
  normalizeXaiFeed,
  createXaiAdapter,
} from "../packages/core/src/core/service-status/sources/xai.js";
import { normalizeGoogleCloud } from "../packages/core/src/core/service-status/sources/google-cloud.js";
import {
  createGoogleAiStudioAdapter,
  discoverBootstrapCandidates,
  normalizeAlkaliHistory,
} from "../packages/core/src/core/service-status/sources/google-ai-studio.js";
import { normalizeLinkworksDashboard } from "../packages/core/src/core/service-status/sources/linkworks.js";
import {
  createDefaultServiceStatusSources,
  ANTHROPIC_COMPONENT_IDS,
  GITHUB_COMPONENT_IDS,
  OPENAI_COMPONENT_IDS,
} from "../packages/core/src/core/service-status/sources/registry.js";
import { validateAdapterResult } from "../packages/core/src/core/service-status/validate.js";
import { computeEffectiveStatus } from "../packages/core/src/core/service-status/severity.js";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "service-status"
);

/** Every fixture the suite reads, so an unreferenced file is easy to spot. */
const READ_FIXTURES = new Set<string>();

function fixture(relativePath: string): string {
  READ_FIXTURES.add(relativePath);
  return readFileSync(path.join(FIXTURES, relativePath), "utf8");
}

const NOW = new Date("2026-09-03T18:30:00.000Z");

function statuspageConfig(overrides: Partial<Parameters<typeof normalizeStatuspage>[0]> = {}) {
  return {
    sourceId: "test",
    label: "Test",
    summaryUrl: "https://example.test/summary.json",
    incidentsUrl: "https://example.test/incidents.json",
    selectedComponentIds: [] as string[],
    ...overrides,
  };
}

/** A `fetch` stub that answers a fixed URL map with well-formed responses. */
function stubFetch(routes: Record<string, { body: string; contentType: string; status?: number }>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { "content-type": route.contentType },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("statuspage adapter", () => {
  it("normalizes the recorded GitHub page and its incident history", () => {
    const result = normalizeStatuspage(
      statuspageConfig({
        sourceId: "github",
        label: "GitHub",
        selectedComponentIds: [
          GITHUB_COMPONENT_IDS.apiRequests,
          GITHUB_COMPONENT_IDS.copilot,
          GITHUB_COMPONENT_IDS.copilotAiModelProviders,
        ],
      }),
      {
        summary: fixture("statuspage/github-summary.json"),
        incidents: fixture("statuspage/github-incidents.json"),
      },
      NOW
    );

    validateAdapterResult(result);
    expect(result.baseline).toEqual({
      status: "operational",
      description: "All Systems Operational",
      derived: false,
    });
    expect(result.components).toHaveLength(12);
    expect(result.components.filter((component) => component.selected).map((c) => c.name)).toEqual([
      "API Requests",
      "Copilot",
      "Copilot AI Model Providers",
    ]);

    const incident = result.incidents.find((entry) => entry.externalId === "ktdr5t0xwnhp");
    expect(incident).toBeDefined();
    expect(incident?.stage).toBe("resolved");
    expect(incident?.impact).toBe("degraded");
    expect(incident?.resolvedAt).toBe("2026-09-03T17:11:47.860Z");
    expect(incident?.componentIds).toContain("cnnb39dkkk82");
    expect(result.incidents.every((entry) => entry.stage === "resolved")).toBe(true);

    // Effective status is reconstructible: no active incident, no broken
    // component, operational baseline.
    expect(
      computeEffectiveStatus({
        baseline: result.baseline,
        components: result.components,
        activeIncidents: result.incidents.filter((entry) => entry.stage === "active"),
      })
    ).toBe("operational");
  });

  it("accepts an OpenAI summary that omits `incidents` entirely", () => {
    const result = normalizeStatuspage(
      statuspageConfig({
        sourceId: "openai",
        label: "OpenAI",
        selectedComponentIds: [OPENAI_COMPONENT_IDS.responses, OPENAI_COMPONENT_IDS.codexApi],
      }),
      {
        summary: fixture("statuspage/openai-summary-no-incidents.json"),
        incidents: fixture("statuspage/openai-incidents.json"),
      },
      NOW
    );

    validateAdapterResult(result);
    expect(result.notes).toContain(
      "summary omitted `incidents`; history feed is the only incident source"
    );
    expect(result.components).toHaveLength(25);
    expect(result.incidents.length).toBeGreaterThan(0);
    // The OpenAI feed carries no per-incident component list; that must not be
    // mistaken for schema drift.
    expect(result.incidents.every((entry) => entry.componentIds.length === 0)).toBe(true);
  });

  it("normalizes the recorded Anthropic page", () => {
    const result = normalizeStatuspage(
      statuspageConfig({
        sourceId: "anthropic",
        label: "Claude",
        selectedComponentIds: Object.values(ANTHROPIC_COMPONENT_IDS),
      }),
      {
        summary: fixture("statuspage/anthropic-summary.json"),
        incidents: fixture("statuspage/anthropic-incidents.json"),
      },
      NOW
    );

    validateAdapterResult(result);
    expect(result.components.filter((component) => component.selected)).toHaveLength(2);
    const incident = result.incidents.find((entry) => entry.externalId === "461yvfrzpwtt");
    expect(incident?.impact).toBe("partial_outage");
    expect(incident?.stage).toBe("resolved");
  });

  it("aggregates component groups and reads active incidents from a live degraded page", () => {
    const result = normalizeStatuspage(
      statuspageConfig({ sourceId: "grouped", label: "Grouped" }),
      { summary: fixture("statuspage/grouped-active-summary.json"), incidents: null },
      NOW
    );

    validateAdapterResult(result);
    expect(result.baseline.status).toBe("degraded");
    expect(result.notes).toContain("incident history feed unavailable; summary incidents only");

    const groups = result.components.filter((component) => component.isGroup);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      const children = result.components.filter((component) => component.groupId === group.id);
      expect(children.length).toBeGreaterThan(0);
      // The group carries at least the worst of its children.
      const ranks = ["operational", "maintenance", "degraded", "unknown", "partial_outage", "major_outage"];
      const worstChild = Math.max(...children.map((child) => ranks.indexOf(child.status)));
      expect(ranks.indexOf(group.status)).toBeGreaterThanOrEqual(worstChild);
    }

    const active = result.incidents.filter((entry) => entry.stage === "active");
    expect(active.map((entry) => entry.lifecycle).sort()).toEqual(["identified", "monitoring"]);
    expect(active.every((entry) => entry.resolvedAt === null)).toBe(true);
  });

  it("selecting a group also selects its children", () => {
    const summary = fixture("statuspage/grouped-active-summary.json");
    const parsed = JSON.parse(summary) as { components: { id: string; name: string; group: boolean }[] };
    const groupId = parsed.components.find((component) => component.group)!.id;

    const result = normalizeStatuspage(
      statuspageConfig({ selectedComponentIds: [groupId] }),
      { summary, incidents: null },
      NOW
    );
    const group = result.components.find((component) => component.id === groupId)!;
    const children = result.components.filter((component) => component.groupId === group.id);
    expect(group.selected).toBe(true);
    expect(children.every((child) => child.selected)).toBe(true);
    expect(result.components.some((component) => !component.selected)).toBe(true);
  });

  it("keeps a selected component selected when the page renames it", () => {
    const summary = JSON.parse(fixture("statuspage/github-summary.json")) as {
      components: { id: string; name: string; status: string }[];
    };
    const target = summary.components.find(
      (component) => component.id === GITHUB_COMPONENT_IDS.copilot
    )!;
    // Same stable id, brand new display name, and now broken.
    target.name = "GitHub Copilot (renamed by the vendor)";
    target.status = "major_outage";

    const config = statuspageConfig({
      selectedComponentIds: [GITHUB_COMPONENT_IDS.copilot],
    });
    const result = normalizeStatuspage(
      config,
      { summary: JSON.stringify(summary), incidents: null },
      NOW
    );

    const renamed = result.components.find(
      (component) => component.id === GITHUB_COMPONENT_IDS.copilot
    )!;
    expect(renamed.name).toBe("GitHub Copilot (renamed by the vendor)");
    expect(renamed.selected).toBe(true);
    // The whole point: a rename must not quietly drop the component out of the
    // effective status and publish a green source over a real outage.
    expect(
      computeEffectiveStatus({
        baseline: result.baseline,
        components: result.components,
        activeIncidents: [],
      })
    ).toBe("major_outage");
  });

  it("fails closed when a configured component id has left the page", () => {
    const summary = JSON.parse(fixture("statuspage/github-summary.json")) as {
      components: { id: string }[];
    };
    summary.components = summary.components.filter(
      (component) => component.id !== GITHUB_COMPONENT_IDS.copilot
    );

    expect(() =>
      normalizeStatuspage(
        statuspageConfig({
          selectedComponentIds: [GITHUB_COMPONENT_IDS.apiRequests, GITHUB_COMPONENT_IDS.copilot],
        }),
        { summary: JSON.stringify(summary), incidents: null },
        NOW
      )
    ).toThrow(/configured component id "pjmpxvq2cmr2" is absent from the page/i);
  });

  it("never silently selects zero components", () => {
    // Every configured id resolves, or the refresh throws — there is no path
    // that yields an empty selection from a non-empty configuration.
    const summary = fixture("statuspage/github-summary.json");
    for (const id of Object.values(GITHUB_COMPONENT_IDS)) {
      const result = normalizeStatuspage(
        statuspageConfig({ selectedComponentIds: [id] }),
        { summary, incidents: null },
        NOW
      );
      expect(result.components.filter((component) => component.selected)).toHaveLength(1);
    }
    // An empty configuration means "all", never "none".
    const all = normalizeStatuspage(statuspageConfig(), { summary, incidents: null }, NOW);
    expect(all.components.every((component) => component.selected)).toBe(true);
  });

  it("rejects a history feed belonging to a different page", () => {
    expect(() =>
      normalizeStatuspage(
        statuspageConfig({ sourceId: "github", label: "GitHub" }),
        {
          summary: fixture("statuspage/github-summary.json"),
          incidents: fixture("statuspage/case-page-id-mismatch-incidents.json"),
        },
        NOW
      )
    ).toThrow(/page id mismatch/i);
  });

  it("prefers a newer resolved history record over an older active summary copy", () => {
    const summary = fixture("statuspage/case-crossed-feeds-summary.json");
    const incidents = fixture("statuspage/case-crossed-feeds-history.json");

    const result = normalizeStatuspage(
      statuspageConfig({ sourceId: "anthropic", label: "Claude" }),
      { summary, incidents },
      NOW
    );

    validateAdapterResult(result);
    expect(result.incidents).toHaveLength(1);
    const incident = result.incidents[0]!;
    expect(incident.externalId).toBe("461yvfrzpwtt");
    expect(incident.stage).toBe("resolved");
    expect(incident.resolvedAt).toBe("2026-09-03T16:23:12.052Z");

    // The page itself still says `major`, so effective status must stay
    // degraded-or-worse even though the incident is resolved. Filtering the
    // incident cannot silently clear the page-level verdict.
    expect(
      computeEffectiveStatus({
        baseline: result.baseline,
        components: result.components,
        activeIncidents: result.incidents.filter((entry) => entry.stage === "active"),
      })
    ).toBe("partial_outage");
  });

  it("orders updates by explicit timestamp and breaks ties deterministically", () => {
    const result = normalizeStatuspage(
      statuspageConfig(),
      {
        summary: fixture("statuspage/case-crossed-feeds-summary.json"),
        incidents: fixture("statuspage/case-crossed-feeds-history.json"),
      },
      NOW
    );
    const updates = result.incidents[0]!.updates;
    expect(updates.map((update) => update.id)).toEqual([
      "stale00investigating",
      "tie00000000000a",
      "tie00000000000b",
      "f3p0k452xh58",
    ]);
    expect(updates.map((update) => update.order)).toEqual([0, 1, 2, 3]);
  });

  it("rejects an unknown component status rather than guessing", () => {
    const summary = JSON.parse(fixture("statuspage/github-summary.json")) as {
      components: { status: string }[];
    };
    summary.components[0]!.status = "on_fire";
    expect(() =>
      normalizeStatuspage(statuspageConfig(), { summary: JSON.stringify(summary), incidents: null }, NOW)
    ).toThrow(/unknown status/i);
  });

  it("rejects an over-length incident feed instead of reading a prefix", () => {
    const history = JSON.parse(fixture("statuspage/github-incidents.json")) as {
      incidents: { id: string }[];
    };
    const template = history.incidents[0]!;
    history.incidents = Array.from({ length: 501 }, (_entry, index) => ({
      ...template,
      id: `${template.id}-${String(index)}`,
    }));
    expect(() =>
      normalizeStatuspage(
        statuspageConfig({ sourceId: "github", label: "GitHub" }),
        { summary: fixture("statuspage/github-summary.json"), incidents: JSON.stringify(history) },
        NOW
      )
    ).toThrow(/incident history returned 501 incidents, above the 500 cap/i);
  });

  it("returns every merged incident, dropping none", () => {
    const summary = JSON.parse(fixture("statuspage/github-summary.json")) as Record<string, unknown>;
    const history = JSON.parse(fixture("statuspage/github-incidents.json")) as {
      incidents: { id: string }[];
    };
    const template = history.incidents[0]!;
    history.incidents = Array.from({ length: 120 }, (_entry, index) => ({
      ...template,
      id: `${template.id}-${String(index)}`,
    }));
    const result = normalizeStatuspage(
      statuspageConfig(),
      { summary: JSON.stringify(summary), incidents: JSON.stringify(history) },
      NOW
    );
    expect(result.incidents).toHaveLength(120);
  });

  it("rejects an unknown page indicator", () => {
    const summary = JSON.parse(fixture("statuspage/github-summary.json")) as {
      status: { indicator: string };
    };
    summary.status.indicator = "apocalyptic";
    expect(() =>
      normalizeStatuspage(statuspageConfig(), { summary: JSON.stringify(summary), incidents: null }, NOW)
    ).toThrow(/unknown page indicator/i);
  });

  it("rejects a non-JSON body and a wrong content type through the bounded reader", async () => {
    const summaryUrl = "https://example.test/summary.json";
    const incidentsUrl = "https://example.test/incidents.json";
    const adapter = createStatuspageAdapter(statuspageConfig());

    const wrongType = stubFetch({
      [summaryUrl]: { body: fixture("statuspage/github-summary.json"), contentType: "text/html" },
    });
    await expect(
      adapter({ now: () => NOW, fetchImpl: wrongType.impl })
    ).rejects.toThrow(/unexpected content-type/i);

    const badJson = stubFetch({
      [summaryUrl]: { body: "<html>nope</html>", contentType: "application/json" },
      [incidentsUrl]: { body: "{}", contentType: "application/json" },
    });
    await expect(adapter({ now: () => NOW, fetchImpl: badJson.impl })).rejects.toThrow(
      /not valid JSON/i
    );
  });

  it("reports an HTTP failure without leaking the response body", async () => {
    const adapter = createStatuspageAdapter(statuspageConfig());
    const failing = stubFetch({
      "https://example.test/summary.json": {
        body: "secret internal detail",
        contentType: "application/json",
        status: 503,
      },
    });
    const error = await adapter({ now: () => NOW, fetchImpl: failing.impl }).catch(
      (caught: Error) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Test summary: HTTP 503");
    expect((error as Error).message).not.toContain("secret internal detail");
  });
});

describe("xAI RSS adapter", () => {
  const config = { sourceId: "xai", label: "xAI", feedUrl: "https://status.x.ai/feed.xml" };

  it("normalizes the recorded live feed", () => {
    const result = normalizeXaiFeed(config, fixture("xai/feed-live.xml"), NOW);
    validateAdapterResult(result);

    expect(result.baseline).toEqual({
      status: "operational",
      description: "SpaceXAI System Status",
      derived: true,
    });
    expect(result.incidents.map((incident) => incident.externalId).sort()).toEqual([
      "INC3c8ce3f2",
      "INC410324ed",
      "INC702624e4",
      "INCc33a8af",
    ]);
    expect(result.components.map((component) => component.id).sort()).toEqual([
      "api-console",
      "api-us-east-1",
      "ios-app",
    ]);
    expect(result.components.every((component) => component.status === "operational")).toBe(true);
  });

  it("reads the explicit resolution time, not the publication date or the newest update", () => {
    const result = normalizeXaiFeed(config, fixture("xai/feed-live.xml"), NOW);
    const longRunning = result.incidents.find((incident) => incident.externalId === "INC3c8ce3f2")!;

    // Created in October, resolved the following February: `pubDate` is
    // creation only.
    expect(longRunning.startedAt).toBe("2025-10-24T17:20:00.000Z");
    expect(longRunning.resolvedAt).toBe("2026-02-10T18:50:00.000Z");
    // The last update lands four minutes *after* the stated resolution, so
    // `updatedAt` and `resolvedAt` must not be conflated.
    expect(longRunning.updatedAt).toBe("2026-02-10T18:54:49.000Z");
    expect(longRunning.stage).toBe("resolved");
  });

  it("sorts out-of-order update blocks and leaves an absent resolution time null", () => {
    const result = normalizeXaiFeed(config, fixture("xai/feed-live.xml"), NOW);
    const console = result.incidents.find((incident) => incident.externalId === "INC702624e4")!;

    expect(console.stage).toBe("resolved");
    expect(console.resolvedAt).toBeNull();
    expect(result.notes).toContain(
      "item INC702624e4 is resolved upstream without an explicit resolution time"
    );
    // The feed lists 02:29 before 12:00; the parser re-sorts by explicit time.
    expect(console.updates.map((update) => update.createdAt)).toEqual([
      "2026-05-18T02:29:34.000Z",
      "2026-05-18T12:00:00.000Z",
    ]);
    expect(console.updates.map((update) => update.order)).toEqual([0, 1]);
  });

  it("treats an unresolved item as active and refuses to grade an unfamiliar severity", () => {
    const result = normalizeXaiFeed(config, fixture("xai/case-active.xml"), NOW);
    validateAdapterResult(result);

    const active = result.incidents.find((incident) => incident.externalId === "INCactive01")!;
    expect(active.stage).toBe("active");
    expect(active.lifecycle).toBe("investigating");
    expect(active.impact).toBe("unknown");
    expect(active.resolvedAt).toBeNull();
    expect(active.updates.map((update) => update.createdAt)).toEqual([
      "2026-09-03T17:45:00.000Z",
      "2026-09-03T18:30:00.000Z",
    ]);
    expect(active.updatedAt).toBe("2026-09-03T18:30:00.000Z");
    expect(result.notes.some((note) => note.includes("unrecognized severity"))).toBe(true);

    // XML entities in the title survive decoding.
    expect(active.title).toContain("&");

    const region = result.components.find((component) => component.id === "api-us-east-1")!;
    expect(region.status).toBe("unknown");
    expect(
      computeEffectiveStatus({
        baseline: result.baseline,
        components: result.components,
        activeIncidents: result.incidents.filter((incident) => incident.stage === "active"),
      })
    ).toBe("unknown");
  });

  it("rejects an ambiguous lifecycle and an unparseable date", () => {
    expect(() => normalizeXaiFeed(config, fixture("xai/case-ambiguous-lifecycle.xml"), NOW)).toThrow(
      /ambiguous lifecycle/i
    );
    expect(() => normalizeXaiFeed(config, fixture("xai/case-malformed-date.xml"), NOW)).toThrow(
      /not a parseable date/i
    );
  });

  it("rejects an over-length feed instead of reading a prefix", () => {
    const feed = fixture("xai/feed-live.xml");
    const item = feed.slice(feed.indexOf("    <item>"), feed.indexOf("</item>") + "</item>".length);
    const flooded = feed.replace(
      item,
      Array.from({ length: 501 }, (_entry, index) =>
        item.replace("INCc33a8af", `INCflood${String(index)}`)
      ).join("\n")
    );
    expect(() => normalizeXaiFeed(config, flooded, NOW)).toThrow(/above the 500 cap/i);
  });

  it("rejects a body truncated mid-item rather than reading its complete prefix", () => {
    // The dangerous shape: several resolved incidents parse cleanly, and the
    // response is cut off inside a trailing *active* one. Reading the prefix
    // would drop the outage and report the source operational.
    const complete = fixture("xai/feed-live.xml");
    // Everything before the envelope closes: four complete, resolved items.
    const head = complete.slice(0, complete.lastIndexOf("  </channel>"));
    const truncated =
      head +
      '    <item>\n' +
      "      <title>[API (us-east-1.api.x.ai)] Live outage</title>\n" +
      "      <link>https://status.x.ai/api-us-east-1/INCtrunc</link>\n" +
      '      <guid isPermaLink="false">INCtrunc</guid>\n' +
      "      <description><![CDATA[\n" +
      "           <h3>Status: INVESTIGATING</h3>\n";

    // The prefix on its own really would parse, which is what makes this a trap.
    expect(truncated).toContain("INCc33a8af");
    expect(truncated).not.toContain("</rss>");
    expect(() => normalizeXaiFeed(config, head + "  </channel>\n</rss>\n", NOW)).not.toThrow();
    expect(() => normalizeXaiFeed(config, truncated, NOW)).toThrow(
      /expected exactly one|never closed/i
    );

    // Closing the envelope but leaving the item open is caught on its own.
    const closedEnvelope = truncated + "  </channel>\n</rss>\n";
    expect(() => normalizeXaiFeed(config, closedEnvelope, NOW)).toThrow(
      /truncated: an <item> is never closed/i
    );
  });

  it("rejects a feed whose envelope is missing, duplicated or misordered", () => {
    const feed = fixture("xai/feed-live.xml");
    expect(() => normalizeXaiFeed(config, feed.replace("</channel>", ""), NOW)).toThrow(
      /0 <\/channel> tags; expected exactly one/i
    );
    expect(() => normalizeXaiFeed(config, feed.replace("</rss>", ""), NOW)).toThrow(
      /0 <\/rss> tags; expected exactly one/i
    );
    expect(() => normalizeXaiFeed(config, feed + feed, NOW)).toThrow(
      /2 <rss> tags; expected exactly one/i
    );
    expect(() =>
      normalizeXaiFeed(config, feed.replace("<channel>", "<channel><channel>"), NOW)
    ).toThrow(/2 <channel> tags; expected exactly one/i);

    // An </rss> *moved* before the channel closes: the counts are still one
    // each, so only the ordering check catches it.
    const moved = feed.replace("</rss>", "").replace("  </channel>", "</rss>\n  </channel>");
    expect(() => normalizeXaiFeed(config, moved, NOW)).toThrow(/out of order/i);

    // An item that sits outside the channel is rejected too.
    const outside = feed.replace(
      "</rss>",
      "<item><title>[x] y</title><guid>OUT</guid><pubDate>Thu, 03 Sep 2026 13:30:00 GMT</pubDate></item></rss>"
    );
    expect(() => normalizeXaiFeed(config, outside, NOW)).toThrow(/outside its <channel>/i);
  });

  it("ignores tag-like text inside CDATA, comments and processing instructions", () => {
    const feed = fixture("xai/feed-live.xml");

    // A closing-looking string quoted inside an incident body is not a close.
    const decoyed = feed.replace(
      "<h3>Traffic is healthy again</h3>",
      "<h3>Traffic is healthy again &mdash; see &lt;/rss&gt;</h3>\n               <p>literal </rss> </channel> </item> text</p>"
    );
    const result = normalizeXaiFeed(config, decoyed, NOW);
    expect(result.incidents).toHaveLength(4);
    // …and the literal text survives into the parsed advisory body.
    expect(
      result.incidents.some((incident) =>
        incident.updates.some((update) => update.body.includes("literal"))
      )
    ).toBe(true);

    // Comments and the XML declaration carry no structure either.
    const commented = feed.replace(
      "  <channel>",
      "  <!-- <rss><channel><item></item></channel></rss> -->\n  <channel>"
    );
    expect(normalizeXaiFeed(config, commented, NOW).incidents).toHaveLength(4);
  });

  it("accepts the recorded feed and the current live envelope shape", () => {
    // Guards the structural check against being too strict for real traffic:
    // the live feed carries 114 items inside one channel.
    const feed = fixture("xai/feed-live.xml");
    expect(() => normalizeXaiFeed(config, feed, NOW)).not.toThrow();

    const item = feed.slice(feed.indexOf("    <item>"), feed.indexOf("</item>") + "</item>".length);
    const many = feed.replace(
      item,
      Array.from({ length: 114 }, (_entry, index) =>
        item.replace(/INCc33a8af/g, `INClive${String(index)}`)
      ).join("\n")
    );
    const result = normalizeXaiFeed(config, many, NOW);
    expect(result.incidents.length).toBeGreaterThanOrEqual(114);
  });

  it("rejects a feed that declares a DOCTYPE or has no items", () => {
    const feed = fixture("xai/feed-live.xml");
    expect(() =>
      normalizeXaiFeed(config, feed.replace("<rss", "<!DOCTYPE rss SYSTEM 'x'>\n<rss"), NOW)
    ).toThrow(/DOCTYPE or ENTITY/i);
    expect(() =>
      normalizeXaiFeed(config, '<?xml version="1.0"?><rss><channel><title>x</title></channel></rss>', NOW)
    ).toThrow(/no <item> elements/i);
  });

  it("requires an XML content type", async () => {
    const adapter = createXaiAdapter(config);
    const stub = stubFetch({
      [config.feedUrl]: { body: fixture("xai/feed-live.xml"), contentType: "text/html" },
    });
    await expect(adapter({ now: () => NOW, fetchImpl: stub.impl })).rejects.toThrow(
      /unexpected content-type/i
    );
  });
});

describe("Google Cloud adapter", () => {
  const config = {
    sourceId: "google-cloud",
    label: "Google Cloud",
    productsUrl: "https://status.cloud.google.com/products.json",
    incidentsUrl: "https://status.cloud.google.com/incidents.json",
    relevantProductIds: ["deUeOEPYanfJ9w8cpyBJ", "Z0FZJAMvEB4j3NbCJs6B"],
  };

  it("filters to configured products by stable id and honours AVAILABLE recovery", () => {
    const result = normalizeGoogleCloud(
      config,
      {
        products: fixture("google-cloud/products.json"),
        incidents: fixture("google-cloud/incidents.json"),
      },
      NOW
    );

    validateAdapterResult(result);
    // The unrelated us-central1-b incident touches none of the configured
    // products and is dropped entirely.
    expect(result.incidents.map((incident) => incident.externalId)).toEqual([
      "41E5S3mkTGDfkZuJZH5k",
    ]);

    const incident = result.incidents[0]!;
    expect(incident.componentIds).toEqual(["Z0FZJAMvEB4j3NbCJs6B"]);
    expect(incident.impact).toBe("operational");
    expect(incident.stage).toBe("resolved");
    expect(incident.lifecycle).toBe("AVAILABLE");
    expect(incident.url).toBe("https://status.cloud.google.com/incidents/41E5S3mkTGDfkZuJZH5k");
    // Updates arrive newest-first upstream and are re-sorted ascending.
    expect(incident.updates.map((update) => update.createdAt)).toEqual([
      "2026-02-27T16:12:30.000Z",
      "2026-03-04T23:23:18.000Z",
      "2026-03-09T05:25:43.000Z",
    ]);

    // The renamed product keeps its id and reports its current title.
    const vertex = result.components.find((component) => component.id === "Z0FZJAMvEB4j3NbCJs6B")!;
    expect(vertex.name).toBe("Gemini on Agent Platform");
    expect(result.components.map((component) => component.status)).toEqual([
      "operational",
      "operational",
    ]);
    expect(result.notes).toEqual([]);
  });

  it("keeps an open incident active and reflects it on the configured component", () => {
    const result = normalizeGoogleCloud(
      config,
      {
        products: fixture("google-cloud/products.json"),
        incidents: fixture("google-cloud/case-active-gemini.json"),
      },
      NOW
    );

    validateAdapterResult(result);
    const incident = result.incidents[0]!;
    expect(incident.stage).toBe("active");
    expect(incident.resolvedAt).toBeNull();
    expect(incident.impact).toBe("major_outage");

    const codeAssist = result.components.find(
      (component) => component.id === "deUeOEPYanfJ9w8cpyBJ"
    )!;
    expect(codeAssist.status).toBe("major_outage");
    expect(
      computeEffectiveStatus({
        baseline: result.baseline,
        components: result.components,
        activeIncidents: result.incidents.filter((entry) => entry.stage === "active"),
      })
    ).toBe("major_outage");
  });

  it("fails closed when a configured product id has left the catalogue", () => {
    expect(() =>
      normalizeGoogleCloud(
        { ...config, relevantProductIds: ["deUeOEPYanfJ9w8cpyBJ", "aProductIdThatVanished"] },
        {
          products: fixture("google-cloud/products.json"),
          incidents: fixture("google-cloud/incidents.json"),
        },
        NOW
      )
    ).toThrow(/configured product id "aProductIdThatVanished" is absent from products\.json/i);
  });

  it("fails closed when an incident names a product the catalogue does not list", () => {
    // Ignoring the unresolvable id would drop the incident and publish a green
    // snapshot; the previous last-known-good snapshot is the safer answer.
    expect(() =>
      normalizeGoogleCloud(
        config,
        {
          products: fixture("google-cloud/products.json"),
          incidents: fixture("google-cloud/case-unknown-product-id.json"),
        },
        NOW
      )
    ).toThrow(/names product id "aProductIdMissingFromCatalogue", which is absent from products\.json/i);
  });

  it("rejects an over-length incident feed instead of reading a prefix", () => {
    const template = (JSON.parse(fixture("google-cloud/case-active-gemini.json")) as unknown[])[0] as {
      id: string;
    };
    const oversized = Array.from({ length: 501 }, (_entry, index) => ({
      ...template,
      id: `${template.id}-${String(index)}`,
    }));
    expect(() =>
      normalizeGoogleCloud(
        config,
        { products: fixture("google-cloud/products.json"), incidents: JSON.stringify(oversized) },
        NOW
      )
    ).toThrow(/above the 500 cap/i);
  });

  it("rejects an affected product entry without an id", () => {
    const incidents = JSON.parse(fixture("google-cloud/case-active-gemini.json")) as {
      affected_products: { id?: string }[];
    }[];
    delete incidents[0]!.affected_products[0]!.id;
    expect(() =>
      normalizeGoogleCloud(
        config,
        { products: fixture("google-cloud/products.json"), incidents: JSON.stringify(incidents) },
        NOW
      )
    ).toThrow(/affected product id/i);
  });

  it("rejects an empty product catalogue", () => {
    expect(() =>
      normalizeGoogleCloud(
        config,
        { products: JSON.stringify({ products: [] }), incidents: "[]" },
        NOW
      )
    ).toThrow(/no products/i);
  });
});

describe("Google AI Studio adapter", () => {
  const config = {
    sourceId: "google-ai-studio",
    label: "Google AI Studio",
    bootstrapUrl: "https://aistudio.google.com/status",
    rpcUrl: "https://alkali.example.test/rpc",
  };

  it("normalizes the recorded history, including a 1 → 5 → 4 lifecycle", () => {
    const result = normalizeAlkaliHistory(config, fixture("google-ai-studio/alkali-history.json"), NOW);
    validateAdapterResult(result);

    expect(result.components).toEqual([]);
    expect(result.incidents).toHaveLength(3);
    expect(result.incidents.every((incident) => incident.stage === "resolved")).toBe(true);
    // Severity is never invented from a lifecycle number.
    expect(result.incidents.every((incident) => incident.impact === "unknown")).toBe(true);

    const postpay = result.incidents.find(
      (incident) => incident.externalId === "AIStudio-postpay-upgrade-20260422"
    )!;
    expect(postpay.updates.map((update) => update.lifecycle)).toEqual(["code-1", "code-5", "code-4"]);
    // The epoch-seconds field, not the local display string, is authoritative.
    expect(postpay.startedAt).toBe("2026-04-21T23:24:00.000Z");
    expect(postpay.resolvedAt).toBe("2026-04-23T19:46:00.000Z");
    expect(result.baseline.derived).toBe(true);
    expect(result.baseline.status).toBe("operational");
  });

  it("treats a trailing code-5 update as unresolved", () => {
    const result = normalizeAlkaliHistory(config, fixture("google-ai-studio/case-active.json"), NOW);
    validateAdapterResult(result);

    const active = result.incidents.find(
      (incident) => incident.externalId === "GeminiAPI-elevated-errors-20260903"
    )!;
    expect(active.stage).toBe("active");
    expect(active.lifecycle).toBe("code-5");
    expect(active.resolvedAt).toBeNull();
    expect(result.baseline.description).toContain("1 active incident");
    expect(
      computeEffectiveStatus({
        baseline: result.baseline,
        components: result.components,
        activeIncidents: result.incidents.filter((incident) => incident.stage === "active"),
      })
    ).toBe("unknown");
  });

  it("classifies a duplicated terminal update as resolved", () => {
    // The RPC posts the same resolution twice. Uniquifying renames the second
    // copy, so the lifecycle code has to travel with the update to its final id
    // — otherwise the newest update looks code-less and the incident reads as
    // still open.
    const result = normalizeAlkaliHistory(
      config,
      fixture("google-ai-studio/case-duplicate-terminal-update.json"),
      NOW
    );
    validateAdapterResult(result);

    const incident = result.incidents[0]!;
    expect(incident.updates).toHaveLength(3);
    expect(new Set(incident.updates.map((update) => update.id)).size).toBe(3);
    expect(incident.updates.map((update) => update.lifecycle)).toEqual([
      "code-1",
      "code-4",
      "code-4",
    ]);
    expect(incident.stage).toBe("resolved");
    expect(incident.resolvedAt).toBe("2026-09-03T18:20:00.000Z");
    expect(result.incidents.filter((entry) => entry.stage === "active")).toEqual([]);
  });

  it("fails closed on a lifecycle code outside the observed range", () => {
    expect(() =>
      normalizeAlkaliHistory(config, fixture("google-ai-studio/case-unknown-code.json"), NOW)
    ).toThrow(/unknown lifecycle code/i);
  });

  it("fails closed on an envelope that is not the expected positional shape", () => {
    expect(() => normalizeAlkaliHistory(config, JSON.stringify([[]]), NOW)).toThrow(
      /does not contain an incident list/i
    );
    expect(() => normalizeAlkaliHistory(config, JSON.stringify({ incidents: [] }), NOW)).toThrow(
      /expected \[\[ … \]\] envelope/i
    );
  });

  it("rejects an over-length history instead of reading a prefix", () => {
    const recorded = JSON.parse(fixture("google-ai-studio/alkali-history.json")) as unknown[][][];
    const template = recorded[0]![0]![0] as unknown[];
    const flooded = Array.from({ length: 501 }, (_entry, index) => [
      `flood-${String(index)}`,
      ...template.slice(1),
    ]);
    expect(() => normalizeAlkaliHistory(config, JSON.stringify([[flooded]]), NOW)).toThrow(
      /above the 500 cap/i
    );
  });

  it("tolerates the anti-XSS prefix and an empty history", () => {
    const result = normalizeAlkaliHistory(config, ")]}'\n" + JSON.stringify([[[]]]), NOW);
    expect(result.incidents).toEqual([]);
    expect(result.notes).toContain("history is empty");
  });

  it("discovers bootstrap credential candidates without persisting them", () => {
    const html = fixture("google-ai-studio/bootstrap.html");
    const candidates = discoverBootstrapCandidates(html);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.every((candidate) => candidate.startsWith("AIza"))).toBe(true);

    // Nothing the adapter returns may echo a credential.
    const result = normalizeAlkaliHistory(config, fixture("google-ai-studio/alkali-history.json"), NOW);
    const serialized = JSON.stringify(result);
    for (const candidate of candidates) expect(serialized).not.toContain(candidate);
  });

  it("falls back to the next candidate and never names a credential in an error", async () => {
    const html = fixture("google-ai-studio/bootstrap.html");
    const candidates = discoverBootstrapCandidates(html);
    const used: string[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === config.bootstrapUrl) {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const key = String((init?.headers as Record<string, string>)["x-goog-api-key"]);
      used.push(key);
      if (key === candidates[0]) {
        return new Response(JSON.stringify([7, "blocked"]), {
          status: 403,
          headers: { "content-type": "application/json+protobuf" },
        });
      }
      return new Response(fixture("google-ai-studio/alkali-history.json"), {
        headers: { "content-type": "application/json+protobuf; charset=UTF-8" },
      });
    }) as unknown as typeof fetch;

    const adapter = createGoogleAiStudioAdapter(config);
    const result = await adapter({ now: () => NOW, fetchImpl: impl });
    expect(used).toEqual([candidates[0], candidates[1]]);
    expect(result.incidents).toHaveLength(3);

    const allFail = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === config.bootstrapUrl) {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("denied", { status: 403, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const error = await adapter({ now: () => NOW, fetchImpl: allFail }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    for (const candidate of candidates) {
      expect((error as Error).message).not.toContain(candidate);
    }
    expect((error as Error).message).toMatch(/every discovered credential candidate failed/i);
  });

  it("fails closed when the bootstrap exposes no candidate", async () => {
    const adapter = createGoogleAiStudioAdapter(config);
    const stub = stubFetch({
      [config.bootstrapUrl]: { body: "<html><body>nothing here</body></html>", contentType: "text/html" },
    });
    await expect(adapter({ now: () => NOW, fetchImpl: stub.impl })).rejects.toThrow(
      /no RPC credential candidate/i
    );
  });
});

describe("Linkworks synthetic-probe adapter", () => {
  const config = {
    sourceId: "linkworks-ollama",
    label: "Ollama endpoints (Linkworks probe)",
    url: "https://ollama.linkworksinc.com/live",
  };

  it("parses the recorded server-rendered rows", () => {
    const result = normalizeLinkworksDashboard(config, fixture("linkworks/live.html"), NOW);
    validateAdapterResult(result);

    // Five rows, but two of them are indistinguishable and merge into one.
    expect(result.components).toHaveLength(4);
    expect(new Set(result.components.map((component) => component.id)).size).toBe(4);
    expect(result.baseline).toEqual({
      status: "operational",
      description: "Third-party synthetic probe dashboard; not official Ollama Cloud status",
      derived: true,
    });
    expect(result.incidents).toEqual([]);

    const degraded = result.components.find((component) => component.status === "degraded")!;
    expect(degraded.name).toBe("FORGE · gemma4-26b-vane");
    expect(degraded.updatedAt).toBe("2026-09-03T18:03:39.000Z");

    // The row without an <a title> falls back to its first cell, and the probe
    // URL it embeds is not persisted.
    const fallback = result.components.find((component) => component.name.includes("honcho"))!;
    expect(fallback.name).toBe("qwen3-8b-honcho");
    expect(JSON.stringify(result)).not.toContain("10.0.0.222");

    expect(
      computeEffectiveStatus({
        baseline: result.baseline,
        components: result.components,
        activeIncidents: [],
      })
    ).toBe("degraded");
  });

  it("merges rows the dashboard publishes under one identity, keeping the worst status", () => {
    const live = fixture("linkworks/live.html");
    const result = normalizeLinkworksDashboard(config, live, NOW);

    const scout = result.components.find((component) => component.name === "SCOUT · qwen3-vl-8b")!;
    expect(scout.status).toBe("operational");
    // The later of the two probe times is kept.
    expect(scout.updatedAt).toBe("2026-09-03T19:05:00.000Z");
    expect(result.notes).toContain(
      '2 rows share the identity of "SCOUT · qwen3-vl-8b"; they were merged, taking the worst status'
    );

    // If one of the twins degrades, the merged component must degrade with it —
    // a healthy twin may never mask a broken one.
    const oneDegraded = live.replace('<span class="pill-ok">OK</span></div><div class="text-right"><span class="num text-[19px] text-ink">33.8', '<span class="pill-warn">DEGRADED</span></div><div class="text-right"><span class="num text-[19px] text-ink">33.8');
    const degradedResult = normalizeLinkworksDashboard(config, oneDegraded, NOW);
    const merged = degradedResult.components.find(
      (component) => component.name === "SCOUT · qwen3-vl-8b"
    )!;
    expect(merged.status).toBe("degraded");
  });

  it("fails closed on an unrecognized status word", () => {
    expect(() =>
      normalizeLinkworksDashboard(config, fixture("linkworks/case-unknown-status.html"), NOW)
    ).toThrow(/unrecognized status/i);
  });

  it("rejects an over-length dashboard instead of reading a prefix", () => {
    const live = fixture("linkworks/live.html");
    const row = live.slice(live.indexOf('<a href="/live"'), live.indexOf("</a>") + "</a>".length);
    const flooded = live.replace(row, row.repeat(201));
    expect(() => normalizeLinkworksDashboard(config, flooded, NOW)).toThrow(/above the 200 cap/i);
  });

  it("rejects a page truncated mid-row rather than reading its healthy prefix", () => {
    const live = fixture("linkworks/live.html");
    // Cut the document inside the degraded row: every row before it is healthy
    // and would parse, so a prefix read would publish an operational source.
    const degradedAt = live.indexOf("pill-warn");
    const truncated = live.slice(0, degradedAt);

    expect(truncated).toContain("pill-ok");
    expect(truncated).not.toMatch(/<\/html\s*>/i);
    expect(() => normalizeLinkworksDashboard(config, truncated, NOW)).toThrow(
      /expected exactly one|never closed/i
    );

    // Even with the document closed, an unbalanced row opening is rejected.
    const unbalanced = `${truncated}</div></div></section></main></body></html>`;
    expect(() => normalizeLinkworksDashboard(config, unbalanced, NOW)).toThrow(
      /a row anchor is never closed/i
    );
  });

  it("does not accept a </html> that only exists inside a script", () => {
    // The false-green shape: the document is cut off inside the degraded row,
    // but an inline script earlier on the page contains a literal "</html>".
    const live = fixture("linkworks/live.html");
    const decoyed = live.replace(
      "<main",
      '<script>const marker = "</html></body>";</script><main'
    );
    const truncated = decoyed.slice(0, decoyed.indexOf("pill-warn"));

    expect(truncated).toContain("</html>");
    expect(truncated).toContain("pill-ok");
    expect(() => normalizeLinkworksDashboard(config, truncated, NOW)).toThrow(
      /expected exactly one|never closed/i
    );

    // The same decoy on a complete page changes nothing.
    expect(normalizeLinkworksDashboard(config, decoyed, NOW).components).toHaveLength(4);
  });

  it("rejects a missing, duplicated or misordered envelope and a decoy table", () => {
    const live = fixture("linkworks/live.html");

    expect(() => normalizeLinkworksDashboard(config, live.replace("<body", "<div"), NOW)).toThrow(
      /0 <body> tags; expected exactly one/i
    );
    expect(() => normalizeLinkworksDashboard(config, live + live, NOW)).toThrow(
      /2 <html> tags; expected exactly one/i
    );
    // A second role="table" block is ambiguous, not a fallback.
    expect(() =>
      normalizeLinkworksDashboard(
        config,
        live.replace("<main", '<div role="table"><a role="row"></a></div><main'),
        NOW
      )
    ).toThrow(/2 role="table" blocks; expected exactly one/i);
    // </body> *moved* before the table: still one of each, so only the ordering
    // check catches it.
    const moved = live
      .replace("</body>", "")
      .replace('<div role="table">', '</body><div role="table">');
    expect(() => normalizeLinkworksDashboard(config, moved, NOW)).toThrow(/out of order/i);
  });

  it("rejects a table block whose own close never arrives", () => {
    const live = fixture("linkworks/live.html");
    // Everything through the last row, then straight to the envelope close: the
    // rows are all complete, but the table div is never closed.
    const unclosed = live.slice(0, live.lastIndexOf("</a>") + "</a>".length) + "</body></html>";
    expect(unclosed).toContain("pill-warn");
    expect(() => normalizeLinkworksDashboard(config, unclosed, NOW)).toThrow(
      /role="table" block is never closed/i
    );
  });

  it("rejects an orphan row close inside the table", () => {
    const live = fixture("linkworks/live.html");
    const orphan = live.replace('<div role="table">', '<div role="table"></a>');
    expect(() => normalizeLinkworksDashboard(config, orphan, NOW)).toThrow(
      /closes an anchor that was never opened/i
    );
  });

  it("accepts the recorded page and the current live twelve-row shape", () => {
    const live = fixture("linkworks/live.html");
    expect(() => normalizeLinkworksDashboard(config, live, NOW)).not.toThrow();

    // The live dashboard renders twelve rows; the structural check must not
    // reject that, and the indistinguishable-row merge must still apply.
    const row = live.slice(live.indexOf('<a href="/live"'), live.indexOf("</a>") + "</a>".length);
    const twelve = live.replace(row, row.repeat(9));
    const result = normalizeLinkworksDashboard(config, twelve, NOW);
    expect(result.components.length).toBeGreaterThan(0);
    expect(result.notes.some((note) => note.includes("share the identity of"))).toBe(true);
    expect(result.components.some((component) => component.status === "degraded")).toBe(true);
  });

  it("fails closed when the server-rendered table is gone", () => {
    expect(() =>
      normalizeLinkworksDashboard(config, "<html><body><p>rebuilt</p></body></html>", NOW)
    ).toThrow(/0 role="table" blocks; expected exactly one/i);
  });
});

describe("source registry", () => {
  it("marks six official sources and one third-party synthetic source", () => {
    const sources = createDefaultServiceStatusSources();
    const official = sources.filter((source) => source.provenance === "official");
    const synthetic = sources.filter((source) => source.provenance === "external_synthetic");

    expect(official.map((source) => source.id).sort()).toEqual([
      "anthropic",
      "github",
      "google-ai-studio",
      "google-cloud",
      "openai",
      "xai",
    ]);
    expect(synthetic.map((source) => source.id)).toEqual(["linkworks-ollama"]);
    expect(synthetic[0]!.scopeNote).toMatch(/NOT official Ollama Cloud status/);
    expect(synthetic[0]!.label).not.toMatch(/^Ollama Cloud$/);

    const aiStudio = sources.find((source) => source.id === "google-ai-studio")!;
    expect(aiStudio.scopeNote).toMatch(/not proof that the Antigravity \(agy\) host itself is healthy/i);

    expect(new Set(sources.map((source) => source.id)).size).toBe(sources.length);
  });
});

describe("canonical timestamp invariant", () => {
  it("every built-in adapter emits canonical timestamps for its recorded shape", () => {
    // The store compares these strings lexicographically, so a non-canonical
    // one could reorder instants. Each adapter's happy-path output is checked
    // in full rather than field by field.
    const results = [
      normalizeStatuspage(
        statuspageConfig({ sourceId: "github", label: "GitHub" }),
        {
          summary: fixture("statuspage/github-summary.json"),
          incidents: fixture("statuspage/github-incidents.json"),
        },
        NOW
      ),
      normalizeStatuspage(
        statuspageConfig({ sourceId: "grouped", label: "Grouped" }),
        { summary: fixture("statuspage/grouped-active-summary.json"), incidents: null },
        NOW
      ),
      normalizeXaiFeed(
        { sourceId: "xai", label: "xAI", feedUrl: "" },
        fixture("xai/feed-live.xml"),
        NOW
      ),
      normalizeGoogleCloud(
        {
          sourceId: "google-cloud",
          label: "Google Cloud",
          productsUrl: "",
          incidentsUrl: "",
          relevantProductIds: ["deUeOEPYanfJ9w8cpyBJ", "Z0FZJAMvEB4j3NbCJs6B"],
        },
        {
          products: fixture("google-cloud/products.json"),
          incidents: fixture("google-cloud/incidents.json"),
        },
        NOW
      ),
      normalizeAlkaliHistory(
        { sourceId: "ais", label: "AI Studio", bootstrapUrl: "", rpcUrl: "" },
        fixture("google-ai-studio/alkali-history.json"),
        NOW
      ),
      normalizeLinkworksDashboard(
        { sourceId: "lw", label: "Linkworks", url: "" },
        fixture("linkworks/live.html"),
        NOW
      ),
    ];

    const canonical = (value: string): boolean => value === new Date(value).toISOString();
    let checked = 0;
    for (const result of results) {
      // The store's own gate accepts every one of them.
      expect(() => validateAdapterResult(result)).not.toThrow();

      const seen: (string | null)[] = [result.fetchedAt];
      for (const component of result.components) seen.push(component.updatedAt);
      for (const incident of result.incidents) {
        seen.push(incident.startedAt, incident.updatedAt, incident.resolvedAt);
        for (const update of incident.updates) seen.push(update.createdAt);
      }
      for (const value of seen) {
        if (value === null) continue;
        checked += 1;
        expect(canonical(value), `${result.sourceId}: ${value}`).toBe(true);
      }
    }
    // Guards against the loop silently checking nothing.
    expect(checked).toBe(100);
  });
});

describe("fixture coverage", () => {
  it("reads every committed fixture at least once", () => {
    // Discovered from disk rather than listed by hand, so a fixture that stops
    // being exercised — the exact failure mode that let the previous attempt
    // stay green against payloads nobody parsed — fails this test.
    const committed: string[] = [];
    for (const family of readdirSync(FIXTURES, { withFileTypes: true })) {
      if (!family.isDirectory()) continue;
      for (const file of readdirSync(path.join(FIXTURES, family.name))) {
        committed.push(`${family.name}/${file}`);
      }
    }
    expect(committed.length).toBeGreaterThan(0);
    expect([...READ_FIXTURES].sort()).toEqual(committed.sort());
  });
});
