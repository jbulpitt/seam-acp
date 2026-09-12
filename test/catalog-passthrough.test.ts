import { describe, expect, it } from "vitest";
import { passthroughCases, passthroughCatalog } from "./catalog-passthrough-fixture.js";

describe("#366 execution shares configuration evidence policy", () => {
  it.each(passthroughCases)("$name", async fixture => {
    const cache = await passthroughCatalog(fixture.warm);
    try {
      if (!fixture.warm) expect(cache.generationRows()).toBe(0);
      const resolve = () => cache.catalog.resolve(cache.binding, { model: fixture.typed });
      if (!fixture.allowed) { expect(resolve).toThrow(/unavailable/); return; }
      expect(resolve()).toMatchObject({
        normalized: { model: fixture.name === "available-alias" ? "known" : fixture.typed },
        raw: { model: fixture.name === "available-alias" ? "known" : fixture.typed },
        verification: fixture.name === "available-alias" ? "binding" : "unverified",
      });
    } finally { cache.close(); }
  });

  it("a peer hint cannot normalize default or an alias for claude@macbook-pro", async () => {
    const cache = await passthroughCatalog(false);
    try {
      await cache.catalog.refresh({ agentId: "claude", location: "local" });
      expect(cache.catalog.hint(cache.binding)).not.toBeNull();
      expect(cache.catalog.lookup(cache.binding).snapshot).toBeNull();
      for (const model of ["default", "Known-Alias", "My-Typed-Model"]) {
        expect(cache.catalog.resolve(cache.binding, { model })).toMatchObject({
          normalized: { model }, raw: { model }, verification: "unverified", model: null,
        });
      }
    } finally { cache.close(); }
  });
});
