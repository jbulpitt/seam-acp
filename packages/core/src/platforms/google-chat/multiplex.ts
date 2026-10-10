import type { ChatAdapter, ChannelRef, MessageAttachment } from "../chat-adapter.js";
import { serializePanelText } from "../renderer.js";
import type { StructuredPanel } from "../../core/types.js";

/** Keep optional Discord surfaces intact while routing each real ref to its adapter. */
export function multiplexChatAdapters(adapters: ChatAdapter[], platformForId = (_id: string) => adapters[0]!.platform): ChatAdapter {
  const primary = adapters[0]!;
  const byPlatform = new Map(adapters.map(adapter => [adapter.platform, adapter]));
  const target = (platform: string) => {
    const adapter = byPlatform.get(platform);
    if (!adapter) throw new Error(`chat adapter not installed: ${platform}`);
    return adapter;
  };
  const events = new Set(["onMessage", "onComponent", "onChoiceInteraction", "onThreadDelete", "setActiveChannelCheck"]);
  const empty = new Set(["sendTyping", "getThreadName", "getChannelName", "renameThread", "addThreadMember"]);
  return new Proxy(primary, {
    get(_primary, property: keyof ChatAdapter) {
      if (property === "catchUpMessagesAfter") return primary.catchUpMessagesAfter?.bind(primary);
      if (property === "start" || property === "stop") return async () => {
        for (const adapter of adapters) await adapter[property]();
      };
      if (events.has(property)) return (...args: unknown[]) => {
        for (const adapter of adapters) {
          const handler = adapter[property] as ((...a: unknown[]) => void) | undefined;
          handler?.apply(adapter, args);
        }
      };
      if (property === "isAllowedUser") return (platform: string, userId: string) => target(platform).isAllowedUser?.(platform, userId) ?? false;
      if (property === "downloadAttachment") return async (attachment: MessageAttachment) => {
        const adapter = target(attachment.platform ?? primary.platform);
        if (adapter.downloadAttachment) return adapter.downloadAttachment(attachment);
        const response = await fetch(attachment.url);
        if (!response.ok) throw new Error(`attachment download ${response.status} ${response.statusText}`);
        return Buffer.from(await response.arrayBuffer());
      };
      const exists = adapters.some(adapter => typeof adapter[property] === "function");
      if (!exists) return Reflect.get(primary, property);
      return (...args: any[]) => {
        const first = args[0];
        const ref: ChannelRef | undefined = first?.channel ?? (first?.platform ? first : undefined);
        const adapter = ref ? target(ref.platform) : typeof first === "string"
          ? target(platformForId(first)) : primary;
        const method = adapter[property];
        if (typeof method === "function") return (method as (...a: any[]) => unknown).apply(adapter, args);
        if (property === "sendPanel" || property === "sendChoiceCard" || property === "sendElicitationCard") {
          const panel: StructuredPanel = property === "sendPanel" ? args[1] : args[1].panel;
          return adapter.sendMessage(first, serializePanelText(panel), args[2]);
        }
        if (property === "editPanel" || property === "editChoiceCard" || property === "editElicitationCard") {
          const panel: StructuredPanel = property === "editPanel" ? args[1] : args[1].panel;
          return adapter.editMessage(first, serializePanelText(panel));
        }
        if (empty.has(property)) return Promise.resolve(undefined);
        throw new Error(`${adapter.platform} does not implement ${property}`);
      };
    },
  });
}
