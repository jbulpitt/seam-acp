import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

describe("/seamadmin catalog refresh", () => {
  it("runs a durable manual refresh and reports provenance, generation, and failure", async () => {
    const refresh = vi.fn(async () => ({
      binding: { agentId: "fake", location: "remote-a" },
      ok: false,
      result: "quarantined" as const,
      source: "fake-adapter-probe",
      scope: `scope:${"f".repeat(64)}`,
      previousGeneration: 4,
      generation: 4,
      added: 1,
      removed: 0,
      changed: 2,
      fetchedAt: "2026-09-08T12:00:00.000Z",
      sourceVersion: "catalog/v17",
      cliVersion: "fake-cli 9",
      error: "runtime/catalog drift",
      reduction: {
        removed: ["gone-1"],
        rule: "small-catalog" as const,
        reason: "candidate drops 1 of 2 published model(s) (gone-1) from a small catalog",
        confirmationRequired: true,
      },
    }));
    const replies: string[] = [];
    const edits: string[] = [];
    const self = Object.create(Orchestrator.prototype) as Record<string, unknown>;
    Object.assign(self, {
      config: { SEAM_CONFIG_ADMIN_USER_IDS: new Set(["admin"]) },
      modelCatalog: { refresh, refreshAll: vi.fn() },
    });
    const interaction = {
      user: { id: "admin" },
      options: { getString: () => "fake@remote-a", getBoolean: () => null },
      reply: vi.fn(async ({ content }: { content: string }) => { replies.push(content); }),
      editReply: vi.fn(async ({ content }: { content: string }) => { edits.push(content); }),
    };
    await (Orchestrator.prototype as unknown as {
      cmdCatalogRefresh(this: unknown, i: unknown): Promise<void>;
    }).cmdCatalogRefresh.call(self, interaction);
    expect(replies[0]).toContain("Refreshing model catalog");
    expect(refresh).toHaveBeenCalledWith(
      { agentId: "fake", location: "remote-a" },
      "manual",
      { acceptReduction: false, actor: "admin" }
    );
    expect(edits[0]).toContain("generation 4 → 4");
    expect(edits[0]).toContain("fake-adapter-probe");
    expect(edits[0]).toContain("catalog/v17 / fake-cli 9");
    expect(edits[0]).toContain(`scope scope:${"f".repeat(64)}`);
    expect(edits[0]).toContain("runtime/catalog drift");
    // #236: a quarantined reduction must say what it held and how to admit it,
    // otherwise the operator cannot act on it.
    expect(edits[0]).toContain("held back: small-catalog rule — removes gone-1");
    expect(edits[0]).toContain("accept-reduction:true");
  });

  it("passes bounded operator acceptance through to the service", async () => {
    const refresh = vi.fn(async () => ({
      binding: { agentId: "fake", location: "remote-a" },
      ok: true,
      result: "published" as const,
      previousGeneration: 4,
      generation: 5,
      added: 0,
      removed: 1,
      changed: 0,
    }));
    const self = Object.create(Orchestrator.prototype) as Record<string, unknown>;
    Object.assign(self, {
      config: { SEAM_CONFIG_ADMIN_USER_IDS: new Set(["admin"]) },
      modelCatalog: { refresh, refreshAll: vi.fn() },
    });
    const replies: string[] = [];
    const interaction = {
      user: { id: "admin" },
      options: { getString: () => "fake@remote-a", getBoolean: () => true },
      reply: vi.fn(async ({ content }: { content: string }) => { replies.push(content); }),
      editReply: vi.fn(async () => {}),
    };
    await (Orchestrator.prototype as unknown as {
      cmdCatalogRefresh(this: unknown, i: unknown): Promise<void>;
    }).cmdCatalogRefresh.call(self, interaction);
    expect(refresh).toHaveBeenCalledWith(
      { agentId: "fake", location: "remote-a" },
      "manual",
      { acceptReduction: true, actor: "admin" }
    );
    expect(replies[0]).toContain("accepting a quarantined reduction");
  });

  it("refuses accept-reduction combined with agent:all", async () => {
    // One click must not admit every simultaneous fleet reduction; the bypass
    // is bounded to ONE explicit binding.
    const refresh = vi.fn();
    const refreshAll = vi.fn();
    const replies: string[] = [];
    const self = Object.create(Orchestrator.prototype) as Record<string, unknown>;
    Object.assign(self, {
      config: { SEAM_CONFIG_ADMIN_USER_IDS: new Set(["admin"]) },
      modelCatalog: { refresh, refreshAll },
    });
    const interaction = {
      user: { id: "admin" },
      options: { getString: () => "all", getBoolean: () => true },
      reply: vi.fn(async ({ content }: { content: string }) => { replies.push(content); }),
      editReply: vi.fn(async () => {}),
    };
    await (Orchestrator.prototype as unknown as {
      cmdCatalogRefresh(this: unknown, i: unknown): Promise<void>;
    }).cmdCatalogRefresh.call(self, interaction);
    expect(refresh).not.toHaveBeenCalled();
    expect(refreshAll).not.toHaveBeenCalled();
    expect(replies[0]).toMatch(/requires one explicit/);
  });

  it("reports an accepted reduction as an operator override in the response", async () => {
    const refresh = vi.fn(async () => ({
      binding: { agentId: "fake", location: "remote-a" },
      ok: true,
      result: "published" as const,
      previousGeneration: 4,
      generation: 5,
      added: 0,
      removed: 1,
      changed: 0,
      acceptedReduction: true as const,
      acceptedBy: "admin",
      reduction: {
        removed: ["gone-1"],
        rule: "small-catalog" as const,
        reason: "candidate drops 1 of 2 published model(s) (gone-1) from a small catalog",
        confirmationRequired: false,
      },
    }));
    const edits: string[] = [];
    const self = Object.create(Orchestrator.prototype) as Record<string, unknown>;
    Object.assign(self, {
      config: { SEAM_CONFIG_ADMIN_USER_IDS: new Set(["admin"]) },
      modelCatalog: { refresh, refreshAll: vi.fn() },
    });
    const interaction = {
      user: { id: "admin" },
      options: { getString: () => "fake@remote-a", getBoolean: () => true },
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async ({ content }: { content: string }) => { edits.push(content); }),
    };
    await (Orchestrator.prototype as unknown as {
      cmdCatalogRefresh(this: unknown, i: unknown): Promise<void>;
    }).cmdCatalogRefresh.call(self, interaction);
    expect(edits[0]).toContain("operator-accepted reduction");
    expect(edits[0]).toContain("gone-1");
    expect(edits[0]).toContain("accepted by <@admin>");
  });
});
