/**
 * The ONE renderer for per-model catalog evidence (#236).
 *
 * Every operator-facing surface — MCP `config_describe`, the turn status DTO,
 * and the config-audit snapshot — formats provenance through here, so a
 * provider's evidence shape is interpreted in exactly one place and the three
 * surfaces cannot drift apart.
 *
 * Generic by construction: it names FIELDS, never providers or models. Records
 * were screened by the portable parser before persistence, so every value is
 * already bounded and secret-free; the caps below bound the RENDERING so a
 * status card or audit row cannot be flooded by a legitimately large record set.
 */
import type { CatalogModelEvidence } from "@seam/adapters";

/** Most provenance lines any one surface will render. */
export const CATALOG_EVIDENCE_RENDER_MAX_LINES = 4;
/**
 * Longest single rendered line. Bounded so one record cannot flood a card or an
 * audit row, but wide enough that a complete legitimate record — kind, source,
 * timestamp, runtime, scope, resolved model, context, effort default and note —
 * survives intact rather than losing its most specific field to truncation.
 * Total rendered budget is this times {@link CATALOG_EVIDENCE_RENDER_MAX_LINES}.
 */
export const CATALOG_EVIDENCE_RENDER_MAX_CHARS = 240;

export function formatCatalogEvidence(record: CatalogModelEvidence): string {
  const parts: string[] = [`${record.kind} via ${record.source}`];
  if (record.observedAt) parts.push(record.observedAt);
  if (record.runtimeVersion) parts.push(record.runtimeVersion);
  if (record.scopeRef) parts.push(`scope ${record.scopeRef.slice(0, 12)}`);
  if (record.resolvedModel) parts.push(`resolved ${record.resolvedModel}`);
  if (record.context?.native != null) parts.push(`context ${record.context.native}`);
  if (record.effort?.selectionDefault) parts.push(`effort default ${record.effort.selectionDefault}`);
  if (record.note) parts.push(record.note);
  const line = parts.join("; ");
  return line.length > CATALOG_EVIDENCE_RENDER_MAX_CHARS
    ? `${line.slice(0, CATALOG_EVIDENCE_RENDER_MAX_CHARS - 1)}…`
    : line;
}

export function renderCatalogEvidenceLines(
  records: ReadonlyArray<CatalogModelEvidence> | undefined
): string[] {
  if (!records?.length) return [];
  return records.slice(0, CATALOG_EVIDENCE_RENDER_MAX_LINES).map(formatCatalogEvidence);
}
