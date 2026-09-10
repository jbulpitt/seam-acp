// Load the deployment environment exactly once, then disable AGY before test
// modules snapshot process.env. Unit/contract tests opt in with explicit
// fixture values. This keeps the non-live suite from inheriting a host's
// production AGY binding or its intentionally staged rollout state.
await import("../packages/core/src/config.js");
process.env.AGY_ENABLED = "false";
process.env.AGY_PACKAGE_ENABLED = "false";
process.env.AGY_OLD_ROLLBACK_ENABLED = "false";
process.env.AGY_NATIVE_RESTORE = "false";
