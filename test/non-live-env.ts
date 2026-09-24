import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Deprioritise this worker against live agent turns.
//
// This host has 4 cores and the suite is launched BY agent turns, so it shares
// seam-acp's cgroup and cgroup weighting cannot separate the two. nice can, and
// doing it HERE rather than in the npm script covers every invocation —
// `npm test`, `npx vitest run`, watch mode, and an editor's runner — because
// this setup file executes inside each pool worker.
//
// Lowering one's own priority never requires privilege. Raising it does, which
// is why the other half lives in seam-acp's systemd unit (Nice=-5): together
// they leave a 20-point gap so a human waiting on a streamed reply wins.
try {
  os.setPriority(0, 15);
} catch {
  // Priority is an optimisation, never a test precondition. A platform or
  // sandbox that refuses it must not fail the suite.
}

// Load the deployment environment exactly once, then disable AGY before test
// modules snapshot process.env. Unit/contract tests opt in with explicit
// fixture values. This keeps the non-live suite from inheriting a host's
// production AGY binding or its intentionally staged rollout state.
await import("../packages/core/src/config.js");
process.env.AGY_ENABLED = "false";
process.env.AGY_PACKAGE_ENABLED = "false";
process.env.AGY_OLD_ROLLBACK_ENABLED = "false";
process.env.AGY_NATIVE_RESTORE = "false";
// A host running unpinned agy (AGY_PIN=unpinned) would resolve every fixture
// to the bare `agy` on PATH instead of the fixture binary.
delete process.env.AGY_PIN;
// Catalog API access is networked but token-free. Non-live tests still must not
// inherit the production credential; tests opt in with a synthetic fetch.
delete process.env.CLAUDE_CATALOG_API_KEY;
delete process.env.CLAUDE_CATALOG_WORKSPACE_ID;

// sessiond runs each slot's child under a slot holder (#631); in tests that
// holder runs from source.
process.env.SEAM_SLOT_HOLDER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers/slot-holder-source.mjs");
