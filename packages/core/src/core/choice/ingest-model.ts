/**
 * Isolated ingest stores only an explicit mint pin. Do not copy the live
 * thread's session model. Empty/whitespace means the catalog default is
 * resolved at fire, preserving default pinning as the catalog advances.
 */
export function ingestMintStoredModel(pinned: string | null | undefined): string | null {
  const m = typeof pinned === "string" ? pinned.trim() : "";
  return m.length > 0 ? m : null;
}
