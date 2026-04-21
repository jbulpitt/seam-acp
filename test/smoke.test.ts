import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("env is sane", () => {
    expect(typeof process.version).toBe("string");
  });
});
