import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from "discord.js";
import { sliceChoicePage } from "./choice-picker.js";
import { clampFieldValue } from "./workflows-view.js";

export const WORKFLOW_CATEGORIES = [
  ["parked", "Parked turns"], ["wakes", "Wakes"], ["watches", "Watches"],
  ["choices", "Choices"], ["ingests", "Ingests"], ["live", "Live help"], ["schedules", "Schedules"],
] as const;
export type WorkflowCategory = typeof WORKFLOW_CATEGORIES[number][0];
export type WorkflowCategoryCounts = Record<WorkflowCategory, number>;

export function workflowLanding(counts: WorkflowCategoryCounts, scope: string) {
  return {
    embeds: [new EmbedBuilder().setTitle(`🔀 Workflows — ${scope}`).setColor(0x5865f2)
      .setDescription("Pick a category. Counts and lists are for the selected scope, newest first.")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId("wf:category").setPlaceholder("Choose a workflow category")
        .addOptions(WORKFLOW_CATEGORIES.map(([value, label]) => ({ label: `${label} (${counts[value]})`, value }))),
    )],
    page: 0,
  };
}

export function workflowNavigation(page: number, pageCount: number) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("wf:category:home").setLabel("Categories").setStyle(ButtonStyle.Secondary),
  );
  if (pageCount > 1) row.addComponents(
    new ButtonBuilder().setCustomId(`wf:page:${page - 1}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`wf:page:${page}`).setLabel(`Page ${page + 1}/${pageCount}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`wf:page:${page + 1}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
  );
  return row;
}

export function workflowCategoryList(category: WorkflowCategory, lines: string[], scope: string, requested: number, limit: number) {
  const pageSize = Math.min(limit, 4);
  const page = sliceChoicePage(lines, requested, pageSize);
  const label = WORKFLOW_CATEGORIES.find(([id]) => id === category)![1];
  return {
    embeds: [new EmbedBuilder().setTitle(`🔀 ${label} (${lines.length}) — ${scope}`).setColor(0x5865f2)
      .setDescription(clampFieldValue(page.items))],
    components: [workflowNavigation(page.page, Math.max(1, Math.ceil(lines.length / pageSize)))],
    page: page.page,
  };
}
