import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import defaultConfig from "../vitest.config.js";
import liveConfig from "../vitest.int.config.js";
import { shouldRunLiveAcpTest } from "./test-suite-boundary.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("test suite billing boundary", () => {
  it("excludes live integration files from the default suite", () => {
    expect(defaultConfig.test?.include).toContain("test/**/*.test.ts");
    expect(defaultConfig.test?.exclude).toContain("test/**/*.int.test.ts");
  });

  it("gives live integration files a named, explicit opt-in suite", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["test:int"]).toBe(
      "vitest run --config vitest.int.config.ts"
    );
    expect(packageJson.scripts?.pretest).toBe(
      "node scripts/report-test-scope.mjs non-live"
    );
    expect(packageJson.scripts?.["pretest:int"]).toBe(
      "node scripts/report-test-scope.mjs live"
    );
    expect(liveConfig.test?.include).toEqual(["test/**/*.int.test.ts"]);
    expect(liveConfig.test?.env?.SEAM_LIVE_ACP).toBe("1");
  });

  it("does not even inspect the installed CLI without explicit opt-in", () => {
    const copilotAvailable = vi.fn(() => true);

    expect(shouldRunLiveAcpTest(undefined, copilotAvailable)).toBe(false);
    expect(shouldRunLiveAcpTest("0", copilotAvailable)).toBe(false);
    expect(copilotAvailable).not.toHaveBeenCalled();
  });

  it("requires both explicit opt-in and an installed CLI", () => {
    expect(shouldRunLiveAcpTest("1", () => true)).toBe(true);
    expect(shouldRunLiveAcpTest("1", () => false)).toBe(false);
  });
});
