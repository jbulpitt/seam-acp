import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, vi } from "vitest";

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

// sessiond runs each slot's child under a slot holder (#631); in tests that
// holder runs from source.
process.env.SEAM_SLOT_HOLDER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers/slot-holder-source.mjs");
