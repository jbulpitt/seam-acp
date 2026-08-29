import { describe, expect, it } from "vitest";
import { OLLAMA_CLOUD_STATIC_MODELS } from "../packages/core/src/config.js";

describe("Ollama Cloud model catalog", () => {
  it("offers GLM 5.3 Cloud with its native context window", () => {
    expect(OLLAMA_CLOUD_STATIC_MODELS[0]).toEqual({
      modelId: "glm-5.3:cloud",
      name: "GLM 5.3",
      contextLimit: 1_000_000,
      visionMode: "tool",
    });
  });

  it("offers GLM 5.3 Flash as the native-vision alternative", () => {
    expect(OLLAMA_CLOUD_STATIC_MODELS[1]).toEqual({
      modelId: "glm-5.3-flash:cloud",
      name: "GLM 5.3 Flash",
      contextLimit: 1_000_000,
      visionMode: "native",
    });
  });
});
