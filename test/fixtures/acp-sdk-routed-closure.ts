import { agentProtocolRouter } from "@agentclientprotocol/sdk/experimental/v2";

type Lifecycle = ReturnType<ReturnType<typeof agentProtocolRouter>["connect"]>;

export function closed(lifecycle: Lifecycle): Promise<void> {
  return lifecycle.closed;
}
