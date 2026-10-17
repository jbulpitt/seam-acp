import type { GoogleChatCommand } from "./commands.js";
import type { GoogleChatCommandDeps, GoogleChatConfigCommand } from "./command-actions.js";
import type { GoogleChatCardButton, GoogleChatCardsMessage, GoogleChatCardWidget } from "./card-renderer.js";
import { formatGoogleChatCardText } from "./card-text.js";

export const GOOGLE_CHAT_CONFIG_ACTION = "seam_config";
export type GoogleChatConfigPickerCommand = Omit<GoogleChatCommand, "command"> & { command: GoogleChatConfigCommand };
const pageSize = 6;

export async function renderGoogleChatConfigPicker(
  command: GoogleChatConfigPickerCommand,
  deps: GoogleChatCommandDeps,
  options: { page?: number; notice?: string; cancelled?: boolean } = {},
): Promise<GoogleChatCardsMessage> {
  const channel = deps.channelFor(command.space, command.thread);
  const record = deps.store.getByChannel(channel.platform, channel.id);
  if (!record) throw new Error("Start a session Space with /new before changing its configuration.");
  const current = deps.router.describeConfig(record);
  const binding = { agentId: current.agent.value, location: current.location.value };
  let selected = command.command === "repo" ? current.cwd.value
    : command.command === "effort" ? current.effort.value ?? "auto" : current[command.command].value;
  let choices: Array<{ id: string; label: string }> = [], notice = options.notice;
  try {
    switch (command.command) {
      case "model":
        choices = deps.modelCatalog.models(binding, { current: selected }).map(model => ({ id: model.id, label: model.displayName }));
        selected = deps.modelCatalog.model(binding, selected)?.id ?? selected;
        break;
      case "agent":
        choices = deps.router.listProfiles(binding.location).map(profile => ({ id: profile.id, label: profile.displayName }));
        break;
      case "effort":
        choices = [...new Set(["auto", ...deps.modelCatalog.effortChoices(binding, current.model.value)])].map(id => ({ id, label: id }));
        break;
      case "repo":
        choices = (await deps.configPlan.listRepos(record)).map(id => ({ id, label: id }));
        break;
    }
  } catch (err) {
    notice = [notice, err instanceof Error ? err.message : String(err)].filter(Boolean).join("\n");
  }
  const pageCount = Math.max(1, Math.ceil(choices.length / pageSize));
  const page = Math.min(pageCount - 1, Math.max(0, Math.floor(options.page || 0)));
  const button = (text: string, action: string, value = "", targetPage = page, disabled = false): GoogleChatCardButton => ({
    text, type: "OUTLINED", disabled,
    onClick: { action: { function: GOOGLE_CHAT_CONFIG_ACTION,
      parameters: Object.entries({ command: command.command, thread: command.thread ?? "", action, value, page: String(targetPage) })
        .map(([key, value]) => ({ key, value })) } },
  });
  const widgets: GoogleChatCardWidget[] = [];
  const paragraph = (text: string): GoogleChatCardWidget => ({ textParagraph: { text: formatGoogleChatCardText(text) } });
  if (notice) widgets.push(paragraph(notice));
  widgets.push(paragraph(`Current: ${selected}`));
  if (!options.cancelled) {
    for (const choice of choices.slice(page * pageSize, (page + 1) * pageSize)) {
      widgets.push({ buttonList: { buttons: [button(`${choice.label}${choice.id === selected ? " (current)" : ""}`, "select", choice.id)] } });
    }
    if (!choices.length) widgets.push(paragraph("No choices advertised on this host. You can still type a value with the command."));
    if (pageCount > 1) widgets.push({ buttonList: { buttons: [
      button("Prev", "page", "", page - 1, page === 0), button("Next", "page", "", page + 1, page === pageCount - 1),
    ] } });
    widgets.push({ buttonList: { buttons: [button("Cancel", "cancel")] } });
  }
  return { cardsV2: [{ cardId: "config-picker", card: {
    header: { title: `Choose ${command.command}`, subtitle: `Only visible to you · ${binding.agentId}@${binding.location} · Page ${page + 1}/${pageCount}` },
    sections: [{ widgets }],
  } }] };
}
