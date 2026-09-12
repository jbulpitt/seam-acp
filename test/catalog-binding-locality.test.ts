/**
 * #339 — catalogs belong to one binding, and disagreement never costs
 * availability.
 *
 * A catalog was keyed by a *scope* meant to mean "same credentials, same
 * runtime, same advertised capabilities", derived from labels — provider name,
 * config-directory name — that prove none of that. `macbook-air` runs
 * `claude-agent-acp` 0.70.0 while `local` and `home-hub` run 0.75.1, so one
 * label covered two different sets of capabilities.
 *
 * That scope did two jobs: fetch deduplication (an optimisation) and drift
 * detection (a safety check). When they conflicted, availability lost — on
 * 2026-09-11 a healthy binding was quarantined until even `default` was
 * unavailable, because a DIFFERENT binding disagreed with it. This is the
 * blast-radius rule in AGENTS.md: the doubt was about one shared generation
 * and the thing refused was an entire host.
 *
 * These tests pin the three properties that were wrong independently of each
 * other: sharing must be proven, disagreement must not quarantine, and a
 * missing catalog must not block a turn (#326's bootstrap deadlock).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catalogScopeFingerprint,
  type AdapterCatalogCandidate,
  type CatalogModel,
} from "@seam/adapters";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = pino({ level: "silent" }) as unknown as Logger;
const dirs: string[] = [];
const stores: ModelCatalogStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function newStore(): ModelCatalogStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-339-"));
  dirs.push(dir);
  const store = new ModelCatalogStore(path.join(dir, "seam.db"));
  stores.push(store);
  return store;
}

function model(id: string, isDefault: boolean): CatalogModel {
  const choices = [{ id: "low", raw: "L" }, { id: "high", raw: "H" }];
  return {
    id,
    runtimeId: `vendor::${id}`,
    displayName: `Model ${id}`,
    aliases: [`alias-${id}`],
    default: isDefault,
    context: { native: 200_000, maximum: 200_000, effective: 200_000 },
    modalities: { input: ["text"], output: ["text"] },
    visionMode: "none",
    availability: "available",
    lifecycle: "stable",
    serviceTiers: ["standard"],
    effort: { mechanism: "configOption", configId: "effort", choices, selectionDefault: "low" },
    pricingCategory: "standard",
    compatibility: "v1",
    applicationMode: "live",
    bindings: choices.map((choice) => ({
      model: id, effort: choice.id, rawModel: `vendor::${id}`, rawEffort: choice.raw,
    })),
  };
}

function candidate(opts: {
  ids?: string[];
  sharing?: "shared" | "binding";
  cliVersion?: string;
  fetchedAt?: string;
} = {}): AdapterCatalogCandidate {
  const ids = opts.ids ?? ["sonnet", "opus"];
  return {
    schemaVersion: 1,
    scope: {
      fingerprint: catalogScopeFingerprint({ provider: "fixture", credentialProfile: "acct" }),
      provider: "fixture",
      credentialProfile: "acct",
      ...(opts.sharing ? { sharing: opts.sharing } : {}),
    },
    models: ids.map((id, index) => model(id, index === 0)),
    source: "fixture-probe",
    sourceVersion: "catalog/v1",
    adapterVersion: 1,
    cliVersion: opts.cliVersion ?? "claude-agent-acp 0.75.1",
    fetchedAt: opts.fetchedAt ?? "2026-09-11T12:00:00.000Z",
  };
}

function service(opts: {
  store: ModelCatalogStore;
  fetch: (binding: { agentId: string; location: string }) => Promise<AdapterCatalogCandidate>;
  bindings?: Array<{ agentId: string; location: string }>;
}): ModelCatalogService {
  return new ModelCatalogService({
    store: opts.store,
    logger,
    bindings: () => opts.bindings ?? [],
    fetch: opts.fetch,
    refreshCron: "0 0 1 1 *",
  });
}

const local = { agentId: "claude", location: "local" };
const air = { agentId: "claude", location: "macbook-air" };

describe("#339 catalogs are binding-local and disagreement never costs availability", () => {
  it("keeps both bindings serving when a peer disagrees, and names both sides", async () => {
    // Rule 8, the headline. Two hosts on different wrapper versions, both
    // declaring a shared scope — so this is the case where the old code had
    // something to quarantine. `local` publishes first; `macbook-air` then
    // reports a genuinely different catalog.
    const store = newStore();
    const catalog = service({
      store,
      bindings: [local, air],
      fetch: async (binding) => binding.location === "local"
        ? candidate({ ids: ["sonnet", "opus"], sharing: "shared", cliVersion: "claude-agent-acp 0.75.1" })
        : candidate({ ids: ["sonnet"], sharing: "shared", cliVersion: "claude-agent-acp 0.70.0" }),
    });

    await catalog.refresh(local);
    const disagreement = await catalog.refresh(air);

    // It is an observation, not a fault (rule 7).
    expect(disagreement.ok).toBe(true);
    expect(disagreement.result).toBe("published");

    // Rule 14: both catalogs, both wrapper versions, and what differs.
    expect(disagreement.conflict).toMatchObject({
      peerGeneration: 1,
      cliVersion: "claude-agent-acp 0.70.0",
      peerCliVersion: "claude-agent-acp 0.75.1",
    });
    expect(disagreement.conflict?.differs.onlyPeer).toEqual(["opus"]);
    // Rule 13: the mode is reported, not inferred from silence.
    expect(disagreement.mode).toBe("binding-local");

    // ZERO loss of availability, on either side (rules 5, 6, 8). This is the
    // assertion the mutation in the PR body targets: restoring
    // quarantine-on-disagreement empties `macbook-air` and `default` with it.
    expect(catalog.models(air).map((entry) => entry.id)).toEqual(["sonnet"]);
    expect(catalog.models(local).map((entry) => entry.id)).toEqual(["sonnet", "opus"]);
    expect(catalog.lookup(air).state).toBe("ready");
    expect(catalog.resolve(air, { model: "default" }).normalized.model).toBe("sonnet");
    expect(catalog.resolve(air, { model: "sonnet" }).verification).toBe("binding");
    expect(catalog.resolve(local, { model: "opus" }).normalized.model).toBe("opus");
  });

  it("recovers unilaterally on the next valid refresh, with no peer change", async () => {
    // Rule 10. The disagreeing binding repairs itself; nothing has to happen on
    // the peer and no operator has to intervene.
    const store = newStore();
    let airIds = ["sonnet"];
    const catalog = service({
      store,
      bindings: [local, air],
      fetch: async (binding) => binding.location === "local"
        ? candidate({ ids: ["sonnet", "opus"], sharing: "shared" })
        : candidate({ ids: airIds, sharing: "shared", cliVersion: "claude-agent-acp 0.70.0" }),
    });
    await catalog.refresh(local);
    await catalog.refresh(air);
    expect(catalog.models(air).map((entry) => entry.id)).toEqual(["sonnet"]);

    airIds = ["sonnet", "opus", "haiku"];
    const repaired = await catalog.refresh(air);
    expect(repaired.ok).toBe(true);
    expect(catalog.models(air).map((entry) => entry.id)).toEqual(["sonnet", "opus", "haiku"]);
    // The peer was never touched.
    expect(catalog.models(local).map((entry) => entry.id)).toEqual(["sonnet", "opus"]);
  });

  it("serves two same-label bindings independently when neither proves sharing", async () => {
    // Rules 1-3. Neither candidate declares `sharing`, and silence is no longer
    // read as proof, so the two never collide at all — the disagreement above
    // cannot even arise in the default configuration.
    const store = newStore();
    const catalog = service({
      store,
      bindings: [local, air],
      fetch: async (binding) => binding.location === "local"
        ? candidate({ ids: ["sonnet", "opus"], cliVersion: "claude-agent-acp 0.75.1" })
        : candidate({ ids: ["sonnet"], cliVersion: "claude-agent-acp 0.70.0" }),
    });
    const first = await catalog.refresh(local);
    const second = await catalog.refresh(air);

    expect([first.result, second.result]).toEqual(["published", "published"]);
    expect([first.mode, second.mode]).toEqual(["binding-local", "binding-local"]);
    expect(first.scope).toBe("binding:claude@local");
    expect(second.scope).toBe("binding:claude@macbook-air");
    expect(second.conflict).toBeUndefined();
    expect(catalog.models(local).map((entry) => entry.id)).toEqual(["sonnet", "opus"]);
    expect(catalog.models(air).map((entry) => entry.id)).toEqual(["sonnet"]);
  });

  it("never coalesces two bindings' provider fetches", async () => {
    // Rules 11-12. Even with a proven shared scope, each binding asks its own
    // adapter: one host's answer must never be published as another's.
    const store = newStore();
    const fetch = vi.fn(async () => candidate({ sharing: "shared" }));
    const catalog = service({ store, bindings: [local, air], fetch });
    await Promise.all([catalog.refresh(local), catalog.refresh(air)]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("starts a turn on default with no catalog at all, then learns its own", async () => {
    // Rule 15 — the #326 bootstrap deadlock. `resolve()` used to throw
    // "model catalog is warming/unavailable", so a binding could only get a
    // catalog by running a session and could only run a session with a
    // catalog. A whole host became unable to accept work because a cache was
    // cold, when starting on `default` was right there.
    const store = newStore();
    const catalog = service({ store, bindings: [local], fetch: async () => candidate() });
    expect(catalog.lookup(local).state).toBe("warming");

    const cold = catalog.resolve(local, { model: "default" });
    expect(cold.normalized.model).toBe("default");
    expect(cold.verification).toBe("unverified");
    expect(cold.generation).toBeNull();
    expect(cold.model).toBeNull();
    // The raw selection is a plain pass-through: the provider applies its own
    // default, exactly as it does for any `default` request.
    expect(cold.raw).toEqual({ model: "default" });

    // Rule 18: one real session and the binding has its own catalog.
    await catalog.refresh(local);
    const warm = catalog.resolve(local, { model: "default" });
    expect(warm.verification).toBe("binding");
    expect(warm.normalized.model).toBe("sonnet");
    expect(warm.generation).toBe(1);
  });

  it("keeps peer entries as display hints, not typed-selection normalization", async () => {
    // Rules 16-17 still provide display hints. #366 keeps typed selection
    // independent: a peer cannot normalize a model for this account/host.
    const store = newStore();
    const catalog = service({
      store,
      bindings: [local, air],
      fetch: async () => candidate({ ids: ["sonnet", "opus"] }),
    });
    await catalog.refresh(local);

    const borrowed = catalog.resolve(air, { model: "opus" });
    expect(borrowed.verification).toBe("unverified");
    expect(borrowed.borrowedFrom).toBeUndefined();
    expect(borrowed.normalized.model).toBe("opus");
    // Not presented as this binding's catalog: it has none.
    expect(catalog.models(air)).toEqual([]);
    expect(catalog.lookup(air).state).toBe("warming");
    expect(catalog.hint(air)?.from).toEqual(local);
    // And a binding that HAS its own catalog never borrows.
    expect(catalog.hint(local)).toBeNull();

    // Rule 18 again: its own session replaces the hint.
    await catalog.refresh(air);
    expect(catalog.resolve(air, { model: "opus" }).verification).toBe("binding");
  });

  it("still quarantines a binding's OWN bad catalog", async () => {
    // Rule 9. Loosening peer conflict must not loosen this: an unexplained
    // reduction in a binding's own catalog is held until a second identical
    // refresh confirms it, or an operator accepts it.
    const store = newStore();
    let ids = ["sonnet", "opus", "haiku", "fable"];
    const catalog = service({ store, bindings: [local], fetch: async () => candidate({ ids }) });
    await catalog.refresh(local);
    ids = ["sonnet"];
    const held = await catalog.refresh(local);
    expect(held.result).toBe("quarantined");
    expect(held.reduction?.confirmationRequired).toBe(true);
    // The last known-good catalog keeps serving while it is held.
    expect(catalog.models(local).map((entry) => entry.id))
      .toEqual(["sonnet", "opus", "haiku", "fable"]);
  });
});
