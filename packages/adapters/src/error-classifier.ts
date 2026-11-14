import type { AgentAdapter } from "./agent-profile.js";
import { classifyAndAttach } from "./error-classification.js";
import { classifyClaudeError } from "./profiles/claude.js";
import { classifyCodexError } from "./profiles/codex.js";
import { classifyCopilotError } from "./profiles/copilot.js";
import { classifyAgyError } from "./profiles/agy.js";
import { classifyGrokError } from "./profiles/grok.js";

/** Unknown declarations stay unknown; attribution uses the actual selector. */
export function resolveErrorClassifier(reference: unknown, agentId: string): AgentAdapter["classifyError"] {
  const parser = reference === "claude" ? classifyClaudeError
    : reference === "codex" ? classifyCodexError
    : reference === "copilot" ? classifyCopilotError
    : reference === "agy" ? classifyAgyError
    : reference === "grok" ? classifyGrokError
    : undefined;
  return parser ? error => classifyAndAttach(error, parser(error, agentId)) : undefined;
}

/** Frozen compatibility for hosts that omit the portable parser declaration. */
export function resolveLegacyControllerErrorClassifier(
  agentId: string,
  claudeSessionOptions: unknown,
  supplied?: AgentAdapter["classifyError"],
): AgentAdapter["classifyError"] {
  if (agentId === "claude" || agentId.startsWith("claude-") || !!claudeSessionOptions) {
    return resolveErrorClassifier("claude", agentId);
  }
  if (agentId.startsWith("copilot")) return resolveErrorClassifier("copilot", agentId);
  if (agentId === "codex" || agentId.startsWith("codex-")) return resolveErrorClassifier("codex", agentId);
  if (agentId === "agy") return resolveErrorClassifier("agy", agentId);
  if (agentId.startsWith("grok")) return resolveErrorClassifier("grok", agentId);
  return supplied;
}
