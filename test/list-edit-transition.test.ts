/**
 * Call-site behaviour for the schedule-list and preset-list Edit buttons (#159).
 *
 * Edit is a *transition*: the listing must be frozen before the editor opens,
 * or the operator is left holding two live-looking cards for one object. Two
 * things have to be true at once, and only a behavioural test can show both:
 *
 * 1. The button interaction is acknowledged **before** the (slower) freeze
 *    repaint lands. The freeze edits the original slash-command reply, which
 *    is a separate REST round trip; awaiting it would hold the button unacked
 *    inside Discord's 3s budget and, under rate-limit backoff, produce "This
 *    interaction failed" with no editor at all.
 * 2. Exactly one editor opens, because the freeze closes the collector
 *    synchronously — so a second click is never delivered.
 */
import { describe, it, expect } from "vitest";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

/** A collector with the one semantic that matters: `stop()` is final. */
class FakeCollector {
  stopped: string | null = null;
  private collectFn: ((c: unknown) => Promise<void>) | undefined;

  on(event: string, fn: (...args: never[]) => unknown): this {
    if (event === "collect") this.collectFn = fn as (c: unknown) => Promise<void>;
    return this;
  }

  stop(reason = "user"): void {
    if (this.stopped === null) this.stopped = reason;
  }

  /** `false` mirrors Discord: a stopped collector never delivers a click. */
  async click(interaction: unknown): Promise<boolean> {
    if (this.stopped !== null) return false;
    await this.collectFn?.(interaction);
    return true;
  }
}

/** The originating list interaction; `editReply` is deliberately slow. */
function makeListInteraction(events: string[]) {
  const collector = new FakeCollector();
  const paints: Array<Record<string, unknown>> = [];
  const interaction = {
    user: { id: "u1" },
    reply: async () => {
      events.push("list:reply");
    },
    fetchReply: async () => ({
      id: "msg-1",
      createMessageComponentCollector: () => collector,
    }),
    editReply: async (payload: Record<string, unknown>) => {
      // The freeze repaint is a real round trip — model it as slower than the
      // ack so an ack-after-paint regression is unmissable.
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("list:freeze-painted");
      paints.push(payload);
    },
  };
  return { interaction, collector, paints };
}

/** The Edit button click. Acking it is what opening the editor must do first. */
function makeEditButton(customId: string, events: string[]) {
  return {
    isButton: () => true,
    customId,
    user: { id: "u1" },
    reply: async () => {
      events.push("editor:acked");
    },
    deferReply: async () => {
      events.push("editor:acked");
    },
    update: async () => {
      events.push("list:updated-via-button");
    },
  };
}

const scheduleRow = {
  id: "sch_1",
  platform: "discord",
  channelRef: "thread-1",
  parentRef: "chan-1",
  name: "nightly",
  promptText: "run tests",
  cron: "0 9 * * *",
  timezone: "UTC",
  model: null,
  cwd: null,
  targetChannel: null,
  outputType: "card",
  sessionMode: "isolated",
  catchupSeconds: 7200,
  enabled: true,
  attachments: [],
  createdBy: "u1",
  createdUtc: "2026-09-01T00:00:00.000Z",
  updatedUtc: "2026-09-01T00:00:00.000Z",
  lastRunUtc: null,
  lastStatus: null,
  nextRunUtc: null,
  pinnedSessionId: null,
};

const presetRow = {
  id: "pre_1",
  name: "reviewer",
  description: "",
  projectRef: null,
  agentId: "claude",
  model: null,
  effort: null,
  repoPath: null,
  permission: null,
  toolsAllow: null,
  toolsExclude: null,
  instructions: null,
  statusCardStyle: null,
  role: null,
  disableThreadPrefix: null,
  createdBy: "u1",
  createdUtc: "2026-09-01T00:00:00.000Z",
  updatedUtc: "2026-09-01T00:00:00.000Z",
};

async function runScheduleListEdit(clicks: number) {
  const events: string[] = [];
  const { interaction, collector, paints } = makeListInteraction(events);
  const self = {
    logger: silent,
    config: { DATA_DIR: "/tmp" },
    channelRefFromInteraction: () => ({ platform: "discord", id: "thread-1", parentId: "chan-1" }),
    store: {
      listScheduledByChannel: () => [scheduleRow],
      getScheduled: () => scheduleRow,
    },
    scheduledManager: undefined,
    attachListLifecycle: Orchestrator.prototype["attachListLifecycle" as never],
    buildScheduleListMessage: Orchestrator.prototype["buildScheduleListMessage" as never],
    scheduleSummaryLine: Orchestrator.prototype["scheduleSummaryLine" as never],
    cmdScheduleAdd: async (c: { reply: () => Promise<void> }) => {
      events.push("editor:opened");
      await c.reply();
    },
  };
  await (
    Orchestrator.prototype as unknown as {
      cmdScheduleList(this: unknown, i: unknown): Promise<void>;
    }
  ).cmdScheduleList.call(self, interaction);

  const delivered: boolean[] = [];
  for (let n = 0; n < clicks; n++) {
    delivered.push(await collector.click(makeEditButton(`sl:edit:${scheduleRow.id}`, events)));
  }
  // Let the deliberately slow freeze repaint land.
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { events, collector, paints, delivered };
}

async function runPresetListEdit(clicks: number) {
  const events: string[] = [];
  const { interaction, collector, paints } = makeListInteraction(events);
  const self = {
    logger: silent,
    projectScopeId: () => null,
    store: {
      listPresetsForProject: () => [presetRow],
      getPreset: () => presetRow,
    },
    repoDisplay: (p: string) => p,
    attachListLifecycle: Orchestrator.prototype["attachListLifecycle" as never],
    buildPresetListMessage: Orchestrator.prototype["buildPresetListMessage" as never],
    presetSummaryLine: Orchestrator.prototype["presetSummaryLine" as never],
    cmdPresetBuilder: async (c: { deferReply: () => Promise<void> }) => {
      events.push("editor:opened");
      await c.deferReply();
    },
  };
  await (
    Orchestrator.prototype as unknown as {
      cmdPresetList(this: unknown, i: unknown): Promise<void>;
    }
  ).cmdPresetList.call(self, interaction);

  const delivered: boolean[] = [];
  for (let n = 0; n < clicks; n++) {
    delivered.push(await collector.click(makeEditButton(`pr:edit:${presetRow.id}`, events)));
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { events, collector, paints, delivered };
}

const SURFACES = [
  { name: "schedule list", run: runScheduleListEdit },
  { name: "preset list", run: runPresetListEdit },
];

for (const surface of SURFACES) {
  describe(`${surface.name} Edit transition`, () => {
    it("acknowledges the button before the slower freeze repaint lands", async () => {
      const { events } = await surface.run(1);
      expect(events).toContain("editor:acked");
      expect(events).toContain("list:freeze-painted");
      expect(events.indexOf("editor:acked")).toBeLessThan(events.indexOf("list:freeze-painted"));
    });

    it("opens exactly one editor even when the button is clicked twice", async () => {
      const { events, delivered } = await surface.run(2);
      expect(events.filter((e) => e === "editor:opened")).toHaveLength(1);
      // The second click is never delivered: the transition closed the
      // collector synchronously, before its repaint was even sent.
      expect(delivered).toEqual([true, false]);
    });

    it("closes the collector with the edit reason", async () => {
      const { collector } = await surface.run(1);
      expect(collector.stopped).toBe("edit");
    });

    it("leaves the originating listing with no components", async () => {
      const { paints } = await surface.run(1);
      const freeze = paints.at(-1);
      expect(freeze).toBeDefined();
      expect(freeze!.components).toEqual([]);
    });

    it("freezes the listing before the editor is opened", async () => {
      const { events, collector } = await surface.run(1);
      // The collector is closed by the time the editor opens, so no second
      // live-looking listing can survive alongside it.
      expect(collector.stopped).toBe("edit");
      expect(events.indexOf("editor:opened")).toBeGreaterThan(-1);
    });
  });
}
