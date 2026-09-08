import { probeCopilotCatalog } from "@seam/adapters";
import type { CopilotModelMetadata, CopilotPricing } from "./types.js";
export {
  AA_MODELS_URL,
  fetchAaModels,
  parseAaModels,
} from "../model-metadata/artificial-analysis.js";
export const COPILOT_PRICING_URL =
  "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing.md";

type FetchLike = typeof fetch;

function markdownCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/<sup>.*?<\/sup>/gi, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\\\|/g, "|")
    .trim();
}

function parseDollarRate(value: string): number | null {
  const clean = cleanMarkdown(value).replace(/,/g, "");
  if (/^(?:n\/a|not applicable|—|-|)$/i.test(clean)) return null;
  const match = clean.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) throw new Error(`unrecognized Copilot price cell: ${JSON.stringify(value)}`);
  return Number(match[1]!);
}

function normalizedHeader(value: string): string {
  return cleanMarkdown(value).toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

/** Parse every pricing table on GitHub's billing reference. Long-context rows
 * have a separate Tier column; only the Default row applies to seam's fixed
 * 8k/2k standard task. Any usable table whose row shape changes fails closed. */
export function parseCopilotPricingMarkdown(markdown: string): CopilotPricing[] {
  const lines = markdown.split(/\r?\n/);
  const byName = new Map<string, CopilotPricing>();
  let pricingTables = 0;
  for (let index = 0; index < lines.length - 2; index += 1) {
    if (!lines[index]!.trim().startsWith("|")) continue;
    const headers = markdownCells(lines[index]!).map(normalizedHeader);
    const divider = markdownCells(lines[index + 1]!);
    if (!divider.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;

    const modelIndex = headers.findIndex((h) => h === "model");
    const inputIndex = headers.findIndex((h) => h === "input");
    const outputIndex = headers.findIndex((h) => h === "output");
    if (modelIndex < 0 || inputIndex < 0 || outputIndex < 0) continue;
    pricingTables += 1;
    const cachedIndex = headers.findIndex((h) => h === "cached input");
    const cacheWriteIndex = headers.findIndex((h) => h === "cache write");
    const tierIndex = headers.findIndex((h) => h === "tier");

    for (index += 2; index < lines.length && lines[index]!.trim().startsWith("|"); index += 1) {
      const cells = markdownCells(lines[index]!);
      if (cells.every((cell) => cleanMarkdown(cell) === "")) continue;
      if (cells.length !== headers.length) {
        throw new Error(
          `Copilot pricing table shape changed: expected ${headers.length} cells, got ${cells.length}`
        );
      }
      if (tierIndex >= 0 && !/^(?:default|)$/i.test(cleanMarkdown(cells[tierIndex]!))) continue;
      const modelName = cleanMarkdown(cells[modelIndex]!).replace(/\s*\([^)]*(?:preview|retired)[^)]*\)\s*$/i, "");
      if (!modelName) continue;
      const inputRate = parseDollarRate(cells[inputIndex]!);
      const outputRate = parseDollarRate(cells[outputIndex]!);
      if (inputRate === null || outputRate === null) {
        throw new Error(`Copilot pricing row for ${modelName} lacks input/output rates`);
      }
      const row: CopilotPricing = {
        modelName,
        inputRate,
        cachedInputRate: cachedIndex >= 0 ? parseDollarRate(cells[cachedIndex]!) : null,
        cacheWriteRate: cacheWriteIndex >= 0 ? parseDollarRate(cells[cacheWriteIndex]!) : null,
        outputRate,
      };
      const key = modelName.toLowerCase();
      const prior = byName.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
        throw new Error(`conflicting default Copilot pricing rows for ${modelName}`);
      }
      byName.set(key, row);
    }
    index -= 1;
  }
  if (pricingTables === 0 || byName.size === 0) {
    throw new Error("Copilot pricing page contained no recognized model pricing tables");
  }
  return [...byName.values()];
}

export async function fetchCopilotPricing(fetchImpl: FetchLike = fetch): Promise<CopilotPricing[]> {
  const response = await fetchImpl(COPILOT_PRICING_URL, {
    headers: { accept: "text/markdown" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Copilot pricing request failed: HTTP ${response.status}`);
  return parseCopilotPricingMarkdown(await response.text());
}

export interface CopilotProbeOptions {
  cliPath?: string;
  cwd?: string;
  timeoutMs?: number;
}

/** Probe model-specific ACP configuration. The same session is reused because
 * setSessionConfigOption returns the newly applicable effort selector. */
export async function fetchCopilotModelMetadata(
  options: CopilotProbeOptions = {}
): Promise<CopilotModelMetadata[]> {
  const result = await probeCopilotCatalog(options);
  return result.models.map((model) => ({
    modelId: model.modelId,
    displayName: model.displayName,
    validEffortTiers: model.effortChoices,
    priceCategory: model.priceCategory,
  }));
}
