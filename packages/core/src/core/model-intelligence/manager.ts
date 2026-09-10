import { createHash } from "node:crypto";
import { Cron } from "croner";
import type { CatalogModel } from "@seam/adapters";
import type { Logger } from "../../lib/logger.js";
import type { CatalogFleetBinding } from "../model-catalog/service.js";
import { AA_MODELS_URL } from "../model-metadata/artificial-analysis.js";
import { buildModelMetadataSnapshot } from "../model-metadata/catalog.js";
import type { AgentModelAvailability, MetadataSource, MetadataSourceModel, ModelMetadata } from "../model-metadata/types.js";
import { buildModelValueSnapshot } from "../model-value/ranking.js";
import { COPILOT_PRICING_URL } from "../model-value/sources.js";
import type { CopilotPricing, ModelValueScenario, ModelValueSnapshotRow } from "../model-value/types.js";
import { ModelIntelligenceStore, type IntelligenceSourceName, type IntelligenceSourceSnapshot } from "./store.js";

export const MODEL_INTELLIGENCE_REFRESH_CRON = "0 */12 * * *";
export const MODEL_INTELLIGENCE_PARSER_VERSION = "249.1";
export const MODEL_INTELLIGENCE_MATCHING_POLICY_VERSION = "249.2";

export interface ModelIntelligenceRefreshResult {
  ok: boolean;
  result: "published" | "unchanged" | "retained" | "stopped";
  generation: number | null;
  matchingPolicyVersion: string | null;
  sources: Record<IntelligenceSourceName, {
    snapshot: number | null;
    status: "fresh" | "stale" | "missing";
    sourceUrl: string | null;
    parserVersion: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
  }>;
  nextRunAt: string | null;
  coverage: { models: number; benchmarkMatched: number; pricingMatched: number; unresolved: string[] };
  diagnostics: string[];
}

export class ModelIntelligenceManager {
  private job?: Cron;
  private inFlight?: Promise<ModelIntelligenceRefreshResult>;
  private pendingCatalog = false;
  private pendingForceSources = false;
  private stopped = false;
  private controller?: AbortController;
  private onUpdate?: () => void;
  private lastResult?: ModelIntelligenceRefreshResult;

  constructor(private readonly options: {
    store: ModelIntelligenceStore;
    logger: Logger;
    source: MetadataSource;
    fetchPricing: (signal?: AbortSignal) => Promise<CopilotPricing[]>;
    getCatalog: () => CatalogFleetBinding[] | Promise<CatalogFleetBinding[]>;
    scenario: ModelValueScenario;
    now?: () => Date;
    refreshCron?: string;
  }) {}

  start(): void {
    if (this.stopped || this.job) return;
    this.job = new Cron(this.options.refreshCron ?? MODEL_INTELLIGENCE_REFRESH_CRON,
      { timezone: "UTC", name: "model-intelligence" }, () => { if (!this.stopped) void this.refresh({ forceSources: true }); });
    queueMicrotask(() => { if (!this.stopped) void this.refresh({ forceSources: true }); });
    this.options.logger.info({ nextRunUtc: this.job.nextRun()?.toISOString() }, "model intelligence refresh armed");
  }

  stop(): void {
    this.stopped = true;
    this.job?.stop();
    this.job = undefined;
    this.pendingCatalog = false;
    this.pendingForceSources = false;
    this.controller?.abort(new Error("model intelligence stopped"));
  }

  async drain(): Promise<void> { while (this.inFlight) await this.inFlight; }
  setOnUpdate(value: (() => void) | undefined): void { this.onUpdate = value; }

  refreshForCatalogGeneration(): void {
    if (this.stopped) return;
    if (this.inFlight) { this.pendingCatalog = true; return; }
    void this.refresh({ forceSources: false });
  }

  refresh(options: { forceSources?: boolean } = {}): Promise<ModelIntelligenceRefreshResult> {
    if (this.stopped) return Promise.resolve(this.result("stopped", ["manager stopped"]));
    if (this.inFlight) {
      if (options.forceSources) {
        this.pendingForceSources = true;
        const beforeAa = this.options.store.latestSourceAttempt("artificial-analysis")?.id ?? 0;
        const beforePricing = this.options.store.latestSourceAttempt("github-copilot-pricing")?.id ?? 0;
        return this.waitForForcedFollowUp(beforeAa, beforePricing);
      }
      return this.inFlight;
    }
    this.inFlight = this.refreshInner(options.forceSources ?? true).then((result) => {
      this.lastResult = result;
      return result;
    }).finally(() => {
      this.inFlight = undefined;
      const followUp = this.pendingCatalog || this.pendingForceSources;
      const forceSources = this.pendingForceSources;
      this.pendingCatalog = false;
      this.pendingForceSources = false;
      if (followUp && !this.stopped) void this.refresh({ forceSources });
    });
    return this.inFlight;
  }

  private async waitForForcedFollowUp(beforeAa: number, beforePricing: number): Promise<ModelIntelligenceRefreshResult> {
    while (!this.stopped) {
      const flight = this.inFlight;
      if (flight) await flight;
      await Promise.resolve();
      const afterAa = this.options.store.latestSourceAttempt("artificial-analysis")?.id ?? 0;
      const afterPricing = this.options.store.latestSourceAttempt("github-copilot-pricing")?.id ?? 0;
      if (afterAa > beforeAa && afterPricing > beforePricing && this.lastResult) return this.lastResult;
      if (!this.inFlight) break;
    }
    return this.lastResult ?? this.result(this.stopped ? "stopped" : "retained", ["forced follow-up did not complete"]);
  }

  private async refreshInner(forceSources: boolean): Promise<ModelIntelligenceRefreshResult> {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const attemptedAt = (this.options.now?.() ?? new Date()).toISOString();
    try {
      const [aa, pricing, fleet] = await Promise.all([
        this.source("artificial-analysis", AA_MODELS_URL, forceSources, signal, () => this.options.source.fetch(signal)),
        this.source("github-copilot-pricing", COPILOT_PRICING_URL, forceSources, signal, () => this.options.fetchPricing(signal)),
        this.options.getCatalog(),
      ]);
      if (this.stopped) return this.result("stopped", ["manager stopped before publication"]);
      const built = buildGeneration(fleet, aa, pricing, this.options.scenario, attemptedAt);
      const aaStale = Boolean(aa) && this.options.store.latestSourceAttempt("artificial-analysis")?.status === "failure";
      const pricingStale = Boolean(pricing) && this.options.store.latestSourceAttempt("github-copilot-pricing")?.status === "failure";
      if (aa && aaStale) built.diagnostics.push(`Artificial Analysis source stale; retained snapshot ${aa.id}`);
      if (pricing && pricingStale) built.diagnostics.push(`GitHub pricing source stale; retained snapshot ${pricing.id}`);
      for (const row of built.metadata) {
        if (row.matching) {
          row.matching.artificial_analysis.stale = aaStale;
          if (row.matching.github_copilot_pricing) row.matching.github_copilot_pricing.stale = pricingStale;
        }
      }
      for (const row of built.values) {
        row.sourceStatus = {
          "artificial-analysis": !aa ? "unavailable" : aaStale ? "stale" : "fresh",
          "github-copilot-pricing": !pricing ? "unavailable" : pricingStale ? "stale" : "fresh",
        };
      }
      if (built.metadata.length === 0) {
        return this.complete("retained", [...built.diagnostics, "operational catalog has no enrichable ready/stale models"], attemptedAt, forceSources);
      }
      const active = this.options.store.active();
      const regressions = active ? matchingRegressions(active, built.metadata, built.values) : [];
      built.diagnostics.push(...regressions);
      built.diagnostics = [...new Set(built.diagnostics)].sort();
      for (const row of built.values) row.generationDiagnostics = [...built.diagnostics];
      if (active) {
        const previous = new Set([
          ...active.diagnostics,
          ...(this.options.store.latestRefreshAttempt()?.diagnostics ?? []),
        ].filter((detail) => detail.startsWith("matching regression:")));
        const introduced = regressions.filter((detail) => !previous.has(detail));
        const recovered = [...previous].filter((detail) => !regressions.includes(detail));
        if (introduced.length > 0) {
          this.options.logger.warn({ regressions: introduced }, "model intelligence matching coverage regressed");
        }
        if (recovered.length > 0) {
          this.options.logger.info({ recovered }, "model intelligence matching coverage recovered");
        }
      }
      const collapse = active && matchingCollapsed(active, built.metadata, built.values, this.options.store, aa, pricing);
      if (collapse) {
        this.options.logger.error({ collapse }, "model intelligence matching coverage collapsed; retaining active generation");
        return this.complete("retained", [...built.diagnostics, collapse], attemptedAt, forceSources);
      }
      if (active && active.catalogSignature === built.catalogSignature &&
        active.matchingPolicyVersion === MODEL_INTELLIGENCE_MATCHING_POLICY_VERSION &&
        active.sourceSnapshots["artificial-analysis"] === (aa?.id ?? null) &&
        active.sourceSnapshots["github-copilot-pricing"] === (pricing?.id ?? null) &&
        JSON.stringify(active.scenario) === JSON.stringify(this.options.scenario)) {
        return this.complete("unchanged", built.diagnostics, attemptedAt, forceSources);
      }
      const generation = this.options.store.publish({
        publishedAt: attemptedAt, catalogSignature: built.catalogSignature,
        matchingPolicyVersion: MODEL_INTELLIGENCE_MATCHING_POLICY_VERSION,
        sourceSnapshots: { "artificial-analysis": aa?.id ?? null, "github-copilot-pricing": pricing?.id ?? null },
        scenario: this.options.scenario, diagnostics: built.diagnostics,
        metadata: built.metadata, values: built.values,
      });
      try { this.onUpdate?.(); } catch (err) { this.options.logger.warn({ err }, "model intelligence update callback failed"); }
      this.options.logger.info({ generation: generation.generation, models: built.metadata.length, values: built.values.length }, "model intelligence generation published");
      return this.complete("published", built.diagnostics, attemptedAt, forceSources);
    } catch (err) {
      if (this.stopped) return this.result("stopped", ["manager stopped before publication"]);
      const message = err instanceof Error ? err.message : String(err);
      this.options.logger.error({ err }, "model intelligence refresh failed; retaining active generation");
      return this.complete("retained", [message], attemptedAt, forceSources);
    } finally {
      if (this.controller?.signal === signal) this.controller = undefined;
    }
  }

  private async source<T>(
    source: IntelligenceSourceName, sourceUrl: string, force: boolean, signal: AbortSignal,
    fetcher: () => Promise<T[]>
  ): Promise<IntelligenceSourceSnapshot<T> | null> {
    const prior = this.options.store.latestSourceSuccess<T>(source);
    if (!force && prior) return prior;
    const attemptedAt = (this.options.now?.() ?? new Date()).toISOString();
    try {
      const records = await fetcher();
      if (signal.aborted) throw signal.reason;
      return this.options.store.recordSourceSuccess({ source, sourceUrl, parserVersion: MODEL_INTELLIGENCE_PARSER_VERSION,
        attemptedAt, fetchedAt: (this.options.now?.() ?? new Date()).toISOString(), records });
    } catch (err) {
      if (!this.stopped) this.options.store.recordSourceFailure({ source, sourceUrl, parserVersion: MODEL_INTELLIGENCE_PARSER_VERSION,
        attemptedAt, error: err instanceof Error ? err.message : String(err) });
      this.options.logger.warn({ err, source, retainedSnapshot: prior?.id ?? null }, "model intelligence source failed; retaining source LKG");
      return prior;
    }
  }

  private result(result: ModelIntelligenceRefreshResult["result"], diagnostics: string[]): ModelIntelligenceRefreshResult {
    const active = this.options.store.active();
    const status = (source: IntelligenceSourceName) => {
      const latest = this.options.store.latestSourceSuccess(source);
      const attempt = this.options.store.latestSourceAttempt(source);
      if (!latest) return { snapshot: null, status: "missing" as const,
        sourceUrl: attempt?.sourceUrl ?? null, parserVersion: attempt?.parserVersion ?? null,
        lastAttemptAt: attempt?.attemptedAt ?? null, lastSuccessAt: null };
      const fresh = active?.sourceSnapshots[source] === latest.id && attempt?.status === "success";
      return { snapshot: latest.id, status: fresh ? "fresh" as const : "stale" as const,
        sourceUrl: latest.sourceUrl, parserVersion: latest.parserVersion,
        lastAttemptAt: attempt?.attemptedAt ?? null, lastSuccessAt: latest.fetchedAt };
    };
    const unresolved = active?.metadata.filter((row) => row.matching?.artificial_analysis.status !== "matched")
      .map((row) => row.variant_id ?? row.id).sort() ?? [];
    return { ok: result === "published" || result === "unchanged", result, generation: active?.generation ?? null,
      matchingPolicyVersion: active?.matchingPolicyVersion ?? null,
      sources: { "artificial-analysis": status("artificial-analysis"), "github-copilot-pricing": status("github-copilot-pricing") },
      nextRunAt: this.job?.nextRun()?.toISOString() ?? null,
      coverage: {
        models: active?.metadata.length ?? 0,
        benchmarkMatched: active?.metadata.filter((row) => row.intelligence_index !== null).length ?? 0,
        pricingMatched: active?.values.filter((row) => row.creditsPerTask !== null).length ?? 0,
        unresolved,
      },
      diagnostics };
  }

  private complete(
    result: "published" | "unchanged" | "retained",
    diagnostics: string[],
    attemptedAt: string,
    forceSources: boolean,
  ): ModelIntelligenceRefreshResult {
    const output = this.result(result, diagnostics);
    try {
      this.options.store.recordRefreshAttempt({
        attemptedAt,
        completedAt: (this.options.now?.() ?? new Date()).toISOString(),
        forceSources,
        result,
        generation: output.generation,
        diagnostics,
      });
    } catch (err) {
      this.options.logger.error({ err }, "failed to persist model intelligence refresh status");
    }
    return output;
  }
}

function buildGeneration(
  fleet: CatalogFleetBinding[], aa: IntelligenceSourceSnapshot<MetadataSourceModel> | null,
  pricing: IntelligenceSourceSnapshot<CopilotPricing> | null, scenario: ModelValueScenario, fetchedAt: string
): { metadata: ModelMetadata[]; values: ModelValueSnapshotRow[]; diagnostics: string[]; catalogSignature: string } {
  const diagnostics: string[] = [];
  if (!aa) diagnostics.push("Artificial Analysis source unavailable; no validated snapshot");
  if (!pricing) diagnostics.push("GitHub pricing source unavailable; no validated snapshot");
  const availability: AgentModelAvailability[] = [];
  for (const binding of fleet) {
    if (binding.state === "warming" || binding.state === "drift" || !binding.snapshot) {
      diagnostics.push(`${binding.binding.agentId}@${binding.binding.location}: catalog ${binding.state}`);
      continue;
    }
    for (const model of binding.snapshot.candidate.models) {
      if (model.availability !== "available" || model.lifecycle === "retired") continue;
      availability.push(toAvailability(binding, model));
    }
  }
  const metadataResult = buildModelMetadataSnapshot({ catalog: availability, sourceModels: aa?.records ?? [],
    source: "artificial-analysis", fetchedAt: aa?.fetchedAt ?? fetchedAt });
  if (aa) diagnostics.push(...metadataResult.unmatchedModels.map((id) => `${id}: no Artificial Analysis match`));
  const baseMetadata = metadataResult.rows.map((row) => ({ ...row,
    source_snapshots: { "artificial-analysis": aa ? String(aa.id) : null, "github-copilot-pricing": pricing ? String(pricing.id) : null },
    source_fetched_at: { "artificial-analysis": aa?.fetchedAt ?? null, "github-copilot-pricing": pricing?.fetchedAt ?? null },
  }));
  const copilot = [...new Map(availability.filter((row) => row.catalogProvider === "github-copilot")
    .map((row) => [`${row.catalogScope ?? row.agentId}\u0000${row.modelId}`, row] as const)).values()];
  const valuesResult = buildModelValueSnapshot({
    copilotModels: copilot.map((row) => ({ modelId: row.modelId, displayName: row.name,
      validEffortTiers: row.effortChoices ?? [], priceCategory: row.priceCategory ?? null,
      runtimeId: row.runtimeId, aliases: row.aliases, effortDefault: row.effortDefault, effortMechanism: row.effortMechanism,
      variantId: `${row.catalogScope ?? row.agentId}::${row.modelId}` })),
    aaModels: aa?.records ?? [], pricing: pricing?.records ?? [], inputTokens: scenario.uncached_input_tokens,
    cachedInputTokens: scenario.cached_input_tokens, cacheWriteTokens: scenario.cache_write_tokens,
    outputTokens: scenario.output_tokens, longContextThresholdTokens: scenario.long_context_threshold_tokens,
    fetchedAt,
  });
  if (aa) diagnostics.push(...valuesResult.unmatchedAaModels.map((id) => `${id}: benchmark unresolved`));
  if (pricing) diagnostics.push(...valuesResult.unmatchedPricingModels.map((id) => `${id}: pricing unresolved`));
  const catalogSignature = stableHash(fleet.map((entry) => ({ binding: entry.binding, state: entry.state,
    generation: entry.snapshot?.generation ?? null, scope: entry.snapshot?.scopeKey ?? null,
    checksum: entry.snapshot?.checksum ?? null }))
    .sort((a, b) => a.binding.agentId.localeCompare(b.binding.agentId) ||
      a.binding.location.localeCompare(b.binding.location)));
  const byVariant = new Map(copilot.map((entry) => [
    `${entry.catalogScope ?? entry.agentId}::${entry.modelId}`, entry,
  ]));
  const values = valuesResult.rows.map((row) => {
    const entry = byVariant.get(row.variantId ?? row.copilotModel);
    const bindings = entry ? availability.filter((candidate) =>
      candidate.catalogScope === entry.catalogScope && candidate.modelId === entry.modelId
    ).map((candidate) => ({
      agent: candidate.agentId, location: candidate.location ?? "local",
      scope: candidate.catalogScope!, generation: candidate.catalogGeneration!,
      state: candidate.catalogState === "stale" ? "stale" as const : "ready" as const,
      runtime_id: candidate.runtimeId ?? candidate.modelId,
      aliases: [...(candidate.aliases ?? [])],
      application_mode: candidate.applicationMode,
      effort_choices: [...(candidate.effortChoices ?? [])],
      effort_default: candidate.effortDefault,
      effort_mechanism: candidate.effortMechanism,
    })) : [];
    return { ...row, bindings, catalogGeneration: entry?.catalogGeneration,
      catalogDefault: entry?.modelDefault, effortDefault: entry?.effortDefault,
      effortMechanism: entry?.effortMechanism,
      benchmarkMatchStatus: aa ? row.benchmarkMatchStatus : "source-unavailable",
      pricingMatchStatus: pricing ? row.pricingMatchStatus : "source-unavailable",
      sourceSnapshots: { "artificial-analysis": aa ? String(aa.id) : null, "github-copilot-pricing": pricing ? String(pricing.id) : null },
      sourceFetchedAt: { "artificial-analysis": aa?.fetchedAt ?? null, "github-copilot-pricing": pricing?.fetchedAt ?? null },
      scenario,
    };
  });
  const valuesByVariant = new Map(values.map((row) => [row.variantId ?? row.copilotModel, row]));
  const metadata = baseMetadata.map((row) => {
    const value = valuesByVariant.get(row.variant_id ?? row.id);
    return {
      ...row,
      matching: {
        artificial_analysis: {
          ...row.matching!.artificial_analysis,
          status: aa ? row.matching!.artificial_analysis.status : "source-unavailable",
          snapshot_id: aa ? String(aa.id) : null,
          detail: aa ? row.matching!.artificial_analysis.detail : "no validated source snapshot",
        },
        github_copilot_pricing: value ? {
          status: pricing ? value.pricingMatchStatus ?? "no-source-record" : "source-unavailable",
          source: "github-copilot-pricing", snapshot_id: pricing ? String(pricing.id) : null, record_id: null,
          record_name: value.pricingMatchRecordName ?? null,
          selected_effort: null, policy: "automatic-exact-normalized-scenario-tier",
          candidates: value.pricingMatchCandidates ?? [], stale: false,
          detail: pricing ? value.pricingTier ? `tier ${value.pricingTier}` : null : "no validated source snapshot",
        } : null,
      },
    };
  });
  return { metadata, values, diagnostics: [...new Set(diagnostics)].sort(), catalogSignature };
}

function toAvailability(binding: CatalogFleetBinding, model: CatalogModel): AgentModelAvailability {
  const snapshot = binding.snapshot!;
  return {
    agentId: binding.binding.agentId, location: binding.binding.location, modelId: model.id,
    runtimeId: model.runtimeId, name: model.displayName, aliases: model.aliases,
    contextWindow: model.context.effective, vision: model.modalities.input.includes("image"),
    effortChoices: model.effort.choices.map((choice) => choice.id), effortDefault: model.effort.selectionDefault,
    effortMechanism: model.effort.mechanism, priceCategory: model.pricingCategory,
    modelDefault: model.default,
    catalogProvider: snapshot.candidate.scope.provider, catalogGeneration: snapshot.generation,
    catalogScope: snapshot.scopeKey, catalogState: binding.state,
    catalogFetchedAt: snapshot.candidate.fetchedAt, description: model.description, evidence: model.evidence,
    applicationMode: model.applicationMode, executionBindings: model.bindings,
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function matchingCollapsed(
  active: NonNullable<ReturnType<ModelIntelligenceStore["active"]>>,
  metadata: ModelMetadata[], values: ModelValueSnapshotRow[], store: ModelIntelligenceStore,
  aa: IntelligenceSourceSnapshot<MetadataSourceModel> | null,
  pricing: IntelligenceSourceSnapshot<CopilotPricing> | null
): string | null {
  const priorAaId = active.sourceSnapshots["artificial-analysis"];
  const priorPriceId = active.sourceSnapshots["github-copilot-pricing"];
  const priorAa = priorAaId ? store.sourceSnapshot<MetadataSourceModel>(priorAaId) : null;
  const priorPricing = priorPriceId ? store.sourceSnapshot<CopilotPricing>(priorPriceId) : null;
  const currentByVariant = new Map(metadata.map((row) => [row.variant_id ?? row.id, row]));
  const comparable = active.metadata.filter((row) => row.slug && currentByVariant.has(row.variant_id ?? row.id));
  const retained = comparable.filter((row) => currentByVariant.get(row.variant_id ?? row.id)?.slug).length;
  if (priorAa && aa && aa.records.length >= priorAa.records.length && comparable.length > 0 && retained < Math.ceil(comparable.length / 2)) {
    return `Artificial Analysis matching collapsed (${retained}/${comparable.length} comparable rows)`;
  }
  const currentValues = new Map(values.map((row) => [row.variantId ?? row.copilotModel, row]));
  const priorPriced = active.values.filter((row) => row.inputRate !== null && currentValues.has(row.variantId ?? row.copilotModel));
  const retainedPriced = priorPriced.filter((row) => currentValues.get(row.variantId ?? row.copilotModel)?.inputRate !== null).length;
  if (priorPricing && pricing && pricing.records.length >= priorPricing.records.length && priorPriced.length > 0 && retainedPriced < Math.ceil(priorPriced.length / 2)) {
    return `GitHub pricing matching collapsed (${retainedPriced}/${priorPriced.length} comparable rows)`;
  }
  return null;
}

function matchingRegressions(
  active: NonNullable<ReturnType<ModelIntelligenceStore["active"]>>,
  metadata: ModelMetadata[],
  values: ModelValueSnapshotRow[],
): string[] {
  const currentMetadata = new Map(metadata.map((row) => [row.variant_id ?? row.id, row]));
  const currentValues = new Map(values.map((row) => [row.variantId ?? row.copilotModel, row]));
  const priorDiagnostics = new Set(active.diagnostics);
  const lostBenchmarks = active.metadata.flatMap((prior) => {
    const id = prior.variant_id ?? prior.id;
    const current = currentMetadata.get(prior.variant_id ?? prior.id);
    const detail = `matching regression: ${id} lost its Artificial Analysis benchmark`;
    return (prior.intelligence_index !== null || priorDiagnostics.has(detail)) && current && current.intelligence_index === null
      ? [id] : [];
  });
  const lostPrices = active.values.flatMap((prior) => {
    const id = prior.variantId ?? prior.copilotModel;
    const current = currentValues.get(prior.variantId ?? prior.copilotModel);
    const detail = `matching regression: ${id} lost its usable GitHub pricing scenario`;
    return (prior.creditsPerTask !== null || priorDiagnostics.has(detail)) && current && current.creditsPerTask === null
      ? [id] : [];
  });
  return [
    ...lostBenchmarks.map((id) => `matching regression: ${id} lost its Artificial Analysis benchmark`),
    ...lostPrices.map((id) => `matching regression: ${id} lost its usable GitHub pricing scenario`),
  ].sort();
}
