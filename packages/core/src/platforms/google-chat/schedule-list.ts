import { ScheduleList, scheduleNavState, type ScheduleListPorts, type ScheduleListScope } from "../../core/schedule-list.js";
import { formatGoogleChatCardText } from "./card-text.js";
import type { GoogleChatCardButton, GoogleChatCardsMessage, GoogleChatCardWidget } from "./card-renderer.js";

export const GOOGLE_CHAT_SCHEDULE_ACTION = "seam_schedules";
export interface GoogleChatScheduleListOptions {
  ports: ScheduleListPorts;
  adminUserIds: ReadonlySet<string>;
}

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
          ? [button(row.enabled ? "Pause" : "Resume", row.enabled ? "pause" : "resume", row.id), button("Delete", "delete", row.id)] : [])];
      sections.push({ widgets: [
        { decoratedText: { topLabel: row.name, text: formatGoogleChatCardText(`${row.cadence} (${row.timezone})`), wrapText: true } },
        { textParagraph: { text: formatGoogleChatCardText(`${row.enabled ? "On" : "Off"} · Next run: ${next}${
          row.quarantined ? " · Legacy files — edit required before this schedule can run" : ""}`) } },
        ...(confirming === row.id ? [{ textParagraph: { text: "Delete this schedule?" } }] : []),
        { buttonList: { buttons: controls } },
      ] });
    }
    if (!slice.total) sections.push({ widgets: [{ textParagraph: { text: "No schedules in this Space." } }] });
    const nav = scheduleNavState(slice.page, slice.pageCount);
    if (nav.show) sections.push({ widgets: [{ buttonList: { buttons: [
      button("Prev", "page", "", nav.prevPage, nav.prevDisabled), button("Next", "page", "", nav.nextPage, nav.nextDisabled),
    ] } }] });
    return { cardsV2: [{ cardId: "schedules", card: {
      header: { title: "Schedules", subtitle: `${nav.label} · ${slice.total} total` }, sections,
    } }] };
  }

  async click(space: string, viewer: string, parameters: Record<string, string>): Promise<GoogleChatCardsMessage> {
    if (parameters.viewer !== viewer) throw new Error("This list belongs to another user. Run /schedules for your own list.");
    const page = Number(parameters.page), scope = this.scope(space), id = parameters.id ?? "";
    const action = parameters.action;
    let notice: string | undefined, confirming: string | undefined;
    try {
      if (action !== "page" && action !== "run" && !this.options.adminUserIds.has(viewer)) {
        throw new Error("Only schedule admins can pause, resume, or delete schedules.");
      }
      if (action === "run") notice = await this.list.run(scope, id);
      else if (action === "pause" || action === "resume") this.list.setEnabled(scope, id, action === "resume");
      else if (action === "confirm") this.list.remove(scope, id);
      else if (action === "delete") {
        if (!this.list.get(scope, id)) throw new Error("That schedule no longer exists.");
        confirming = id;
      } else if (action !== "page" && action !== "cancel") throw new Error(`Unknown schedule action: ${action}`);
    } catch (err) {
      notice = err instanceof Error ? err.message : String(err);
    }
    return this.render(space, viewer, page, confirming, notice);
  }
}
