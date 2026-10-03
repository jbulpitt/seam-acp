import { describe, expect, it } from "vitest";
import * as dotenv from "dotenv";
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { readdirSync } from "node:fs";
import { loadConfig } from "../packages/core/src/config.js";

describe("non-live environment", () => {
  it("starts with only test runner and fixture environment", () => {
    expect(Object.keys(process.env).sort()).toEqual([
      "HOME", "NODE_ENV", "PATH", "SEAM_SLOT_HOLDER_PATH", "TZ", "VITEST",
      "VITEST_POOL_ID", "VITEST_WORKER_ID",
    ].sort());
    expect(process.env.PATH).toBe([path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter));
    expect(process.env.TZ).toBe("UTC");
    expect(readdirSync(os.homedir())).toEqual([]);
  });

  it("does not load dotenv or borrow required config from the operator", () => {
    expect(dotenv.config()).toBeUndefined();
    expect(() => loadConfig()).toThrow("DISCORD_BOT_TOKEN");
    expect(() => loadConfig()).toThrow("DISCORD_ALLOWED_USER_IDS");
  });
});
