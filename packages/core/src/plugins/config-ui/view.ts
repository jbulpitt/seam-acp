import type { ComponentEvent, ChannelRef } from "../../platforms/chat-adapter.js";
import type { ConfigDescription } from "../../core/session-router.js";
import { CONFIG_SET_FIELD_NAMES, type ConfigSetFieldName, type ConfigSetRequest } from "../../core/config-apply-plan.js";
import { renderHub, renderSavedHub, snapshotFromDescribe, type ThreadConfigDraft } from "../../platforms/discord/config-editor.js";
import type { ConfigInteraction, ConfigUiPorts } from "./ports.js";

export function configSetRequest(options: ConfigInteraction["options"]): ConfigSetRequest {
  const values = Object.fromEntries(
    CONFIG_SET_FIELD_NAMES.map((name) => [name, options.getString(name)])
  ) as Record<ConfigSetFieldName, string | null>;
  return {
    scope: options.getString("scope"),
    json: options.getString("json"),
    rebuild: options.getBoolean("rebuild") === true,
    values,
    supplied: CONFIG_SET_FIELD_NAMES.filter((name) => values[name] !== null),
  };
}

export function configSetSummary(effective: ConfigDescription, repoDisplay: (repo: string | null) => string): string {
  return (
    `agent \`${effective.agent.value}\`, model \`${effective.model.value}\`, ` +
    `effort \`${effective.effort.value ?? "default"}\`, repo ` +
    `\`${repoDisplay(effective.cwd.value)}\`, role \`${effective.role.value ?? "auto"}\`, ` +
    `permissions \`${effective.permission.value}\`, card \`${effective.statusCardStyle.value}\`, ` +
    `gif \`${effective.simpleCardGif.value ? "on" : "off"}\``
  );
}


export async function saveConfigEditorCard(draft: ThreadConfigDraft, evt: ComponentEvent, ports: {
  saveEditor: ConfigUiPorts["saveEditor"];
  deleteDraft(id: string): unknown;
  editCard(channel: ChannelRef, message: string, panel: ReturnType<typeof renderHub>): Promise<void>;
  channelSaved?(draft: ThreadConfigDraft): Promise<void>;
}): Promise<void> {
  // D10: Save does not abort a live turn; runtime changes wait for its next turn.
  const saved = await ports.saveEditor(draft, { id: evt.userId, name: evt.userName });
  if (!saved.ok) {
    await evt.followUpEphemeral(saved.error).catch(() => {});
    return;
  }
  draft = saved.draft;
  const { fastRefusal, fastRetireFailed } = saved;
  ports.deleteDraft(draft.id);
  if (draft.messageId) {
    const committed = saved.snapshot;
    const savedPanel = renderSavedHub(draft, {
      ...snapshotFromDescribe(committed.desc, committed.withoutThread),
      channelPins: committed.channelPins, threadOverrides: committed.threadOverrides,
    });
    await ports.editCard(
      evt.channel,
      draft.messageId,
      fastRetireFailed
        ? {
            ...savedPanel,
            color: 0xed4245,
            footer:
              "🚨 Saved, but a session that may be serving Fast could not be " +
              "discarded — run `/seam config reset` before the next turn.",
          }
        : savedPanel
    );
  }
  // #37: say plainly that Fast did NOT take, right after the card that now
  // (correctly) reads `off`. Silence here would be the false confirmation the
  // whole feature is designed to avoid.
  if (fastRefusal) {
    await evt.followUpEphemeral(fastRetireFailed ? fastRefusal : `⚡ ${fastRefusal}`)
      .catch(() => {});
  }
  await ports.channelSaved?.(draft);
}
