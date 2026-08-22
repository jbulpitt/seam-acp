import { describe, it, expect } from "vitest";
import { pickerModelsForProfile } from "@seam/adapters";

describe("pickerModelsForProfile", () => {
  it("returns empty when no profile", async () => {
    expect(await pickerModelsForProfile(null)).toEqual([]);
    expect(await pickerModelsForProfile(undefined)).toEqual([]);
  });

  it("prefers staticModels over listPickerModels", async () => {
    const models = await pickerModelsForProfile({
      staticModels: [{ modelId: "a", name: "A" }],
      listPickerModels: async () => [{ modelId: "b", name: "B" }],
    });
    expect(models).toEqual([{ modelId: "a", name: "A" }]);
  });

  it("uses listPickerModels when staticModels is empty", async () => {
    const models = await pickerModelsForProfile({
      staticModels: [],
      listPickerModels: async () => [{ modelId: "gemini-3-flash", name: "Gemini 3 Flash" }],
    });
    expect(models).toEqual([{ modelId: "gemini-3-flash", name: "Gemini 3 Flash" }]);
  });

  it("swallows listPickerModels failures", async () => {
    const models = await pickerModelsForProfile({
      listPickerModels: async () => {
        throw new Error("catalog down");
      },
    });
    expect(models).toEqual([]);
  });

  it("caps the list", async () => {
    const models = await pickerModelsForProfile(
      {
        staticModels: Array.from({ length: 30 }, (_, i) => ({
          modelId: `m${i}`,
          name: `M${i}`,
        })),
      },
      24
    );
    expect(models).toHaveLength(24);
  });
});
