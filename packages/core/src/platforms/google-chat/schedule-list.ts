import { ScheduleList, scheduleNavState, type ScheduleListScope } from "../../core/schedule-list.js";
import { SCHEDULE_PRESETS, SCHEDULE_TIMEZONES, scheduleDraft, saveSchedule, type ScheduleDraft, type ScheduleEditorPorts } from "../../core/schedule-editor.js";
import type { ScheduledPrompt } from "../../core/scheduled-prompts/types.js";
import type { ChannelRef } from "../chat-adapter.js";
import type { GoogleChatCardClickEvent } from "./card-click.js";
import { formatGoogleChatCardText } from "./card-text.js";
import type { GoogleChatCardButton, GoogleChatCardsMessage, GoogleChatCardWidget } from "./card-renderer.js";

export const GOOGLE_CHAT_SCHEDULE_ACTION = "seam_schedules";
export interface GoogleChatScheduleListOptions {
  ports: ScheduleEditorPorts;
  adminUserIds: ReadonlySet<string>;
}

interface ScheduleForm { draft: ScheduleDraft; cadence: string; customCron: string }
type FormInputs = NonNullable<GoogleChatCardClickEvent["common"]>["formInputs"];

export class GoogleChatScheduleList {
  private readonly list: ScheduleList;
  constructor(private readonly options: GoogleChatScheduleListOptions) {
    this.list = new ScheduleList(options.ports);
  }

  private scope(space: string): ScheduleListScope {
    return { platform: "google-chat", id: space.slice("spaces/".length), includeChildren: true };
  }

  render(space: string, viewer: string, page = 0, confirming?: string, notice?: string): GoogleChatCardsMessage {
    const scope = this.scope(space), slice = this.list.page(scope, page);
    const admin = this.options.adminUserIds.has(viewer);
    const button = (text: string, action: string, id = "", targetPage = slice.page, disabled = false): GoogleChatCardButton => ({
      text, type: "OUTLINED", disabled,
      onClick: { action: { function: GOOGLE_CHAT_SCHEDULE_ACTION,
        parameters: Object.entries({ viewer, page: String(targetPage), action, id }).map(([key, value]) => ({ key, value })) } },
    });
    const sections: Array<{ widgets: GoogleChatCardWidget[] }> = [];
    if (notice) sections.push({ widgets: [{ textParagraph: { text: formatGoogleChatCardText(notice) } }] });
    for (const row of slice.items) {
      const next = row.enabled && row.nextRunUtc
        ? new Date(row.nextRunUtc).toLocaleString("en-US", { timeZone: row.timezone, dateStyle: "medium", timeStyle: "short" })
        : "Not scheduled";
      const controls = confirming === row.id
        ? [button("Confirm", "confirm", row.id), button("Cancel", "cancel", row.id)]
        : [button("Run now", "run", row.id), ...(admin
          ? [button("Edit", "edit", row.id), button(row.enabled ? "Pause" : "Resume", row.enabled ? "pause" : "resume", row.id), button("Delete", "delete", row.id)] : [])];
      sections.push({ widgets: [
        { decoratedText: { topLabel: row.name, text: formatGoogleChatCardText(`${row.cadence} (${row.timezone})`), wrapText: true } },
        { textParagraph: { text: formatGoogleChatCardText(`${row.enabled ? "On" : "Off"} · Next run: ${next}${
          row.quarantined ? " · Legacy files — edit required before this schedule can run" : ""}`) } },
        ...(confirming === row.id ? [{ textParagraph: { text: "Delete this schedule?" } }] : []),
        { buttonList: { buttons: controls } },
      ] });
    }
    if (!slice.total) sections.push({ widgets: [{ textParagraph: { text: "No schedules in this Space." } }] });
    if (admin) sections.push({ widgets: [{ buttonList: { buttons: [button("Add schedule", "add")] } }] });
    const nav = scheduleNavState(slice.page, slice.pageCount);
    if (nav.show) sections.push({ widgets: [{ buttonList: { buttons: [
      button("Prev", "page", "", nav.prevPage, nav.prevDisabled), button("Next", "page", "", nav.nextPage, nav.nextDisabled),
    ] } }] });
    return { cardsV2: [{ cardId: "schedules", card: {
      header: { title: "Schedules", subtitle: `${nav.label} · ${slice.total} total` }, sections,
    } }] };
  }

  private editorChannel(space: string, existing?: ScheduledPrompt): ChannelRef {
    return { platform: "google-chat", id: existing?.channelRef ?? this.scope(space).id,
      ...(existing?.parentRef ? { parentId: existing.parentRef } : {}) };
  }

  private form(existing?: ScheduledPrompt): ScheduleForm {
    const draft = scheduleDraft(existing);
    const cadence = draft.cron ? SCHEDULE_PRESETS.find(p => p.value === draft.cron)?.value ?? "__custom__" : "__unset__";
    return { draft, cadence, customCron: cadence === "__custom__" ? draft.cron! : "" };
  }

  private readForm(parameters: Record<string, string>, inputs: FormInputs): ScheduleForm {
    const input = (name: string) => inputs?.[name]?.stringInputs?.value?.[0] ?? "";
    const hidden: Pick<ScheduleDraft, "model" | "cwd" | "target" | "outputType"> = JSON.parse(parameters.isolated!);
    const isolated = parameters.mode === "live" ? hidden : {
      model: input("model") === "__default__" ? null : input("model") || null,
      cwd: input("cwd") || null, target: input("target") || null,
      outputType: input("output") as ScheduleDraft["outputType"],
    };
    const cadence = input("cadence"), customCron = input("cron");
    return { cadence, customCron, draft: { name: input("name"), promptText: input("prompt"),
      cron: cadence === "__custom__" ? customCron : cadence === "__unset__" ? null : cadence,
      timezone: input("timezone"), sessionMode: input("mode") as ScheduleDraft["sessionMode"], ...isolated } };
  }

  private renderForm(space: string, viewer: string, page: number, id: string, form: ScheduleForm, notice?: string): GoogleChatCardsMessage {
    const { draft, cadence, customCron } = form, existing = id ? this.list.get(this.scope(space), id) : undefined;
    const defaults = this.options.ports.builderDefaults(this.editorChannel(space, existing));
    const action = (value: string) => ({ function: GOOGLE_CHAT_SCHEDULE_ACTION,
      parameters: Object.entries({ viewer, page: String(page), action: value, id, mode: draft.sessionMode,
        isolated: JSON.stringify({ model: draft.model, cwd: draft.cwd, target: draft.target, outputType: draft.outputType }) })
        .map(([key, value]) => ({ key, value })) });
    const widgets: GoogleChatCardWidget[] = [];
    if (notice) widgets.push({ textParagraph: { text: formatGoogleChatCardText(notice) } });
    const text = (name: string, label: string, value: string, multiline = false, hintText?: string) => widgets.push({
      textInput: { name, label, value, type: multiline ? "MULTIPLE_LINE" : "SINGLE_LINE", ...(hintText ? { hintText } : {}) },
    });
    const select = (name: string, label: string, selected: string, items: Array<{ label: string; value: string }>, refresh = false) => widgets.push({
      selectionInput: { name, label, type: "DROPDOWN", items: items.map(i => ({ text: i.label, value: i.value, selected: i.value === selected })),
        ...(refresh ? { onChangeAction: action("form") } : {}) },
    });
    text("name", "Name", draft.name); text("prompt", "Prompt", draft.promptText, true);
    select("cadence", "Cadence", cadence, [{ label: "Choose a cadence", value: "__unset__" }, ...SCHEDULE_PRESETS], true);
    text("cron", "Custom cron", customCron, false, "min hour day month weekday; used when cadence is Custom cron");
    select("timezone", "Timezone", draft.timezone,
      [...new Set([...SCHEDULE_TIMEZONES, draft.timezone])].map(z => ({ label: z, value: z })));
    select("mode", "Session", draft.sessionMode, [{ label: "Isolated (clean session)", value: "isolated" }, { label: "Live (this conversation)", value: "live" }], true);
    if (draft.sessionMode !== "live") {
      widgets.push({ textParagraph: { text: formatGoogleChatCardText(`Runs on a clean session with ${defaults.agent}. Write a prompt that stands alone.`) } });
      const models = [...defaults.models];
      if (draft.model && !models.some(m => m.modelId === draft.model)) models.push({ modelId: draft.model, name: draft.model });
      select("model", "Model", draft.model ?? "__default__", [{ label: `Conversation default (${defaults.model})`, value: "__default__" },
        ...models.map(m => ({ label: m.name, value: m.modelId }))]);
      text("cwd", "Working directory", draft.cwd ?? "", false, `Blank = ${defaults.cwd}; relative paths use ${this.options.ports.reposRoot}`);
      select("output", "Output", draft.outputType, [{ label: "Status cards", value: "card" }, { label: "Plain messages", value: "messages" }]);
      text("target", "Output Space/thread (optional)", draft.target ?? "", false, "Blank = here; SPACE.THREAD or spaces/SPACE/threads/THREAD");
    }
    widgets.push({ buttonList: { buttons: [
      { text: "Save", type: "FILLED", onClick: { action: action("save") } },
      { text: "Cancel", type: "OUTLINED", onClick: { action: action("form-cancel") } },
    ] } });
    return { cardsV2: [{ cardId: "schedules", card: { header: { title: id ? "Edit schedule" : "Add schedule" }, sections: [{ widgets }] } }] };
  }

  async click(space: string, viewer: string, parameters: Record<string, string>, inputs?: FormInputs): Promise<GoogleChatCardsMessage> {
    if (parameters.viewer !== viewer) throw new Error("This list belongs to another user. Run /schedules for your own list.");
    const page = Number(parameters.page), scope = this.scope(space), id = parameters.id ?? "";
    const action = parameters.action;
    let notice: string | undefined, confirming: string | undefined;
    let form: ScheduleForm | undefined;
    try {
      if (action !== "page" && action !== "run" && !this.options.adminUserIds.has(viewer)) {
        throw new Error("Only schedule admins can add, edit, pause, resume, or delete schedules.");
      }
      if (action === "add" || action === "edit") {
        const existing = action === "edit" ? this.list.get(scope, id) : undefined;
        if (action === "edit" && !existing) throw new Error("That schedule no longer exists.");
        return this.renderForm(space, viewer, page, existing?.id ?? "", this.form(existing));
      }
      if (action === "save" || action === "form") {
        form = this.readForm(parameters, inputs);
        if (action === "form") return this.renderForm(space, viewer, page, id, form);
        const existing = id ? this.list.get(scope, id) : undefined;
        if (id && !existing) throw new Error("That schedule no longer exists.");
        saveSchedule(this.options.ports, this.editorChannel(space, existing), viewer.replace(/^users\//, ""), form.draft, existing);
        return this.render(space, viewer, page);
      }
      if (action === "form-cancel") return this.render(space, viewer, page);
      if (action === "run") notice = await this.list.start(scope, id);
      else if (action === "pause" || action === "resume") this.list.setEnabled(scope, id, action === "resume");
      else if (action === "confirm") this.list.remove(scope, id);
      else if (action === "delete") {
        if (!this.list.get(scope, id)) throw new Error("That schedule no longer exists.");
        confirming = id;
      } else if (action !== "page" && action !== "cancel") throw new Error(`Unknown schedule action: ${action}`);
    } catch (err) {
      notice = err instanceof Error ? err.message : String(err);
      if (form) return this.renderForm(space, viewer, page, id, form, notice);
    }
    return this.render(space, viewer, page, confirming, notice);
  }
}
