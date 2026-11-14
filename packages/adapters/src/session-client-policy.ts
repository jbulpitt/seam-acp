import type { AgentAdapter } from "./agent-profile.js";
import { claudeSessionMetadata } from "./profiles/claude.js";

type SessionClientPolicy = Pick<AgentAdapter,
  "effort" | "mcpServersAtSpawn" | "submissionSignals" | "newSessionMeta">;
type ClaudeOptions = Parameters<typeof claudeSessionMetadata>[0];

/** A declared unknown never regains a serializer through selector guessing. */
export function resolveSessionMetaCodec(
  reference: unknown,
  options: () => ClaudeOptions,
): AgentAdapter["newSessionMeta"] {
  return reference === "claude"
    ? (model, effort) => claudeSessionMetadata(options(), model, effort)
    : undefined;
}

/** Compatibility partials only for fields absent from host metadata. */
export function resolveLegacyControllerSessionPolicy(
  id: string,
  claudeSessionOptions: AgentAdapter["claudeSessionOptions"],
  options: () => ClaudeOptions,
): Partial<SessionClientPolicy> {
  if (id === "claude" || id.startsWith("claude-") || !!claudeSessionOptions) {
    return {
      effort: { mechanism: "meta", levels: ["low", "medium", "high", "xhigh", "max"] },
      submissionSignals: "claude_sdk",
      newSessionMeta: resolveSessionMetaCodec("claude", options),
    };
  }
  if (id.startsWith("copilot")) {
    return {
      mcpServersAtSpawn: true,
      effort: { mechanism: "configOption", configId: "reasoning_effort", levels: ["low", "medium", "high", "xhigh", "max"] },
    };
  }
  return {};
}
