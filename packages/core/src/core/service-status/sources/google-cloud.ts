import { failSchema, fetchBoundedText, parseJson } from "../http.js";
import { worstStatus } from "../severity.js";
import { maxTimestamp, orderUpdates, stableHash, withUniqueIds, type RawIncidentUpdate } from "./shared.js";
import {
  optionalString,
  optionalTimestamp,
  requireArray,
  requireRecord,
  requireString,
  requireTimestamp,
} from "../validate.js";
import type {
  NormalizedComponent,
  NormalizedIncident,
  ServiceStatusAdapterContext,
  ServiceStatusAdapterResult,
  ServiceStatusLevel,
} from "../types.js";

/**
 * Google Cloud status adapter.
 *
 * Two documented feeds are read: `products.json` is the stable catalogue that
 * maps an opaque product id to its *current* title, and `incidents.json` is the
 * incident list. Product identity always comes from the opaque id — Google
 * renames products in place (for example `Vertex Gemini API` is now titled
 * `Gemini on Agent Platform` under the same id), so matching on a title would
 * silently stop watching the dependency it was configured for.
 *
 * Two fields are easy to confuse and are read separately here: an incident's
 * severity is the top-level `status_impact`, while `updates[].status` is the
 * lifecycle, whose `AVAILABLE` value is the recovery marker.
 *
 * The adapter never reports partial success. Losing product identity — a
 * configured id that has left the catalogue, or an incident naming a product
 * the catalogue does not list — fails the whole refresh, because the alternative
 * is quietly dropping the one incident that mattered and publishing a false
 * green while the last-known-good snapshot would have been more honest. An
 * over-length incident feed is rejected for the same reason rather than
 * truncated.
 */

export const GOOGLE_CLOUD_PRODUCTS_URL = "https://status.cloud.google.com/products.json";
export const GOOGLE_CLOUD_INCIDENTS_URL = "https://status.cloud.google.com/incidents.json";
const GOOGLE_CLOUD_BASE_URL = "https://status.cloud.google.com/";

/**
 * Work bound, set well above what the live feed returns (six entries at
 * recording time). Exceeding it is treated as schema drift, not as a signal to
 * read a prefix: a truncated read could drop the one active incident that
 * mattered and report success anyway.
 */
const MAX_INCIDENTS = 500;
const RECOVERED = "AVAILABLE";

const STATUS_IMPACTS: Readonly<Record<string, ServiceStatusLevel>> = {
  AVAILABLE: "operational",
  SERVICE_INFORMATION: "operational",
  SERVICE_DISRUPTION: "partial_outage",
  SERVICE_OUTAGE: "major_outage",
};

export interface GoogleCloudSourceConfig {
  sourceId: string;
  label: string;
  productsUrl: string;
  incidentsUrl: string;
  /** Opaque catalogue ids of the products Seam actually depends on. */
  relevantProductIds: readonly string[];
}

export interface GoogleCloudFeeds {
  products: string;
  incidents: string;
}

export function normalizeGoogleCloud(
  config: GoogleCloudSourceConfig,
  feeds: GoogleCloudFeeds,
  fetchedAt: Date
): ServiceStatusAdapterResult {
  const label = `${config.label} status`;
  const notes: string[] = [];

  const catalogue = parseCatalogue(label, feeds.products);
  for (const productId of config.relevantProductIds) {
    if (!catalogue.has(productId)) {
      // A configured id vanishing from the catalogue means we can no longer
      // prove which product we are watching, so the refresh fails closed and
      // the previous last-known-good snapshot is retained.
      failSchema(label, `configured product id ${JSON.stringify(productId)} is absent from products.json`);
    }
  }
  const relevant = new Set(config.relevantProductIds);

  const rawIncidents = requireArray(label, parseJson(label, feeds.incidents), "incidents");
  if (rawIncidents.length > MAX_INCIDENTS) {
    failSchema(
      label,
      `incidents feed returned ${String(rawIncidents.length)} entries, above the ${String(MAX_INCIDENTS)} cap`
    );
  }

  const incidents: NormalizedIncident[] = [];
  for (const raw of rawIncidents) {
    const parsed = parseIncident(label, raw, catalogue, notes);
    if (parsed.affectedProductIds.some((id) => relevant.has(id))) {
      incidents.push({
        ...parsed.incident,
        componentIds: parsed.affectedProductIds.filter((id) => relevant.has(id)).sort(),
      });
    }
  }

  return {
    sourceId: config.sourceId,
    fetchedAt: fetchedAt.toISOString(),
    baseline: {
      // Google publishes no single global indicator in these feeds, so the
      // baseline is derived from "both feeds parsed" and stays operational;
      // configured components and active incidents carry the severity.
      status: "operational",
      description: "Google Cloud incident feed parsed",
      derived: true,
    },
    components: buildComponents(config.relevantProductIds, catalogue, incidents),
    incidents: incidents.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.externalId.localeCompare(b.externalId)
    ),
    notes,
  };
}

interface CatalogueEntry {
  id: string;
  title: string;
}

function parseCatalogue(label: string, text: string): Map<string, CatalogueEntry> {
  const root = requireRecord(label, parseJson(label, text), "products.json");
  const entries = requireArray(label, root.products, "products");
  const catalogue = new Map<string, CatalogueEntry>();
  for (const entry of entries) {
    const record = requireRecord(label, entry, "product");
    const id = requireString(label, record.id, "product.id");
    const title = optionalString(record.current_title) ?? requireString(label, record.title, "product.title");
    if (catalogue.has(id)) failSchema(label, `duplicate product id ${JSON.stringify(id)}`);
    catalogue.set(id, { id, title });
  }
  if (catalogue.size === 0) failSchema(label, "products.json contained no products");
  return catalogue;
}

interface ParsedIncident {
  incident: NormalizedIncident;
  affectedProductIds: string[];
}

function parseIncident(
  label: string,
  raw: unknown,
  catalogue: Map<string, CatalogueEntry>,
  notes: string[]
): ParsedIncident {
  const record = requireRecord(label, raw, "incident");
  const externalId = requireString(label, record.id, "incident.id");

  const impactToken = requireString(label, record.status_impact, "incident.status_impact");
  let impact = STATUS_IMPACTS[impactToken];
  if (!impact) {
    impact = "unknown";
    notes.push(
      `incident ${externalId} reports unrecognized status_impact ${JSON.stringify(impactToken)}; ` +
        "impact recorded as unknown rather than graded"
    );
  }

  const createdAt = requireTimestamp(label, record.created, "incident.created");
  const startedAt = optionalTimestamp(label, record.begin, "incident.begin") ?? createdAt;
  const end = optionalTimestamp(label, record.end, "incident.end");

  const rawUpdates = requireArray(label, record.updates, "incident.updates");
  const updates = orderUpdates(
    withUniqueIds(
      rawUpdates.map((entry): RawIncidentUpdate => {
        const update = requireRecord(label, entry, "incident update");
        const when = requireTimestamp(label, update.when, "incident update when");
        const text = typeof update.text === "string" ? update.text : "";
        return {
          id: `${externalId}:${when}:${stableHash(text)}`,
          lifecycle: requireString(label, update.status, "incident update status"),
          body: text,
          createdAt: when,
        };
      })
    ),
    `${label} incident ${externalId}`
  );

  const latest = updates.length > 0 ? updates[updates.length - 1] : null;
  const recoveredAt = latest && latest.lifecycle === RECOVERED ? latest.createdAt : null;
  const resolvedAt = end ?? recoveredAt;
  const stage = resolvedAt === null ? "active" : "resolved";

  const affectedProductIds: string[] = [];
  for (const entry of requireArray(label, record.affected_products, "incident.affected_products")) {
    const product = requireRecord(label, entry, "affected product");
    const id = requireString(label, product.id, "affected product id");
    if (!catalogue.has(id)) {
      // We can no longer tell whether this product is one Seam depends on.
      // Ignoring it could publish a green snapshot over a real outage, so the
      // refresh fails and the previous snapshot stands.
      failSchema(
        label,
        `incident ${externalId} names product id ${JSON.stringify(id)}, which is absent from products.json`
      );
    }
    affectedProductIds.push(id);
  }

  const uri = optionalString(record.uri);
  const modified = optionalTimestamp(label, record.modified, "incident.modified");

  return {
    affectedProductIds,
    incident: {
      externalId,
      title: requireString(label, record.external_desc, "incident.external_desc"),
      stage,
      lifecycle: latest?.lifecycle ?? impactToken,
      impact,
      url: new URL(uri ?? `incidents/${externalId}`, GOOGLE_CLOUD_BASE_URL).toString(),
      startedAt,
      updatedAt: maxTimestamp([latest?.createdAt ?? null, modified, startedAt]) ?? startedAt,
      resolvedAt,
      componentIds: [],
      updates,
    },
  };
}

function buildComponents(
  relevantProductIds: readonly string[],
  catalogue: Map<string, CatalogueEntry>,
  incidents: readonly NormalizedIncident[]
): NormalizedComponent[] {
  const impactsByProduct = new Map<string, ServiceStatusLevel[]>();
  const updatedByProduct = new Map<string, string | null>();
  for (const incident of incidents) {
    for (const componentId of incident.componentIds) {
      if (incident.stage === "active") {
        const bucket = impactsByProduct.get(componentId);
        if (bucket) bucket.push(incident.impact);
        else impactsByProduct.set(componentId, [incident.impact]);
      }
      updatedByProduct.set(
        componentId,
        maxTimestamp([updatedByProduct.get(componentId) ?? null, incident.updatedAt])
      );
    }
  }

  return [...relevantProductIds].sort().map((id) => ({
    id,
    name: catalogue.get(id)?.title ?? id,
    status: worstStatus(impactsByProduct.get(id) ?? []),
    description: null,
    groupId: null,
    isGroup: false,
    selected: true,
    updatedAt: updatedByProduct.get(id) ?? null,
  }));
}

export function createGoogleCloudAdapter(
  config: GoogleCloudSourceConfig
): (context: ServiceStatusAdapterContext) => Promise<ServiceStatusAdapterResult> {
  return async (context) => {
    const shared = {
      expectContentType: /application\/json/i,
      fetchImpl: context.fetchImpl,
      signal: context.signal,
    } as const;
    const products = await fetchBoundedText({
      ...shared,
      label: `${config.label} products`,
      url: config.productsUrl,
    });
    const incidents = await fetchBoundedText({
      ...shared,
      label: `${config.label} incidents`,
      url: config.incidentsUrl,
    });
    return normalizeGoogleCloud(
      config,
      { products: products.text, incidents: incidents.text },
      context.now()
    );
  };
}
