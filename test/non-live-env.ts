import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { createTestHolderScope } from "./helpers/test-slot-holders.mjs";

// Production imports must not read the operator's .env in non-live tests.
vi.mock("dotenv", async importOriginal => ({
  ...await importOriginal<typeof import("dotenv")>(),
  config: vi.fn(),
}));
vi.mock("dotenv/config", () => ({}));

// Deprioritise workers so live agent turns remain responsive.
try {
  os.setPriority(0, 15);
} catch {
  // Priority is an optimisation, never a test precondition.
}

// Keep only Vitest's worker identity; application values belong to fixtures.
for (const key of Object.keys(process.env)) {
  if (key !== "VITEST_POOL_ID" && key !== "VITEST_WORKER_ID") delete process.env[key];
}
process.env.VITEST = "true";
process.env.NODE_ENV = "test";
process.env.PATH = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter);
process.env.TZ = "UTC";
const home = mkdtempSync(path.join(os.tmpdir(), "seam-test-home-"));
process.env.HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

let holderScope: Awaited<ReturnType<typeof createTestHolderScope>> | undefined;
beforeEach(async () => {
  holderScope = await createTestHolderScope();
  process.env.SEAM_SLOT_HOLDER_PATH = holderScope.holderPath;
});
afterEach(async () => {
  await holderScope?.close();
  holderScope = undefined;
});
