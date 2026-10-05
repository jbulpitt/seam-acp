/** Reasoning-effort options for the `/seam effort` picker. Mirror of the SDK's
 *  EffortLevel type — keep in sync with commands.ts and the bundled SDK
 *  (docs/model-management-runbook.md §11). `ultra` is codex-only (not in the Claude SDK). */
const EFFORT_CHOICES = [
  { value: "low", label: "Low", description: "Fastest, least reasoning" },
  { value: "medium", label: "Medium", description: "Light reasoning" },
  { value: "high", label: "High", description: "Default for most models" },
  { value: "xhigh", label: "X-High", description: "Deeper reasoning (Opus 4.7+)" },
  { value: "max", label: "Max", description: "Maximum reasoning depth" },
  { value: "ultra", label: "Ultra", description: "Max reasoning + auto task delegation (codex)" },
];

/** Generic labels/order only; availability always comes from the selected model. */
export function catalogEffortChoices(supported: ReadonlyArray<string>): Array<{
  value: string;
  label: string;
  description?: string;
}> {
  const declared = new Set(supported);
  const known = EFFORT_CHOICES.filter((choice) => declared.delete(choice.value));
  const fallback = [...declared].map((value) => ({
    value,
    label: value === "default" ? "Default" : value,
    description: value === "default" ? "Use the catalog's provider default" : "Adapter-defined effort",
  }));
  return [...known, ...fallback];
}
