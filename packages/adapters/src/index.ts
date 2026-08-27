/** Public surface of `@seam/adapters`: AgentAdapter, profile factories, makeMux. */
export { makeMux } from "./mux.js";
export type { MuxSpawnOpts, MuxChild } from "./mux.js";
export * from "./agent-profile.js";
export * from "./session-manager.js";
export * from "./attachment-staging.js";
export * from "./agy-stream.js";
export * from "./command-bus.js";
export * from "./read-attachment.js";
export * from "./workspace-scan.js";
export * from "./adapter-rpc.js";
export * from "./profiles/claude.js";
export * from "./profiles/copilot.js";
export * from "./profiles/agy.js";
export * from "./profiles/opencode.js";
export * from "./profiles/codex.js";
export * from "./profiles/codex-session-manager.js";
export * from "./profiles/grok.js";
export * from "./profiles/ollama-cloud.js";
