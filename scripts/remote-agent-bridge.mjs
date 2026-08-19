#!/usr/bin/env node
/**
 * Compatibility launcher. The bridge now lives at packages/bridge
 * (TypeScript; protocol unchanged: data/kill/exit/cmd/cmd_reply + bridge_hello).
 *
 *   node scripts/remote-agent-bridge.mjs …   →  packages/bridge/dist/index.js
 */
await import("../packages/bridge/dist/index.js");
