import { describe, expect, it } from "vitest";
import { OLLAMA_CLOUD_STATIC_MODELS } from "../packages/core/src/config.js";

describe("Ollama Cloud model catalog", () => {
  it("offers GLM 5.3 Cloud with its native context window", () => {
    expect(OLLAMA_CLOUD_STATIC_MODELS[0]).toEqual({
      modelId: "glm-5.3:cloud",
      name: "GLM 5.3",
      contextLimit: 1_000_000,
    });
  });
});
