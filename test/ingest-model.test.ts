import { describe, expect, it } from "vitest";
import { ingestMintStoredModel } from "../packages/core/src/core/choice/ingest-model.js";

describe("ingestMintStoredModel", () => {
  it("stores only an explicit pin so omitted values resolve the catalog default at fire", () => {
    expect(ingestMintStoredModel("default")).toBe("default");
    expect(ingestMintStoredModel("model-from-catalog")).toBe("model-from-catalog");
    expect(ingestMintStoredModel(undefined)).toBeNull();
    expect(ingestMintStoredModel(null)).toBeNull();
    expect(ingestMintStoredModel("")).toBeNull();
    expect(ingestMintStoredModel("  ")).toBeNull();
  });
});
