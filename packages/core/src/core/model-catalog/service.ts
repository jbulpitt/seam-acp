import { createHash } from "node:crypto";
import { Cron } from "croner";
import type {
  AdapterCatalogCandidate,
  CatalogScope,
  CatalogModel,
  NormalizedCatalogSelection,
  RawCatalogSelection,
} from "@seam/adapters";
import { decodeCatalogSelection, encodeCatalogSelection } from "@seam/adapters";
import { MODEL_CATALOG_SCHEMA_VERSION } from "@seam/adapters";
import type { Logger } from "../../lib/logger.js";
import {
  type CatalogObservationRow,
  type ModelCatalogStore,
  type StoredCatalogSnapshot,
} from "./store.js";

export interface CatalogBinding { agentId: string; location: string }
export type CatalogRefreshReason = "startup" | "scheduled" | "manual";

export interface CatalogRefreshResult {
  binding: CatalogBinding;
  ok: boolean;
  result: "published" | "unchanged" | "retained" | "quarantined" | "unavailable";
  source?: string;
  scope?: string;
  previousGeneration: number | null;
  generation: number | null;
  added: number;
  removed: number;
  changed: number;
  fetchedAt?: string;
  cliVersion?: string;
  sourceVersion?: string;
  error?: string;
}

export interface CatalogLookup {
  state: "ready" | "stale" | "warming" | "drift";
  snapshot: StoredCatalogSnapshot | null;
  observation: CatalogObservationRow | null;
}

export interface ResolvedCatalogSelection {
  normalized: NormalizedCatalogSelection;
  raw: RawCatalogSelection;
  model: CatalogModel;
  generation: number;
}

export interface CatalogPublication {
  binding: CatalogBinding;
  snapshot: StoredCatalogSnapshot;
}

export interface AvailableCatalogModel {
  binding: CatalogBinding;
  model: CatalogModel;
  generation: number;
}

const DEFAULT_REFRESH_CRON = "17 */6 * * *";

export class ModelCatalogService {
  private readonly snapshots = new Map<string, StoredCatalogSnapshot>();
  private readonly observations = new Map<string, CatalogObservationRow>();
  private readonly inFlight = new Map<string, Promise<CatalogRefreshResult>>();
  private readonly fetchInFlight = new Map<string, Promise<AdapterCatalogCandidate>>();
  private readonly collapseConfirmations = new Map<string, string>();
  private readonly publicationListeners = new Set<(event: CatalogPublication) => void>();
  private job?: Cron;
  private stopped = false;

  constructor(private readonly options: {
    store: ModelCatalogStore;
    logger: Logger;
    bindings: () => ReadonlyArray<CatalogBinding>;
    /** Adapter-owned semantic scope; no provider work is allowed here. */
    scope?: (binding: CatalogBinding) => CatalogScope | Promise<CatalogScope>;
    fetch: (binding: CatalogBinding) => Promise<AdapterCatalogCandidate>;
    isOnline?: (binding: CatalogBinding) => boolean;
    now?: () => Date;
    refreshCron?: string;
    concurrency?: number;
  }) {
    for (const snapshot of options.store.loadActive()) {
      try {
        validateCandidate(snapshot.candidate);
        this.snapshots.set(snapshot.scopeKey, deepFreeze(snapshot));
      } catch (err) {
        options.logger.warn({ err, scopeKey: snapshot.scopeKey }, "ignored incompatible stored model catalog generation");
      }
    }
    for (const observation of options.store.loadObservations()) this.observations.set(observation.bindingKey, observation);
  }

  /** Arms cron and queues startup refresh; it never awaits provider work. */
  start(): void {
    if (this.stopped || this.job) return;
    this.job = new Cron(
      this.options.refreshCron ?? DEFAULT_REFRESH_CRON,
      { timezone: "UTC", name: "model-catalog" },
      () => { if (!this.stopped) void this.refreshAll("scheduled"); }
    );
    queueMicrotask(() => { if (!this.stopped) void this.refreshAll("startup"); });
    this.options.logger.info({ nextRunUtc: this.job.nextRun()?.toISOString() }, "model catalog refresh armed");
  }

  stop(): void { this.stopped = true; this.job?.stop(); this.job = undefined; }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values(), ...this.fetchInFlight.values()]);
  }

  knownBindings(): CatalogBinding[] {
    return [...this.observations.values()].map(({ agentId, location }) => ({ agentId, location }));
  }

  /** Cache-only fleet view used by enrichment; drifted bindings contribute nothing. */
  availableModels(): AvailableCatalogModel[] {
    const rows: AvailableCatalogModel[] = [];
    for (const observation of this.observations.values()) {
      if (observation.drift) continue;
      const snapshot = this.snapshots.get(observation.scopeKey);
      if (!snapshot) continue;
      for (const model of snapshot.candidate.models) {
        rows.push({
          binding: { agentId: observation.agentId, location: observation.location },
          model,
          generation: snapshot.generation,
        });
      }
    }
    return rows;
  }

  onPublication(listener: (event: CatalogPublication) => void): () => void {
    this.publicationListeners.add(listener);
    return () => this.publicationListeners.delete(listener);
  }

  lookup(binding: CatalogBinding): CatalogLookup {
    const key = bindingKey(binding);
    const observation = this.observations.get(key) ?? null;
    const snapshot = observation ? this.snapshots.get(observation.scopeKey) ?? null : null;
    if (!snapshot) return { state: "warming", snapshot: null, observation };
    if (observation?.drift) return { state: "drift", snapshot, observation };
    const online = this.options.isOnline?.(binding) ?? true;
    return { state: online ? "ready" : "stale", snapshot, observation };
  }

  models(binding: CatalogBinding): ReadonlyArray<CatalogModel> {
    const lookup = this.lookup(binding);
    return lookup.state === "drift" ? [] : lookup.snapshot?.candidate.models ?? [];
  }

  model(binding: CatalogBinding, idOrAlias: string): CatalogModel | null {
    const wanted = idOrAlias.trim().toLowerCase();
    const models = this.models(binding);
    if (wanted === "default") return models.find((model) => model.default) ?? null;
    return models.find((model) =>
      model.id.toLowerCase() === wanted || model.aliases.some((alias) => alias.toLowerCase() === wanted)
    ) ?? null;
  }

  effortChoices(binding: CatalogBinding, model: string): ReadonlyArray<string> {
    return this.model(binding, model)?.effort.choices.map((choice) => choice.id) ?? [];
  }

  resolve(binding: CatalogBinding, selection: { model: string; effort?: string | null }): ResolvedCatalogSelection {
    const lookup = this.lookup(binding);
    if (!lookup.snapshot) throw new Error(`model catalog for ${bindingKey(binding)} is warming/unavailable`);
    const model = this.model(binding, selection.model);
    if (!model || model.availability !== "available" || model.lifecycle === "retired") {
      throw new Error(`model ${JSON.stringify(selection.model)} is unavailable in catalog generation ${lookup.snapshot.generation}`);
    }
    const effort = selection.effort ?? model.effort.selectionDefault;
    if (!model.effort.choices.some((choice) => choice.id === effort)) {
      throw new Error(
        `effort ${JSON.stringify(effort)} is unsupported for model ${JSON.stringify(model.id)} in catalog generation ${lookup.snapshot.generation}; refusing catalog/runtime drift`
      );
    }
    const normalized = { model: model.id, effort };
    return { normalized, raw: encodeCatalogSelection(model, normalized), model, generation: lookup.snapshot.generation };
  }

  decode(binding: CatalogBinding, raw: RawCatalogSelection): NormalizedCatalogSelection | null {
    return decodeCatalogSelection(this.models(binding), raw);
  }

  refresh(binding: CatalogBinding, reason: CatalogRefreshReason = "manual"): Promise<CatalogRefreshResult> {
    const key = bindingKey(binding);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.refreshInner(binding, reason).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  async refreshAll(reason: CatalogRefreshReason = "manual"): Promise<CatalogRefreshResult[]> {
    const bindings = uniqueBindings(this.options.bindings());
    const concurrency = Math.max(1, this.options.concurrency ?? 3);
    const results: CatalogRefreshResult[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < bindings.length) {
        const binding = bindings[cursor++]!;
        results.push(await this.refresh(binding, reason));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, bindings.length) }, worker));
    return results;
  }

  private async refreshInner(binding: CatalogBinding, _reason: CatalogRefreshReason): Promise<CatalogRefreshResult> {
    const key = bindingKey(binding);
    const prior = this.lookup(binding).snapshot;
    const attemptedAt = (this.options.now?.() ?? new Date()).toISOString();
    const base = { binding, previousGeneration: prior?.generation ?? null, generation: prior?.generation ?? null, added: 0, removed: 0, changed: 0 };
    if (this.options.isOnline && !this.options.isOnline(binding)) {
      const error = "host offline; previous snapshot retained";
      this.options.store.recordAttempt({ bindingKey: key, attemptedAt, result: "unavailable", error, source: null, candidateChecksum: null });
      return { ...base, ok: Boolean(prior), result: "unavailable", error };
    }
    try {
      const candidate = await this.fetchCandidate(binding);
      validateCandidate(candidate);
      const checksum = candidateChecksum(candidate);
      const desiredScope = trustworthyFingerprint(candidate.scope.fingerprint)
        ? `scope:${candidate.scope.fingerprint}` : `binding:${key}`;
      const activeForScope = this.snapshots.get(desiredScope);
      const currentObservation = this.observations.get(key);
      // A binding that last observed the active generation is allowed to move
      // the canonical scope forward. Peer observations may legitimately lag
      // by several generations; treating those as conflicts made A→B→C fail
      // as soon as another host still reported A. A binding that did *not*
      // observe the active generation may only catch up to it; a divergent
      // candidate is quarantined until equivalence is re-established.
      const ownsActive = Boolean(
        activeForScope && currentObservation?.scopeKey === desiredScope &&
        currentObservation.checksum === activeForScope.checksum &&
        !currentObservation.drift
      );
      const drift = activeForScope && checksum !== activeForScope.checksum && !ownsActive
        ? `catalog conflicts with active generation ${activeForScope.generation}; binding quarantined`
        : null;
      const scopeKey = desiredScope;
      const priorForScope = this.snapshots.get(scopeKey) ?? prior;
      const diff = diffModels(priorForScope?.candidate.models ?? [], candidate.models);
      if (drift) {
        const observation: CatalogObservationRow = {
          bindingKey: key, agentId: binding.agentId, location: binding.location,
          scopeKey, checksum, adapterVersion: candidate.adapterVersion,
          schemaVersion: candidate.schemaVersion,
          cliVersion: candidate.cliVersion ?? null,
          sourceVersion: candidate.sourceVersion ?? null,
          source: candidate.source, fetchedAt: candidate.fetchedAt, drift,
        };
        this.options.store.recordObservation(observation);
        this.options.store.recordAttempt({ bindingKey: key, attemptedAt, result: "quarantined", error: drift, source: candidate.source, candidateChecksum: checksum });
        this.observations.set(key, observation);
        return {
          ...base,
          ...diff,
          ok: false,
          result: "quarantined",
          scope: scopeKey,
          generation: priorForScope?.generation ?? null,
          source: candidate.source,
          fetchedAt: candidate.fetchedAt,
          cliVersion: candidate.cliVersion,
          sourceVersion: candidate.sourceVersion,
          error: drift,
        };
      }
      if (isCollapsed(priorForScope?.candidate.models ?? [], candidate.models)) {
        const priorConfirmation = this.collapseConfirmations.get(key) ?? this.options.store.getRefreshStatus(key)?.candidateChecksum;
        if (priorConfirmation !== checksum) {
          this.collapseConfirmations.set(key, checksum);
          const error = `candidate coverage collapsed (${candidate.models.length}/${priorForScope!.candidate.models.length}); repeat identical refresh required`;
          this.options.store.recordAttempt({ bindingKey: key, attemptedAt, result: "quarantined", error, source: candidate.source, candidateChecksum: checksum });
          return { ...base, ...diff, ok: false, result: "quarantined", source: candidate.source, scope: scopeKey, fetchedAt: candidate.fetchedAt, cliVersion: candidate.cliVersion, sourceVersion: candidate.sourceVersion, error };
        }
      }
      this.collapseConfirmations.delete(key);
      const observation: CatalogObservationRow = {
        bindingKey: key, agentId: binding.agentId, location: binding.location,
        scopeKey, checksum, adapterVersion: candidate.adapterVersion,
        schemaVersion: candidate.schemaVersion,
        cliVersion: candidate.cliVersion ?? null,
        sourceVersion: candidate.sourceVersion ?? null,
        source: candidate.source,
        fetchedAt: candidate.fetchedAt, drift,
      };
      if (priorForScope?.checksum === checksum) {
        this.options.store.recordObservation(observation);
        this.options.store.recordAttempt({ bindingKey: key, attemptedAt, result: "unchanged", error: drift, source: candidate.source, candidateChecksum: checksum });
        this.observations.set(key, observation);
        return { ...base, ok: !drift, result: "unchanged", source: candidate.source, scope: scopeKey, generation: priorForScope.generation, fetchedAt: candidate.fetchedAt, cliVersion: candidate.cliVersion, sourceVersion: candidate.sourceVersion, ...(drift ? { error: drift } : {}) };
      }
      const snapshot = this.options.store.publish({ scopeKey, checksum, candidate, publishedAt: attemptedAt, observation });
      this.options.store.recordAttempt({ bindingKey: key, attemptedAt, result: "published", error: drift, source: candidate.source, candidateChecksum: checksum });
      this.snapshots.set(scopeKey, deepFreeze(snapshot));
      this.observations.set(key, observation);
      for (const listener of this.publicationListeners) {
        try {
          listener({ binding, snapshot: this.snapshots.get(scopeKey)! });
        } catch (err) {
          this.options.logger.warn({ err, binding: key }, "model catalog publication listener failed");
        }
      }
      this.options.logger.info({ binding: key, scopeKey, generation: snapshot.generation, ...diff, drift }, "model catalog published");
      return { ...base, ...diff, ok: !drift, result: "published", source: candidate.source, scope: scopeKey, generation: snapshot.generation, fetchedAt: candidate.fetchedAt, cliVersion: candidate.cliVersion, sourceVersion: candidate.sourceVersion, ...(drift ? { error: drift } : {}) };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      this.options.store.recordAttempt({ bindingKey: key, attemptedAt, result: "retained", error, source: null, candidateChecksum: null });
      this.options.logger.warn({ err: caught, binding: key }, "model catalog refresh failed; previous snapshot retained");
      return { ...base, ok: false, result: "retained", error };
    }
  }

  private async fetchCandidate(binding: CatalogBinding): Promise<AdapterCatalogCandidate> {
    // Scope discovery is adapter-owned and provider-work-free, so equivalent
    // cold bindings share the very first provider/CLI fetch as well as all
    // later refreshes. Old embedders without the scope hook conservatively use
    // a prior observation or isolate by binding.
    const observedScope = this.observations.get(bindingKey(binding))?.scopeKey;
    const declared = this.options.scope ? await this.options.scope(binding) : null;
    const scopeKey = declared && trustworthyFingerprint(declared.fingerprint)
      ? `scope:${declared.fingerprint}`
      : observedScope ?? `binding:${bindingKey(binding)}`;
    const existing = this.fetchInFlight.get(scopeKey);
    if (existing) return existing;
    const promise = this.options.fetch(binding).then((candidate) => {
      if (
        declared && trustworthyFingerprint(declared.fingerprint) &&
        candidate.scope.fingerprint !== declared.fingerprint
      ) {
        throw new Error(
          `adapter catalog scope changed during fetch (${declared.fingerprint} → ${candidate.scope.fingerprint})`
        );
      }
      return candidate;
    }).finally(() => this.fetchInFlight.delete(scopeKey));
    this.fetchInFlight.set(scopeKey, promise);
    return promise;
  }
}

export function bindingKey(binding: CatalogBinding): string { return `${binding.agentId}@${binding.location}`; }

function uniqueBindings(bindings: ReadonlyArray<CatalogBinding>): CatalogBinding[] {
  return [...new Map(bindings.map((binding) => [bindingKey(binding), binding])).values()];
}

export function validateCandidate(candidate: AdapterCatalogCandidate): void {
  if (!candidate || typeof candidate !== "object") throw new Error("catalog candidate is malformed");
  if (candidate.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
    throw new Error(`unsupported model catalog schema ${String(candidate.schemaVersion)}`);
  }
  if (!Array.isArray(candidate.models) || !candidate.models.length) throw new Error("active provider catalog candidate is empty");
  if (!candidate.scope || typeof candidate.scope !== "object" || typeof candidate.scope.fingerprint !== "string") {
    throw new Error("catalog scope is malformed");
  }
  if (
    typeof candidate.scope.provider !== "string" || !candidate.scope.provider.trim() ||
    typeof candidate.source !== "string" || !candidate.source.trim()
  ) {
    throw new Error("catalog scope/source is malformed");
  }
  if (!Number.isInteger(candidate.adapterVersion) || candidate.adapterVersion < 1) throw new Error("invalid adapter version");
  if (!candidate.fetchedAt || !Number.isFinite(Date.parse(candidate.fetchedAt))) throw new Error("invalid catalog fetch time");
  const ids = new Set<string>();
  const names = new Set<string>();
  const rawSelections = new Set<string>();
  let defaults = 0;
  for (const model of candidate.models) {
    if (
      typeof model.id !== "string" || !model.id.trim() ||
      typeof model.runtimeId !== "string" || !model.runtimeId.trim() ||
      typeof model.displayName !== "string" || !model.displayName.trim() ||
      ids.has(model.id)
    ) {
      throw new Error(`duplicate or malformed model id ${JSON.stringify(model.id)}`);
    }
    if (typeof model.default !== "boolean" || !Array.isArray(model.aliases) || model.aliases.some((alias) => typeof alias !== "string")) {
      throw new Error(`malformed aliases for ${model.id}`);
    }
    ids.add(model.id);
    for (const name of [model.id, ...model.aliases]) {
      const normalized = name.trim().toLowerCase();
      if (!normalized || names.has(normalized)) throw new Error(`duplicate or malformed model id/alias ${JSON.stringify(name)}`);
      names.add(normalized);
    }
    if (model.default) defaults += 1;
    if (!model.context || typeof model.context !== "object") throw new Error(`invalid context window for ${model.id}`);
    const values = [model.context.native, model.context.maximum, model.context.effective].filter((value): value is number => value !== null);
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error(`invalid context window for ${model.id}`);
    if (model.context.native && model.context.maximum && model.context.native > model.context.maximum) throw new Error(`native context exceeds maximum for ${model.id}`);
    if (model.context.effective && model.context.maximum && model.context.effective > model.context.maximum) throw new Error(`effective context exceeds maximum for ${model.id}`);
    if (
      !model.modalities ||
      !validStringList(model.modalities.input, true) ||
      !validStringList(model.modalities.output, true) ||
      !["native", "tool", "none"].includes(model.visionMode) ||
      !["available", "unavailable"].includes(model.availability) ||
      !["stable", "preview", "deprecated", "retired"].includes(model.lifecycle) ||
      !["live", "reload", "freshSession"].includes(model.applicationMode) ||
      !validStringList(model.serviceTiers, false)
    ) {
      throw new Error(`malformed capability declaration for ${model.id}`);
    }
    if (
      !model.effort || !["meta", "configOption", "spawnArgs", "modelBaked", "none"].includes(model.effort.mechanism) ||
      !Array.isArray(model.effort.choices) || typeof model.effort.selectionDefault !== "string"
    ) {
      throw new Error(`malformed effort declaration for ${model.id}`);
    }
    const choices = model.effort.choices.map((choice) => choice.id);
    if (
      model.effort.choices.some((choice) =>
        !choice || typeof choice.id !== "string" || !choice.id.trim() ||
        (choice.raw !== undefined && typeof choice.raw !== "string")) ||
      !choices.length || new Set(choices).size !== choices.length ||
      !choices.includes(model.effort.selectionDefault)
    ) {
      throw new Error(`malformed effort declaration for ${model.id}`);
    }
    if (model.effort.mechanism === "configOption" && !model.effort.configId) throw new Error(`configOption effort missing configId for ${model.id}`);
    if (!Array.isArray(model.bindings) || model.bindings.length !== choices.length) {
      throw new Error(`invalid raw selection bindings for ${model.id}`);
    }
    for (const effort of choices) {
      const matches = model.bindings.filter((binding) => binding.model === model.id && binding.effort === effort);
      if (
        matches.length !== 1 || typeof matches[0]!.rawModel !== "string" || !matches[0]!.rawModel.trim() ||
        (matches[0]!.rawEffort !== undefined && typeof matches[0]!.rawEffort !== "string")
      ) {
        throw new Error(`invalid raw selection binding for ${model.id}/${effort}`);
      }
      const rawKey = JSON.stringify([matches[0]!.rawModel, matches[0]!.rawEffort ?? null]);
      if (rawSelections.has(rawKey)) throw new Error(`ambiguous reverse binding for ${model.id}/${effort}`);
      rawSelections.add(rawKey);
    }
  }
  if (defaults !== 1) throw new Error(`catalog requires exactly one default model (found ${defaults})`);
}

function validStringList(value: unknown, requireNonEmpty: boolean): value is string[] {
  return Array.isArray(value) && (!requireNonEmpty || value.length > 0) &&
    value.every((entry) => typeof entry === "string" && Boolean(entry.trim())) &&
    new Set(value).size === value.length;
}

function trustworthyFingerprint(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function candidateChecksum(candidate: AdapterCatalogCandidate): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: candidate.schemaVersion,
    scope: candidate.scope,
    models: candidate.models,
  })).digest("hex");
}
function isCollapsed(before: ReadonlyArray<CatalogModel>, after: ReadonlyArray<CatalogModel>): boolean { return before.length >= 4 && after.length < Math.ceil(before.length / 2); }
function diffModels(before: ReadonlyArray<CatalogModel>, after: ReadonlyArray<CatalogModel>): { added: number; removed: number; changed: number } {
  const a = new Map(before.map((model) => [model.id, JSON.stringify(model)]));
  const b = new Map(after.map((model) => [model.id, JSON.stringify(model)]));
  return {
    added: [...b.keys()].filter((id) => !a.has(id)).length,
    removed: [...a.keys()].filter((id) => !b.has(id)).length,
    changed: [...b].filter(([id, row]) => a.has(id) && a.get(id) !== row).length,
  };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
