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
      options: { getString: () => "fake@remote-a" },
      reply: vi.fn(async ({ content }: { content: string }) => { replies.push(content); }),
      editReply: vi.fn(async ({ content }: { content: string }) => { edits.push(content); }),
    };
    await (Orchestrator.prototype as unknown as {
      cmdCatalogRefresh(this: unknown, i: unknown): Promise<void>;
    }).cmdCatalogRefresh.call(self, interaction);
    expect(replies[0]).toContain("Refreshing model catalog");
    expect(refresh).toHaveBeenCalledWith(
      { agentId: "fake", location: "remote-a" },
      "manual"
    );
    expect(edits[0]).toContain("generation 4 → 4");
    expect(edits[0]).toContain("fake-adapter-probe");
    expect(edits[0]).toContain("catalog/v17 / fake-cli 9");
    expect(edits[0]).toContain(`scope scope:${"f".repeat(64)}`);
    expect(edits[0]).toContain("runtime/catalog drift");
  });
});
