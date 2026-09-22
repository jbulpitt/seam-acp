/** Public surface of `@seam/adapters`: AgentAdapter, profile factories, makeMux. */
export { makeMux, BridgeUnreachableError } from "./mux.js";
export type {
  MuxSpawnOpts,
  MuxChild,
  RemoteExitEvidence,
  RemoteHostOomEvidence,
} from "./mux.js";
export * from "./agent-profile.js";
export * from "./error-classification.js";
export * from "./error-resolver.js";
export * from "./catalog-evidence.js";
export * from "./model-catalog.js";
export * from "./model-fallback.js";
export * from "./probe-process.js";
export * from "./fast-mode.js";
export * from "./session-manager.js";
export * from "./attachment-staging.js";
export * from "./agy-stream.js";
export * from "./agy-native-translation.js";
export * from "./agy-native-runtime.js";
export * from "./agy-session-store.js";
export * from "./agy-session-store.js";
export * from "./command-bus.js";
export * from "./read-attachment.js";
export * from "./project-mcp.js";
export * from "./workspace-scan.js";
export * from "./adapter-rpc.js";
export * from "./profiles/claude.js";
export * from "./profiles/claude-catalog.js";
export * from "./profiles/copilot.js";
export * from "./profiles/agy.js";
export * from "./profiles/codex.js";
export * from "./profiles/codex-session-manager.js";
export * from "./profiles/grok.js";
export * from "./profiles/ollama-cloud.js";
