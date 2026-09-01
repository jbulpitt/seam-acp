import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionConfigSelectOptions,
  type SessionConfigSelectGroup,
} from "@agentclientprotocol/sdk";
import type { AaModel, CopilotModelMetadata, CopilotPricing } from "./types.js";

export const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
export const COPILOT_PRICING_URL =
  "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing.md";

type FetchLike = typeof fetch;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseAaModels(payload: unknown): AaModel[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error("Artificial Analysis response is missing the data array");
  }
  const rows: AaModel[] = [];
  for (const raw of (payload as { data: unknown[] }).data) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.slug !== "string") {
      continue;
    }
    const evaluations =
      row.evaluations && typeof row.evaluations === "object"
        ? (row.evaluations as Record<string, unknown>)
        : {};
    const benchmarks: Record<string, number> = {};
    for (const [key, value] of Object.entries(evaluations)) {
      const numeric = finiteNumber(value);
      if (numeric !== null) benchmarks[key] = numeric;
    }
    const intelligenceIndex =
      finiteNumber(evaluations.artificial_analysis_intelligence_index) ??
      finiteNumber(evaluations.intelligence_index);
    if (intelligenceIndex !== null) {
      benchmarks.artificial_analysis_intelligence_index = intelligenceIndex;
    }
    rows.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      intelligenceIndex,
      benchmarks,
    });
  }
  if (rows.length === 0) throw new Error("Artificial Analysis response contained no usable models");
  return rows;
}

export async function fetchAaModels(
  apiKey: string,
  fetchImpl: FetchLike = fetch
): Promise<AaModel[]> {
  if (!apiKey.trim()) throw new Error("AA_API_KEY is not configured");
  const response = await fetchImpl(AA_MODELS_URL, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Artificial Analysis request failed: HTTP ${response.status}`);
  return parseAaModels(await response.json());
}

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

function flattenSelectOptions(options: SessionConfigSelectOptions): SessionConfigSelectOption[] {
  return (options as Array<SessionConfigSelectOption | SessionConfigSelectGroup>).flatMap((option) =>
    "options" in option ? option.options : [option]
  );
}

function configOptions(value: unknown): SessionConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is SessionConfigOption => Boolean(entry && typeof entry === "object" && "id" in entry)
  );
}

function modelOptions(options: SessionConfigOption[]): SessionConfigSelectOption[] {
  const model = options.find((option) => option.id === "model");
  return model?.type === "select" ? flattenSelectOptions(model.options) : [];
}

function effortValues(options: SessionConfigOption[]): string[] {
  const effort = options.find((option) => option.id === "reasoning_effort");
  if (effort?.type !== "select") return [];
  return flattenSelectOptions(effort.options).map((entry) => entry.value);
}

function priceCategory(option: SessionConfigSelectOption): string | null {
  const meta = (option as SessionConfigSelectOption & { _meta?: Record<string, unknown> })._meta;
  return typeof meta?.copilotPriceCategory === "string" ? meta.copilotPriceCategory : null;
}

function timeout<T>(ms: number, message: string): Promise<T> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
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
  const child = spawn(options.cliPath ?? "copilot", ["--acp"], {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const died = new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`copilot ACP exited early (code=${code}, signal=${signal}): ${stderr.trim()}`))
    );
  });
  const writable = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
  const client: Client = {
    async requestPermission(request) {
      const option = request.options.find((entry) => entry.kind?.startsWith("allow_"));
      return option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
    async sessionUpdate() {},
  };
  const connection = new ClientSideConnection(() => client, ndJsonStream(writable, readable));
  const timeoutMs = options.timeoutMs ?? 45_000;
  let sessionId: string | undefined;
  try {
    await Promise.race([
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }),
      died,
      timeout<void>(timeoutMs, "copilot ACP initialize timed out"),
    ]);
    const session = await Promise.race([
      connection.newSession({ cwd: options.cwd ?? process.cwd(), mcpServers: [] }),
      died,
      timeout<never>(timeoutMs, "copilot ACP session/new timed out"),
    ]);
    sessionId = session.sessionId;
    const models = modelOptions(configOptions(session.configOptions));
    if (models.length === 0) throw new Error("copilot ACP advertised no model config options");
    const rows: CopilotModelMetadata[] = [];
    for (const model of models) {
      if (model.value === "auto") {
        rows.push({
          modelId: model.value,
          displayName: model.name,
          validEffortTiers: [],
          priceCategory: priceCategory(model),
        });
        continue;
      }
      const response = await Promise.race([
        connection.setSessionConfigOption({
          sessionId,
          configId: "model",
          value: model.value,
        }),
        died,
        timeout<never>(timeoutMs, `copilot ACP model probe timed out for ${model.value}`),
      ]);
      rows.push({
        modelId: model.value,
        displayName: model.name,
        validEffortTiers: effortValues(configOptions(response.configOptions)),
        priceCategory: priceCategory(model),
      });
    }
    return rows;
  } finally {
    if (sessionId) await connection.closeSession({ sessionId }).catch(() => undefined);
    child.kill("SIGKILL");
  }
}
