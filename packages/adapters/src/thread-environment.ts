/** Chat routing identity captured when the provider process starts. */
export interface ThreadIdentity {
  threadId: string;
  channelId: string;
  agentId: string;
}

export const THREAD_ENV_KEYS = [
  "SEAM_THREAD_ID", "SEAM_CHANNEL_ID", "SEAM_AGENT_ID",
] as const;

export function threadEnvironment(identity: ThreadIdentity | undefined): Record<string, string> {
  return identity ? {
    SEAM_THREAD_ID: identity.threadId,
    SEAM_CHANNEL_ID: identity.channelId,
    SEAM_AGENT_ID: identity.agentId,
  } : {};
}
