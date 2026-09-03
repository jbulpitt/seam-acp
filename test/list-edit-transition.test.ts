/**
 * Call-site behaviour for the schedule-list and preset-list Edit buttons (#159).
 *
 * Edit is a *transition*: the listing must be frozen before the editor opens,
 * or the operator is left holding two live-looking cards for one object. Two
 * things have to be true at once, and only a behavioural test can show both:
 *
 * 1. The button interaction is acknowledged before the freeze is even
 *    *invoked* — not merely before it resolves. The freeze edits the original
 *    slash-command reply, a separate REST request; queuing that ahead of the
 *    ack risks the button's 3s budget under per-route backoff, producing
 *    "This interaction failed" with no editor at all. The builder therefore
 *    inherits an already-deferred interaction and must render through
 *    `editReply` rather than replying or deferring a second time.
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
      // Logged at entry: the gate is invocation order, so a freeze that merely
      // *starts* before the ack must fail even though it resolves later.
      events.push("list:freeze-invoked");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("list:freeze-painted");
      paints.push(payload);
    },
  };
  return { interaction, collector, paints };
}

/**
 * The Edit button click, tracking `deferred`/`replied` the way discord.js does
 * so a second reply/defer is observable rather than silently fine.
 */
function makeEditButton(customId: string, events: string[], ackGate?: Promise<void>) {
  const button = {
    isButton: () => true,
    customId,
    user: { id: "u1" },
    deferred: false,
    replied: false,
    deferReply: async () => {
      if (button.deferred || button.replied) throw new Error("InteractionAlreadyReplied");
      // Logged at entry: the gate is invocation order.
      events.push("button:ack-invoked");
      if (ackGate) await ackGate;
      button.deferred = true;
      events.push("button:acked");
    },
    reply: async () => {
      if (button.deferred || button.replied) throw new Error("InteractionAlreadyReplied");
      button.replied = true;
      events.push("button:acked");
    },
    editReply: async () => {
      if (!button.deferred && !button.replied) throw new Error("InteractionNotReplied");
      events.push("editor:rendered-via-editReply");
    },
    update: async () => {
      events.push("list:updated-via-button");
    },
  };
  return button;
}

interface RunOpts {
  /** Holds the button's ack open so both clicks are genuinely in flight. */
  ackGate?: Promise<void>;
  releaseAck?: () => void;
}

/**
 * Fire `count` clicks. They are dispatched WITHOUT awaiting each other, so a
 * second click lands while the first is still parked on its unresolved ack —
 * the window a settle that stops only after awaiting would leave open.
 */
async function fireClicks(
  collector: FakeCollector,
  count: number,
  makeButton: (events: string[]) => unknown,
  events: string[],
  releaseAck?: () => void
): Promise<boolean[]> {
  const inFlight: Array<Promise<boolean>> = [];
  for (let n = 0; n < count; n++) inFlight.push(collector.click(makeButton(events)));
  releaseAck?.();
  const delivered = await Promise.all(inFlight);
  // Let the deliberately slow freeze repaint land.
  await new Promise((resolve) => setTimeout(resolve, 40));
  return delivered;
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

async function runScheduleListEdit(clicks: number, opts: RunOpts = {}) {
  const { ackGate, releaseAck } = opts;
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
    // The real wrapper, so a builder that throws after the freeze is surfaced
    // rather than leaving a permanently "thinking" ephemeral.
    openEditorAfterFreeze: Orchestrator.prototype["openEditorAfterFreeze" as never],
    buildScheduleListMessage: Orchestrator.prototype["buildScheduleListMessage" as never],
    scheduleSummaryLine: Orchestrator.prototype["scheduleSummaryLine" as never],
    cmdScheduleAdd: async (c: { deferred: boolean; replied: boolean; editReply: () => Promise<void>; reply: () => Promise<void> }) => {
      events.push(`editor:opened:deferred=${c.deferred}`);
      // Mirrors Orchestrator.respondInitial.
      if (c.deferred || c.replied) await c.editReply();
      else await c.reply();
    },
  };
  await (
    Orchestrator.prototype as unknown as {
      cmdScheduleList(this: unknown, i: unknown): Promise<void>;
    }
  ).cmdScheduleList.call(self, interaction);

  const delivered = await fireClicks(collector, clicks, (e) =>
    makeEditButton(`sl:edit:${scheduleRow.id}`, e, ackGate),
    events,
    releaseAck
  );
  return { events, collector, paints, delivered };
}

async function runPresetListEdit(clicks: number, opts: RunOpts = {}) {
  const { ackGate, releaseAck } = opts;
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
    // The real wrapper, so a builder that throws after the freeze is surfaced
    // rather than leaving a permanently "thinking" ephemeral.
    openEditorAfterFreeze: Orchestrator.prototype["openEditorAfterFreeze" as never],
    buildPresetListMessage: Orchestrator.prototype["buildPresetListMessage" as never],
    presetSummaryLine: Orchestrator.prototype["presetSummaryLine" as never],
    cmdPresetBuilder: async (c: { deferred: boolean; replied: boolean; editReply: () => Promise<void>; deferReply: () => Promise<void> }) => {
      events.push(`editor:opened:deferred=${c.deferred}`);
      if (!c.deferred && !c.replied) await c.deferReply();
      await c.editReply();
    },
  };
  await (
    Orchestrator.prototype as unknown as {
      cmdPresetList(this: unknown, i: unknown): Promise<void>;
    }
  ).cmdPresetList.call(self, interaction);

  const delivered = await fireClicks(collector, clicks, (e) =>
    makeEditButton(`pr:edit:${presetRow.id}`, e, ackGate),
    events,
    releaseAck
  );
  return { events, collector, paints, delivered };
}

const SURFACES = [
  { name: "schedule list", run: runScheduleListEdit },
  { name: "preset list", run: runPresetListEdit },
];

for (const surface of SURFACES) {
  describe(`${surface.name} Edit transition`, () => {
    // The hard gate: the ack must come first in *invocation* order, not just
    // finish first. A freeze that is merely started before the ack already
    // queues a REST request ahead of it.
    it("acknowledges the button before the freeze is even invoked", async () => {
      const { events } = await surface.run(1);
      expect(events).toContain("button:ack-invoked");
      expect(events).toContain("list:freeze-invoked");
      expect(events.indexOf("button:ack-invoked")).toBeLessThan(events.indexOf("list:freeze-invoked"));
    });

    it("acknowledges the button before the freeze repaint resolves", async () => {
      const { events } = await surface.run(1);
      expect(events.indexOf("button:acked")).toBeLessThan(events.indexOf("list:freeze-painted"));
    });

    it("hands the builder an already-deferred interaction and renders via editReply", async () => {
      const { events } = await surface.run(1);
      expect(events).toContain("editor:opened:deferred=true");
      expect(events).toContain("editor:rendered-via-editReply");
      // No second reply/defer: the fake throws InteractionAlreadyReplied.
      expect(events.filter((e) => e === "button:acked")).toHaveLength(1);
    });

    it("opens exactly one editor even when the button is clicked twice", async () => {
      const { events, delivered } = await surface.run(2);
      expect(events.filter((e) => e.startsWith("editor:opened"))).toHaveLength(1);
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

    it("freezes before the editor opens, so no second live listing survives", async () => {
      const { events, collector } = await surface.run(1);
      expect(collector.stopped).toBe("edit");
      expect(events.indexOf("list:freeze-invoked")).toBeLessThan(
        events.findIndex((e) => e.startsWith("editor:opened"))
      );
    });
  });
}

// QA gate: a sequential second click proves nothing about the window between
// the handler starting and its ack resolving. These launch both clicks with the
// ack deliberately unresolved, so the only thing that can prevent a second
// editor is a collector that was stopped SYNCHRONOUSLY, before any await.
describe("concurrent Edit clicks while the ACK is still unresolved", () => {
  const SURFACE_RUNNERS = [
    { name: "schedule list", run: runScheduleListEdit },
    { name: "preset list", run: runPresetListEdit },
  ];

  for (const surface of SURFACE_RUNNERS) {
    it(`${surface.name}: two in-flight clicks open exactly one editor`, async () => {
      let releaseAck!: () => void;
      const ackGate = new Promise<void>((resolve) => {
        releaseAck = resolve;
      });
      const { events, delivered, collector } = await surface.run(2, { ackGate, releaseAck });

      expect(events.filter((e) => e.startsWith("editor:opened"))).toHaveLength(1);
      // The second click was refused at dispatch: the settle stopped the
      // collector before the first handler ever awaited its ack.
      expect(delivered).toEqual([true, false]);
      expect(collector.stopped).toBe("edit");
      // Exactly one ack was even attempted.
      expect(events.filter((e) => e === "button:ack-invoked")).toHaveLength(1);
    });

    it(`${surface.name}: the ack is invoked before the freeze repaint is`, async () => {
      let releaseAck!: () => void;
      const ackGate = new Promise<void>((resolve) => {
        releaseAck = resolve;
      });
      const { events } = await surface.run(1, { ackGate, releaseAck });
      expect(events.indexOf("button:ack-invoked")).toBeLessThan(events.indexOf("list:freeze-invoked"));
    });
  }
});
