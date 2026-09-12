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
import {
  assertCatalogSemantics,
  assessCatalogReduction,
  catalogContentChecksum,
  catalogModelFingerprint,
  catalogReductionFingerprint,
  DEFAULT_CATALOG_REDUCTION_POLICY,
  MODEL_CATALOG_MIN_SUPPORTED_SCHEMA_VERSION,
  MODEL_CATALOG_SCHEMA_VERSION,
  parseCatalogEvidenceList,
  assertCatalogDescription,
  normalizeCatalogCandidate,
  upgradeCatalogCandidate,
  validateCatalogEvidence,
  type CatalogReductionPolicy,
} from "@seam/adapters";
import type { Logger } from "../../lib/logger.js";
import {
  catalogBindingContinuityFingerprint,
  type CatalogObservationRow,
  type ModelCatalogStore,
  type StoredCatalogSnapshot,
} from "./store.js";

export interface CatalogBinding { agentId: string; location: string }
export type CatalogRefreshReason = "startup" | "scheduled" | "manual";

export interface CatalogRefreshOptions {
  /**
   * Operator acceptance of a quarantined reduction (#236). Bounded by
   * construction: it applies to this ONE refresh of this ONE binding and is
   * never persisted, so a legitimate provider retirement can be admitted
   * without permanently disarming the protection.
   */
  acceptReduction?: boolean;
  /** Operator identity recorded on an accepted reduction, for the audit trail. */
  actor?: string;
}

/** Why a candidate was held back, surfaced to status and manual refresh. */
export interface CatalogReductionReport {
  removed: string[];
  rule: "small-catalog" | "collapse";
  reason: string;
  confirmationRequired: boolean;
}

/**
 * A peer disagreement, reported rather than enforced (#339 rules 7-8, 13-14).
 *
 * Both sides are named because "they disagree" is not actionable: an operator
 * needs to know which generation, which wrapper versions, and which models
 * actually differ before they can decide whether anything is wrong at all.
 * Usually nothing is — two hosts on different wrapper versions genuinely have
 * different capabilities, and both descriptions are true.
 */
export interface CatalogConflictReport {
  /** The shared scope this binding stopped using. */
  peerScope: string;
  peerGeneration: number;
  peerChecksum: string;
  peerCliVersion: string | null;
  peerSourceVersion: string | null;
  cliVersion: string | null;
  sourceVersion: string | null;
  /** Model ids only this binding has, only the peer has, and that differ. */
  differs: { onlyHere: string[]; onlyPeer: string[]; changed: string[] };
}

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
  /** Present when a reduction was assessed (held, or accepted by an operator). */
  reduction?: CatalogReductionReport;
  /** True only when an operator explicitly bypassed a reduction quarantine. */
  acceptedReduction?: true;
  /** Who accepted it, for the audit trail. */
  acceptedBy?: string;
  /**
   * Rule 13: which mode this binding is in. `shared` names the scope it shares;
   * `binding-local` is the default and is a correct description of one host.
   */
  mode?: "shared" | "binding-local";
  /** Rule 8: present when a peer disagreed. Never a failure; both keep serving. */
  conflict?: CatalogConflictReport;
}

export interface CatalogLookup {
  /**
   * #339 rule 6: a binding holding a valid catalog is never unavailable.
   *
   * There used to be a `drift` state here, entered when a PEER disagreed, and
   * it made `models()` return [] — so a healthy host lost every model,
   * including `default`, because a different host described itself
   * differently. Peer disagreement is now a report on the refresh result; it
   * has no state of its own because it is not a state of this binding.
   */
  state: "ready" | "stale" | "warming";
  snapshot: StoredCatalogSnapshot | null;
  observation: CatalogObservationRow | null;
}

export interface ResolvedCatalogSelection {
  normalized: NormalizedCatalogSelection;
  raw: RawCatalogSelection;
  /** Null when no catalog entry backed this resolution (#339 rules 15-17). */
  model: CatalogModel | null;
  /** Null when no catalog generation backed this resolution. */
  generation: number | null;
  /**
   * How much was actually verified, so a display can be truthful about it:
   * `binding` — this binding's own catalog listed the model;
   * `borrowed` — another binding's catalog did, and is named in `borrowedFrom`;
   * `unverified` — no catalog anywhere; the id is passed through as typed.
   */
  verification: "binding" | "borrowed" | "unverified";
  borrowedFrom?: CatalogBinding;
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

export interface CatalogFleetBinding {
  binding: CatalogBinding;
  state: CatalogLookup["state"];
  snapshot: StoredCatalogSnapshot | null;
}

interface FetchedCatalogCandidate {
  candidate: AdapterCatalogCandidate;
  /** Binding whose adapter actually performed the scope-shared provider work. */
  fetchedBy: string;
}

const DEFAULT_REFRESH_CRON = "17 */6 * * *";

export class ModelCatalogService {
  private readonly snapshots = new Map<string, StoredCatalogSnapshot>();
  private readonly observations = new Map<string, CatalogObservationRow>();
  private readonly inFlight = new Map<string, Promise<CatalogRefreshResult>>();
  private readonly fetchInFlight = new Map<string, Promise<FetchedCatalogCandidate>>();
  private readonly reductionConfirmations = new Map<string, string>();
  private readonly reductionPolicy: CatalogReductionPolicy;
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
    /** Generic, provider-neutral reduction thresholds (#236). */
    reductionPolicy?: CatalogReductionPolicy;
  }) {
    this.reductionPolicy = options.reductionPolicy ?? DEFAULT_CATALOG_REDUCTION_POLICY;
    for (const snapshot of options.store.loadActive()) {
      try {
        // Normalize forward before validating so a snapshot written by an older
        // (still supported) schema keeps serving instead of cold-starting.
        const upgraded = upgradeCatalogCandidate(snapshot.candidate);
        if (!upgraded) throw new Error(`unsupported model catalog schema ${String(snapshot.candidate?.schemaVersion)}`);
        // Same boundary on the way IN: a snapshot written before this policy
        // existed is sanitized as it loads rather than serving a raw value.
        const normalized = normalizeCatalogCandidate(upgraded);
        validateCandidate(normalized);
        this.snapshots.set(snapshot.scopeKey, deepFreeze({ ...snapshot, candidate: normalized }));
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

  /** Cache-only fleet view used by enrichment. */
  availableModels(): AvailableCatalogModel[] {
    const rows: AvailableCatalogModel[] = [];
    for (const observation of this.observations.values()) {
      // #339 rule 5: no binding's availability depends on another's state, so a
      // historical peer-conflict marker no longer removes this binding's models.
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

  /** Complete cache-only input for coordinated enrichment (#249). */
  fleetSnapshot(): CatalogFleetBinding[] {
    const configured = uniqueBindings([
      ...this.options.bindings(),
      ...this.knownBindings(),
    ]);
    return configured.map((binding) => {
      const lookup = this.lookup(binding);
      return { binding, state: lookup.state, snapshot: lookup.snapshot };
    }).sort((a, b) => bindingKey(a.binding).localeCompare(bindingKey(b.binding)));
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
    const online = this.options.isOnline?.(binding) ?? true;
    return { state: online ? "ready" : "stale", snapshot, observation };
  }

  models(binding: CatalogBinding): ReadonlyArray<CatalogModel> {
    return this.lookup(binding).snapshot?.candidate.models ?? [];
  }

  /**
   * Rule 16: another binding's catalog for the same agent, as a labeled HINT.
   *
   * Only consulted when this binding has none of its own, and never presented
   * as this binding's catalog — the caller gets `verification: "borrowed"` and
   * the lending binding's name so the display can say "not verified on this
   * host". Rule 18 makes it temporary: the first real session publishes this
   * binding's own catalog and the borrowing stops.
   */
  hint(binding: CatalogBinding): { from: CatalogBinding; models: ReadonlyArray<CatalogModel> } | null {
    if (this.lookup(binding).snapshot) return null;
    for (const observation of this.observations.values()) {
      if (observation.agentId !== binding.agentId) continue;
      if (observation.location === binding.location) continue;
      const snapshot = this.snapshots.get(observation.scopeKey);
      if (!snapshot?.candidate.models.length) continue;
      return {
        from: { agentId: observation.agentId, location: observation.location },
        models: snapshot.candidate.models,
      };
    }
    return null;
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
    // #339 rule 15 (and the fix for #326). This used to throw
    // "model catalog is warming/unavailable", which is a bootstrap deadlock: a
    // binding can only obtain a catalog by running a session, and could only
    // run a session once it had one. A whole host became unable to accept work
    // because a cache was cold — the worst available outcome when starting on
    // `default` was right there.
    //
    // So a missing catalog no longer blocks a turn. What is refused shrinks to
    // the thing actually in doubt: we cannot say the model is listed, so we say
    // exactly that in `verification` and let the provider answer. Rule 17: our
    // gate is the binding constraint and it is ours to relax; downstream a
    // model id is a string we pass through, and `profiles/claude.ts`
    // substitutes nothing, so an unknown id fails cleanly rather than silently
    // running something else.
    if (!lookup.snapshot) return this.resolveWithoutOwnCatalog(binding, selection);
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
    return {
      normalized,
      raw: encodeCatalogSelection(model, normalized),
      model,
      generation: lookup.snapshot.generation,
      verification: "binding",
    };
  }

  /**
   * Resolve for a binding that has no catalog of its own (#339 rules 15-18).
   *
   * Order of preference, best available outcome first: a peer's entry for the
   * same agent (rules 16-17 — real evidence the id exists for this provider,
   * labeled as borrowed), then a bare pass-through (rule 15 — `default` must
   * always start, and a typed id is a string the provider will judge).
   *
   * Nothing here is permanent: rule 18 says the first real session publishes
   * this binding's own catalog, after which `lookup().snapshot` exists and this
   * path stops being reached. One turn, no operator action.
   */
  private resolveWithoutOwnCatalog(
    binding: CatalogBinding,
    selection: { model: string; effort?: string | null }
  ): ResolvedCatalogSelection {
    const wanted = selection.model.trim();
    const hint = this.hint(binding);
    if (hint) {
      const lowered = wanted.toLowerCase();
      const model = lowered === "default" || !lowered
        ? hint.models.find((entry) => entry.default)
        : hint.models.find((entry) =>
            entry.id.toLowerCase() === lowered ||
            entry.aliases.some((alias) => alias.toLowerCase() === lowered));
      if (model && model.availability === "available" && model.lifecycle !== "retired") {
        const effort = selection.effort ?? model.effort.selectionDefault;
        // An effort the borrowed entry does not list is not proof this host
        // rejects it, but we have nothing better to offer, so fall back to the
        // borrowed default rather than refusing the turn.
        const usable = model.effort.choices.some((choice) => choice.id === effort)
          ? effort
          : model.effort.selectionDefault;
        const normalized = { model: model.id, effort: usable };
        return {
          normalized,
          raw: encodeCatalogSelection(model, normalized),
          model,
          generation: null,
          verification: "borrowed",
          borrowedFrom: hint.from,
        };
      }
    }
    // Rule 15: `default` is always startable. The provider picks its own.
    // Empty effort means "the caller named none and we have no catalog to take
    // a default from" — the provider applies its own, exactly as it does for a
    // bare `default`. Inventing an effort id here would be a silent wrong
    // answer rather than an honest absence.
    const normalized = { model: wanted || "default", effort: selection.effort ?? "" };
    return {
      normalized,
      raw: { model: normalized.model, ...(normalized.effort ? { effort: normalized.effort } : {}) },
      model: null,
      generation: null,
      verification: "unverified",
      ...(hint ? { borrowedFrom: hint.from } : {}),
    };
  }

  decode(binding: CatalogBinding, raw: RawCatalogSelection): NormalizedCatalogSelection | null {
    return decodeCatalogSelection(this.models(binding), raw);
  }

  refresh(
    binding: CatalogBinding,
    reason: CatalogRefreshReason = "manual",
    opts: CatalogRefreshOptions = {}
  ): Promise<CatalogRefreshResult> {
    const key = bindingKey(binding);
    // An accepting refresh must not be satisfied by an in-flight non-accepting
    // one (or vice versa), so acceptance is part of the single-flight identity.
    const flightKey = opts.acceptReduction ? `${key}|accept` : key;
    const existing = this.inFlight.get(flightKey);
    if (existing) return existing;
    if (this.stopped) {
      const prior = this.lookup(binding).snapshot;
      return Promise.resolve({
        binding,
        ok: Boolean(prior),
        result: "unavailable",
        previousGeneration: prior?.generation ?? null,
        generation: prior?.generation ?? null,
        added: 0,
        removed: 0,
        changed: 0,
        error: "model catalog refresh is stopped",
      });
    }
    const promise = this.refreshInner(binding, reason, opts).finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, promise);
    return promise;
  }

  async refreshAll(
    reason: CatalogRefreshReason = "manual",
    opts: CatalogRefreshOptions = {}
  ): Promise<CatalogRefreshResult[]> {
    if (this.stopped) return [];
    const bindings = uniqueBindings(this.options.bindings());
    const concurrency = Math.max(1, this.options.concurrency ?? 3);
    const results: CatalogRefreshResult[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < bindings.length) {
        const binding = bindings[cursor++]!;
        results.push(await this.refresh(binding, reason, opts));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, bindings.length) }, worker));
    return results;
  }

  private async refreshInner(
    binding: CatalogBinding,
    _reason: CatalogRefreshReason,
    opts: CatalogRefreshOptions = {}
  ): Promise<CatalogRefreshResult> {
    const key = bindingKey(binding);
    const accepted = opts.acceptReduction === true;
    const prior = this.lookup(binding).snapshot;
    const attemptedAt = (this.options.now?.() ?? new Date()).toISOString();
    const base = { binding, previousGeneration: prior?.generation ?? null, generation: prior?.generation ?? null, added: 0, removed: 0, changed: 0 };
    if (this.options.isOnline && !this.options.isOnline(binding)) {
      const error = "host offline; previous snapshot retained";
      // An unavailable host is NOT an independent confirming observation.
      // Without this, quarantine -> offline -> identical candidate published
      // immediately, defeating the whole confirmation gate.
      this.clearReductionConfirmation(key);
      this.options.store.recordAttempt({ bindingKey: key, attemptedAt, result: "unavailable", error, source: null, candidateChecksum: null });
      return { ...base, ok: Boolean(prior), result: "unavailable", error };
    }
    try {
      const { candidate: fetched, fetchedBy } = await this.fetchCandidate(binding);
      // The portable screen runs again here: a candidate may have arrived over
      // the bridge, and a remote host is not a trust boundary we defer past.
      // Normalization returns the sanitized, canonically ordered candidate that
      // is what actually gets checksummed and persisted.
      const candidate = normalizeCatalogCandidate(fetched);
      validateCandidate(candidate);
      const checksum = candidateChecksum(candidate);
      const declaredScope = shareableScope(candidate.scope)
        ? `scope:${candidate.scope.fingerprint}` : `binding:${key}`;
      const bindingMigration = this.options.store.pendingBindingMigration(key);
      // #339 rule 2 says sharing must be PROVEN, and a recorded binding
      // migration is the strongest proof in the system: single-use, bound to a
      // named source binding, an exact active generation and checksum, and a
      // content continuity fingerprint. A binding RENAME changes the
      // binding-local key by construction, so without honouring that proof the
      // rename would silently abandon the published generation it exists to
      // carry forward. Labels still prove nothing; this is not a label.
      const migrationScope =
        bindingMigration?.targetBindingKey === key &&
        bindingMigration.scopeKey &&
        this.snapshots.has(bindingMigration.scopeKey)
          ? bindingMigration.scopeKey
          : null;
      const desiredScope = migrationScope ?? declaredScope;
      const activeForScope = this.snapshots.get(desiredScope);
      const sourceObservation = this.observations.get(fetchedBy);
      const migrationProof = Boolean(
        fetchedBy === key && activeForScope && bindingMigration &&
        bindingMigration.targetBindingKey === key &&
        bindingMigration.scopeKey === desiredScope &&
        bindingMigration.source === candidate.source &&
        bindingMigration.activeGeneration === activeForScope.generation &&
        bindingMigration.activeChecksum === activeForScope.checksum &&
        bindingMigration.continuityFingerprint === catalogBindingContinuityFingerprint(candidate)
      );
      // A candidate fetched by a binding that last observed the active
      // generation may move the canonical scope forward. Fetch provenance is
      // load-bearing when equivalent bindings share one in-flight operation:
      // a stale peer winning that race must not let an active waiter legitimize
      // its old candidate. Lagging peers may catch up to the active checksum;
      // any other divergence is quarantined until equivalence is re-established.
      const fetchedFromActive = Boolean(
        activeForScope && sourceObservation?.scopeKey === desiredScope &&
        sourceObservation.checksum === activeForScope.checksum &&
        !sourceObservation.drift
      ) || migrationProof;
      // #339 rules 7-10. Disagreeing with a peer used to quarantine THIS
      // binding: `models()` returned [] and even `default` stopped resolving,
      // so a host that was working perfectly lost its models because a
      // different host described itself differently. That is the blast-radius
      // defect in AGENTS.md — the doubt was about the shared generation, and
      // the thing refused was the whole binding.
      //
      // Disagreement is an observation, not a fault. macbook-air advertising
      // 0.70.0 while local advertises 0.75.1 is TRUE information. So the
      // disagreeing binding stops sharing, publishes what its own adapter
      // actually reported under its own key, and both sides keep serving. It
      // is also how recovery becomes unilateral (rule 10): the next valid
      // refresh publishes, with no peer change and no operator action.
      const conflict = activeForScope && checksum !== activeForScope.checksum && !fetchedFromActive
        ? {
            peerScope: desiredScope,
            peerGeneration: activeForScope.generation,
            peerChecksum: activeForScope.checksum,
            peerCliVersion: activeForScope.candidate.cliVersion ?? null,
            peerSourceVersion: activeForScope.candidate.sourceVersion ?? null,
            cliVersion: candidate.cliVersion ?? null,
            sourceVersion: candidate.sourceVersion ?? null,
            differs: describeCatalogDifference(activeForScope.candidate.models, candidate.models),
          }
        : null;
      // Rule 8: the binding demotes ITSELF to binding-local rather than losing
      // its catalog. Deleting this line restores quarantine-on-disagreement and
      // with it the outage; nothing else re-establishes availability here.
      const scopeKey = conflict ? `binding:${key}` : desiredScope;
      const drift: string | null = null;
      const priorForScope = this.snapshots.get(scopeKey) ?? prior;
      const diff = diffModels(priorForScope?.candidate.models ?? [], candidate.models);
      if (conflict) {
        // Rule 14: "they disagree" is not actionable. Name both catalogs, both
        // wrapper versions, and what actually differs.
        this.options.logger.warn(
          {
            binding: key,
            mode: "binding-local",
            demotedFrom: conflict.peerScope,
            peerGeneration: conflict.peerGeneration,
            thisCliVersion: conflict.cliVersion,
            peerCliVersion: conflict.peerCliVersion,
            thisSourceVersion: conflict.sourceVersion,
            peerSourceVersion: conflict.peerSourceVersion,
            differs: conflict.differs,
          },
          "model catalog disagrees with a peer; serving this binding's own catalog"
        );
      }
      // Rule 13: every refresh says which mode it is in, so "binding-local" is
      // visible as a state of the system rather than inferred from silence.
      const report = {
        mode: scopeKey.startsWith("scope:") ? ("shared" as const) : ("binding-local" as const),
        ...(conflict ? { conflict } : {}),
      };
      // Reduction quarantine (#236). A candidate that DROPS a published model
      // is held until a second, independent, identical refresh confirms it —
      // or until an operator explicitly accepts it. Additions and
      // metadata-only edits are never held. The comparison is against the
      // durable active generation and lives here, in the service, so no
      // provider can opt itself out.
      const reduction = assessCatalogReduction(
        priorForScope?.candidate.models ?? [],
        candidate.models,
        this.reductionPolicy
      );
      let acceptedReduction: CatalogReductionReport | undefined;
      if (reduction) {
        // Confirmation identity EXCLUDES volatile observation timestamps, so
        // two independent sightings of the same reduced catalog match. A plain
        // checksum never would: `observedAt`/`fetchedAt` move every fetch.
        const fingerprint = catalogReductionFingerprint(candidate);
        const priorGeneration = priorForScope?.generation ?? 0;
        if (accepted) {
          acceptedReduction = { ...reduction, confirmationRequired: false };
          this.clearReductionConfirmation(key);
        } else if (!this.matchesReductionQuarantine(key, {
          scopeKey, priorGeneration, rule: reduction.rule, removed: reduction.removed, fingerprint,
        })) {
          // Typed state, not a bare checksum: only a PRIOR reduction quarantine
          // of the SAME reduction against the SAME prior generation may confirm.
          this.reductionConfirmations.set(key, fingerprint);
          this.options.store.recordReductionQuarantine({
            bindingKey: key, scopeKey, priorGeneration, rule: reduction.rule,
            removed: reduction.removed, fingerprint, observedAt: attemptedAt,
          });
          const error =
            `${reduction.reason}; quarantined pending confirmation — ` +
            `repeat an identical refresh to confirm, or accept it explicitly ` +
            `(\`/seamadmin catalog refresh … accept-reduction:true\`)`;
          this.options.store.recordAttempt({ bindingKey: key, attemptedAt, result: "quarantined", error, source: candidate.source, candidateChecksum: checksum });
          return { ...base, ...diff, ok: false, result: "quarantined", source: candidate.source, scope: scopeKey, fetchedAt: candidate.fetchedAt, cliVersion: candidate.cliVersion, sourceVersion: candidate.sourceVersion, error, reduction: { ...reduction, confirmationRequired: true } };
        }
      }
      this.clearReductionConfirmation(key);
      const observation: CatalogObservationRow = {
        bindingKey: key, agentId: binding.agentId, location: binding.location,
        scopeKey, checksum, adapterVersion: candidate.adapterVersion,
        schemaVersion: candidate.schemaVersion,
        cliVersion: candidate.cliVersion ?? null,
        sourceVersion: candidate.sourceVersion ?? null,
        source: candidate.source,
        fetchedAt: candidate.fetchedAt, drift,
      };
      const bindingMigrationProof = migrationProof && bindingMigration && activeForScope
        ? {
            migrationId: bindingMigration.migrationId,
            targetBindingKey: key,
            scopeKey,
            activeGeneration: activeForScope.generation,
            activeChecksum: activeForScope.checksum,
            completedAt: attemptedAt,
          }
        : undefined;
      if (priorForScope?.checksum === checksum) {
        this.options.store.recordObservation(observation, bindingMigrationProof);
        this.options.store.recordAttempt({ bindingKey: key, attemptedAt, result: "unchanged", error: drift, source: candidate.source, candidateChecksum: checksum });
        this.observations.set(key, observation);
        return { ...base, ...report, ok: !drift, result: "unchanged", source: candidate.source, scope: scopeKey, generation: priorForScope.generation, fetchedAt: candidate.fetchedAt, cliVersion: candidate.cliVersion, sourceVersion: candidate.sourceVersion, ...(drift ? { error: drift } : {}) };
      }
      const snapshot = this.options.store.publish({
        scopeKey,
        checksum,
        candidate,
        publishedAt: attemptedAt,
        observation,
        ...(bindingMigrationProof ? { bindingMigrationProof } : {}),
      });
      // #236: an operator-accepted reduction is durably distinguishable from an
      // ordinary publication, so an audit can tell a bypass from a normal one.
      this.options.store.recordAttempt({
        bindingKey: key, attemptedAt,
        result: acceptedReduction ? "published-accepted-reduction" : "published",
        error: acceptedReduction
          ? `operator accepted reduction${opts.actor ? ` by ${opts.actor}` : ""}: ${acceptedReduction.reason}`
          : drift,
        source: candidate.source, candidateChecksum: checksum,
      });
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
      return {
        ...base, ...diff, ...report, ok: !drift, result: "published", source: candidate.source, scope: scopeKey,
        generation: snapshot.generation, fetchedAt: candidate.fetchedAt,
        cliVersion: candidate.cliVersion, sourceVersion: candidate.sourceVersion,
        ...(acceptedReduction
          ? {
              reduction: acceptedReduction,
              acceptedReduction: true as const,
              ...(opts.actor ? { acceptedBy: opts.actor } : {}),
            }
          : {}),
        ...(drift ? { error: drift } : {}),
      };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      // A failed observation is NOT a confirmation. Clearing here is what makes
      // "quarantine → transient failure → same reduced candidate" require two
      // fresh identical observations again rather than sliding through on the
      // strength of one earlier sighting.
      this.clearReductionConfirmation(key);
      this.options.store.recordAttempt({ bindingKey: key, attemptedAt, result: "retained", error, source: null, candidateChecksum: null });
      this.options.logger.warn({ err: caught, binding: key }, "model catalog refresh failed; previous snapshot retained");
      return { ...base, ok: false, result: "retained", error };
    }
  }

  /**
   * A stored quarantine confirms a candidate only when EVERY dimension matches:
   * same scope, same prior generation, same rule, same removed set, same
   * substantive fingerprint. A bare checksum comparison (the previous shape)
   * would let an unrelated attempt's recorded checksum act as a confirmation.
   */
  private matchesReductionQuarantine(
    key: string,
    want: { scopeKey: string; priorGeneration: number; rule: string; removed: string[]; fingerprint: string }
  ): boolean {
    const inMemory = this.reductionConfirmations.get(key);
    const stored = this.options.store.getReductionQuarantine(key);
    if (!stored) return false;
    return (
      stored.fingerprint === want.fingerprint &&
      stored.scopeKey === want.scopeKey &&
      stored.priorGeneration === want.priorGeneration &&
      stored.rule === want.rule &&
      stored.removed.length === want.removed.length &&
      stored.removed.every((id, index) => id === want.removed[index]) &&
      (inMemory === undefined || inMemory === want.fingerprint)
    );
  }

  /** Called on EVERY non-qualifying attempt: offline, drift, failure, different. */
  private clearReductionConfirmation(key: string): void {
    this.reductionConfirmations.delete(key);
    this.options.store.clearReductionQuarantine(key);
  }

  private async fetchCandidate(binding: CatalogBinding): Promise<FetchedCatalogCandidate> {
    // #339 rules 11-12: dedupe concurrent refreshes of the SAME binding, and
    // never across a binding boundary.
    //
    // This used to key the in-flight map by scope, so two bindings that merely
    // looked equivalent shared one provider fetch — and then one host's answer
    // was published as the other's. Saving a probe is not worth asserting an
    // equivalence we cannot prove. Bindings that genuinely do share a scope
    // still share the published generation; they just each ask for it.
    const declared = this.options.scope ? await this.options.scope(binding) : null;
    const fetchKey = bindingKey(binding);
    const existing = this.fetchInFlight.get(fetchKey);
    if (existing) return existing;
    const promise = this.options.fetch(binding).then((candidate) => {
      if (
        declared && (
          candidate.scope.sharing !== declared.sharing ||
          (trustworthyFingerprint(declared.fingerprint) && candidate.scope.fingerprint !== declared.fingerprint)
        )
      ) {
        throw new Error(
          `adapter catalog scope changed during fetch (${declared.fingerprint} → ${candidate.scope.fingerprint})`
        );
      }
      return { candidate, fetchedBy: fetchKey };
    }).finally(() => this.fetchInFlight.delete(fetchKey));
    this.fetchInFlight.set(fetchKey, promise);
    return promise;
  }
}

export function bindingKey(binding: CatalogBinding): string { return `${binding.agentId}@${binding.location}`; }

function uniqueBindings(bindings: ReadonlyArray<CatalogBinding>): CatalogBinding[] {
  return [...new Map(bindings.map((binding) => [bindingKey(binding), binding])).values()];
}

export function validateCandidate(candidate: AdapterCatalogCandidate): void {
  if (!candidate || typeof candidate !== "object") throw new Error("catalog candidate is malformed");
  // Exact-key closure AND declared-value policy for the WHOLE graph, at the
  // CORE boundary too — not only at the bridge. Strict by design: everything
  // reaching here has already been through `normalizeCatalogCandidate`, so a
  // surviving raw path/PII/credential value means the boundary was bypassed.
  validateCatalogEvidence(candidate);
  // A RANGE, not an equality (#236). Accepting only the exact current version
  // meant the next schema bump would discard every durable last-known-good
  // snapshot on deploy and turn an upgrade into a cold-cache outage.
  if (
    !Number.isInteger(candidate.schemaVersion) ||
    candidate.schemaVersion < MODEL_CATALOG_MIN_SUPPORTED_SCHEMA_VERSION ||
    candidate.schemaVersion > MODEL_CATALOG_SCHEMA_VERSION
  ) {
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
  // Cross-row identity (duplicate ids, id/alias collisions, ambiguous reverse
  // bindings, exactly-one-default) is the SHARED provider-neutral rule that the
  // bridge boundary also applies, so a collision can never reach transport and
  // then be caught only here. The per-row checks below stay as a defence in
  // depth against a caller that reached validateCandidate directly.
  assertCatalogSemantics(candidate);
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
    if (model.description !== undefined) assertCatalogDescription(`${model.id}.description`, model.description);
    validateEvidence(model.id, model.evidence);
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

/**
 * Per-model description/evidence validation delegates to the ONE portable
 * parser in adapters (#236), so core, the bridge boundary, and any future
 * consumer cannot drift into three slightly different screens.
 */
function validateEvidence(modelId: string, evidence: unknown): void {
  if (evidence === undefined) return;
  parseCatalogEvidenceList(`${modelId}.evidence`, evidence);
}

function validStringList(value: unknown, requireNonEmpty: boolean): value is string[] {
  return Array.isArray(value) && (!requireNonEmpty || value.length > 0) &&
    value.every((entry) => typeof entry === "string" && Boolean(entry.trim())) &&
    new Set(value).size === value.length;
}

function trustworthyFingerprint(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
/**
 * #339 rules 1-3: a catalog is binding-local unless the adapter PROVES sharing.
 *
 * This was `scope.sharing !== "binding"`, which treated silence as proof and
 * made label equality — provider name, config-directory name — stand in for
 * runtime equivalence. It does not: two hosts carrying the same label ran
 * `claude-agent-acp` 0.70.0 and 0.75.1 and advertised different capabilities.
 *
 * Refusing to share costs a duplicate probe. Sharing wrongly costs a host its
 * models. Binding-local is a correct description of one host, not a degraded
 * mode, so it is the default and the burden is on the claim to share.
 */
function shareableScope(scope: CatalogScope): boolean {
  return scope.sharing === "shared" && trustworthyFingerprint(scope.fingerprint);
}
/** Canonical, key-order-independent content identity (#236). */
function candidateChecksum(candidate: AdapterCatalogCandidate): string {
  return catalogContentChecksum(candidate);
}
/** Rule 14: what actually differs, in model ids an operator can look up. */
function describeCatalogDifference(
  peer: ReadonlyArray<CatalogModel>,
  here: ReadonlyArray<CatalogModel>
): { onlyHere: string[]; onlyPeer: string[]; changed: string[] } {
  const a = new Map(peer.map((model) => [model.id, catalogModelFingerprint(model)]));
  const b = new Map(here.map((model) => [model.id, catalogModelFingerprint(model)]));
  return {
    onlyHere: [...b.keys()].filter((id) => !a.has(id)).sort(),
    onlyPeer: [...a.keys()].filter((id) => !b.has(id)).sort(),
    changed: [...b].filter(([id, row]) => a.has(id) && a.get(id) !== row).map(([id]) => id).sort(),
  };
}

function diffModels(before: ReadonlyArray<CatalogModel>, after: ReadonlyArray<CatalogModel>): { added: number; removed: number; changed: number } {
  // Canonical per-model identity: a property reordering is not a change.
  const a = new Map(before.map((model) => [model.id, catalogModelFingerprint(model)]));
  const b = new Map(after.map((model) => [model.id, catalogModelFingerprint(model)]));
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
