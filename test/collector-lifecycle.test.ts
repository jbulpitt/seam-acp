import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import {
  BUILTIN_COLLECTOR_STOP_REASONS,
  CARD_GONE_STOP_REASONS,
  CardLifecycle,
  attachCardLifecycle,
  collectorEndAction,
  countEnabledComponents,
  expiredCardView,
  hasEnabledComponents,
  inertView,
  type CardView,
} from "../packages/core/src/platforms/discord/collector-lifecycle.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORCHESTRATOR = readFileSync(
  path.join(REPO_ROOT, "packages/core/src/platforms/discord/orchestrator.ts"),
  "utf8"
);

/** A live listing card: three enabled buttons, exactly like the real ones. */
function liveRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("x:run:1").setLabel("Run").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("x:edit:1").setLabel("Edit").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("x:del:1").setLabel("Delete").setStyle(ButtonStyle.Danger)
  );
}

/**
 * Stand-in for a `discord.js` InteractionCollector with the semantics that
 * matter here: `stop()` is one-way, fires `end` once, and a click after a stop
 * is never delivered to the `collect` handler.
 */
class FakeCollector {
  stopped: string | null = null;
  endReasons: string[] = [];
  private endListeners: Array<(collected: unknown, reason: string) => void> = [];
  private collectListeners: Array<(id: string) => void | Promise<void>> = [];

  on(event: "end" | "collect", listener: (...args: never[]) => void): this {
    if (event === "end") {
      this.endListeners.push(listener as unknown as (c: unknown, r: string) => void);
    } else {
      this.collectListeners.push(listener as unknown as (id: string) => Promise<void>);
    }
    return this;
  }

  stop(reason = "user"): void {
    if (this.stopped !== null) return;
    this.stopped = reason;
    this.endReasons.push(reason);
    for (const listener of this.endListeners) listener(undefined, reason);
  }

  /** Deliver a click. `false` means Discord would have refused it. */
  async click(id: string): Promise<boolean> {
    if (this.stopped !== null) return false;
    for (const listener of this.collectListeners) await listener(id);
    return true;
  }
}

interface Harness {
  collector: FakeCollector;
  lifecycle: CardLifecycle;
  renders: CardView[];
  current(): CardView;
}

function makeCard(opts: { render?: (view: CardView) => Promise<void> } = {}): Harness {
  const collector = new FakeCollector();
  const renders: CardView[] = [{ embeds: [], components: [liveRow()] }];
  const lifecycle = attachCardLifecycle(collector, {
    render: async (view) => {
      renders.push(view);
      await opts.render?.(view);
    },
    expired: (reason) => expiredCardView(`⏰ expired (${reason})`),
  });
  return {
    collector,
    lifecycle,
    renders,
    current: () => renders[renders.length - 1]!,
  };
}

describe("countEnabledComponents", () => {
  it("counts enabled builder buttons through action rows", () => {
    expect(countEnabledComponents([liveRow()])).toBe(3);
  });

  it("ignores explicitly disabled controls (a page indicator is not a control)", () => {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("p:0").setLabel("Prev").setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId("p:1").setLabel("Page 1/2").setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId("p:2").setLabel("Next").setStyle(ButtonStyle.Secondary)
    );
    expect(countEnabledComponents([row])).toBe(1);
  });

  it("handles raw API payloads and empty/absent components", () => {
    const raw = [{ type: 1, components: [{ type: 2, custom_id: "a" }, { type: 2, custom_id: "b", disabled: true }] }];
    expect(countEnabledComponents(raw)).toBe(1);
    expect(hasEnabledComponents([])).toBe(false);
    expect(hasEnabledComponents(undefined)).toBe(false);
  });
});

describe("inertView / expiredCardView", () => {
  it("inertView strips components and keeps everything else", () => {
    const view = inertView({ content: "hi", embeds: ["e"], components: [liveRow()] });
    expect(view.content).toBe("hi");
    expect(view.embeds).toEqual(["e"]);
    expect(hasEnabledComponents(view.components)).toBe(false);
  });

  it("expiredCardView is text-only", () => {
    const view = expiredCardView("gone");
    expect(view).toEqual({ content: "gone", embeds: [], components: [] });
  });
});

describe("collectorEndAction — every stop reason", () => {
  // Every reason discord.js raises, plus every reason this codebase passes to
  // stop(), plus a reason nobody has invented yet.
  const SEAM_REASONS = [
    "edit",
    "cancel",
    "saved",
    "created",
    "attached",
    "cloned_attached",
    "migrated",
    "user_closed",
    "resume",
    "abandon",
  ];
  const UNREGISTERED = "a-reason-added-in-2027";
  const ALL = [...BUILTIN_COLLECTOR_STOP_REASONS, ...SEAM_REASONS, UNREGISTERED];

  for (const reason of ALL) {
    const expected = CARD_GONE_STOP_REASONS.has(reason) ? "none" : "expire";
    it(`"${reason}" → ${expected} when the handler did not settle`, () => {
      expect(collectorEndAction(reason, { settled: false })).toBe(expected);
    });
  }

  it("a handler that already settled never double-renders", () => {
    for (const reason of ALL) {
      expect(collectorEndAction(reason, { settled: true })).toBe("none");
    }
  });

  it("an unregistered reason fails safe (expires) rather than leaving controls", () => {
    expect(collectorEndAction(UNREGISTERED, { settled: false })).toBe("expire");
  });
});

describe("collector end — stopped cards never keep enabled components", () => {
  const REASONS = [
    ...BUILTIN_COLLECTOR_STOP_REASONS,
    "edit",
    "cancel",
    "saved",
    "created",
    "user_closed",
    "a-reason-added-in-2027",
  ];

  for (const reason of REASONS) {
    it(`stop("${reason}") leaves nothing clickable`, async () => {
      const card = makeCard();
      expect(hasEnabledComponents(card.current().components)).toBe(true);

      card.collector.stop(reason);
      await Promise.resolve();
      await Promise.resolve();

      if (CARD_GONE_STOP_REASONS.has(reason)) {
        // The message itself is gone; editing it would only throw.
        expect(card.renders).toHaveLength(1);
      } else {
        expect(card.renders.length).toBeGreaterThan(1);
        expect(hasEnabledComponents(card.current().components)).toBe(false);
      }
      // Either way the collector is closed: no click can be delivered.
      expect(await card.collector.click("x:run:1")).toBe(false);
    });
  }

  it("a timeout expires the card exactly once, even if end fires again", async () => {
    const card = makeCard();
    card.collector.stop("time");
    await Promise.resolve();
    await Promise.resolve();
    const afterFirst = card.renders.length;
    await card.lifecycle.handleEnd("time");
    expect(card.renders).toHaveLength(afterFirst);
    expect(card.lifecycle.state).toBe("expired");
  });
});

describe("terminal actions — the second click is impossible", () => {
  // One case per terminal shape used in the orchestrator.
  const TERMINAL: Array<{ name: string; run: (l: CardLifecycle) => Promise<boolean> }> = [
    { name: "terminal (replace)", run: (l) => l.terminal("saved", { content: "saved", embeds: [], components: [] }) },
    { name: "terminal (delete)", run: (l) => l.dispose("user_closed") },
    { name: "transition (open editor)", run: (l) => l.transition("edit", { content: "editing…", embeds: [], components: [] }) },
    { name: "expire", run: (l) => l.expire("time") },
  ];

  for (const variant of TERMINAL) {
    it(`${variant.name}: the control is gone before a second click can land`, async () => {
      const card = makeCard();
      let handlerRuns = 0;
      card.collector.on("collect", async () => {
        handlerRuns++;
        await variant.run(card.lifecycle);
      });

      expect(await card.collector.click("x:del:1")).toBe(true);
      // Discord refuses the second click: the collector is closed.
      expect(await card.collector.click("x:del:1")).toBe(false);
      expect(handlerRuns).toBe(1);

      if (variant.name !== "terminal (delete)") {
        expect(hasEnabledComponents(card.current().components)).toBe(false);
      }
    });
  }

  it("a double-click during the replacement render still cannot re-run the action", async () => {
    let release: () => void = () => {};
    const slowRender = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const card = makeCard({
      render: async () => {
        if (!first) return;
        first = false;
        await slowRender;
      },
    });
    let handlerRuns = 0;
    card.collector.on("collect", async () => {
      handlerRuns++;
      await card.lifecycle.terminal("abandon", { content: "done", embeds: [], components: [] });
    });

    const inFlight = card.collector.click("x:del:1");
    // The render has not resolved yet, but the collector is already closed.
    expect(await card.collector.click("x:del:1")).toBe(false);
    release();
    await inFlight;
    expect(handlerRuns).toBe(1);
    expect(hasEnabledComponents(card.current().components)).toBe(false);
  });

  it("a duplicate settle after the fact is a no-op", async () => {
    const card = makeCard();
    expect(await card.lifecycle.terminal("saved", { content: "a", embeds: [], components: [] })).toBe(true);
    expect(await card.lifecycle.terminal("saved", { content: "b", embeds: [], components: [] })).toBe(false);
    expect(card.current().content).toBe("a");
    expect(card.lifecycle.reason).toBe("saved");
  });
});

describe("state refresh (repeatable)", () => {
  it("rebuilds from authoritative state and keeps the card live", async () => {
    const card = makeCard();
    let rows = ["a", "b"];
    const build = (): CardView => ({
      content: rows.join(","),
      embeds: [],
      components: rows.length ? [liveRow()] : [],
    });

    rows = ["a"];
    expect(await card.lifecycle.refresh(build())).toBe(true);
    expect(card.current().content).toBe("a");
    expect(card.lifecycle.settled).toBe(false);
    expect(await card.collector.click("x:run:1")).toBe(true);

    // Last row consumed: the rebuild has no controls left to offer.
    rows = [];
    await card.lifecycle.refresh(build());
    expect(hasEnabledComponents(card.current().components)).toBe(false);
  });

  it("a refresh after the card settled cannot bring controls back", async () => {
    const card = makeCard();
    await card.lifecycle.terminal("saved", { content: "saved", embeds: [], components: [] });
    expect(await card.lifecycle.refresh({ content: "live again", embeds: [], components: [liveRow()] })).toBe(false);
    expect(hasEnabledComponents(card.current().components)).toBe(false);
  });
});

describe("transition — no second live-looking listing is left behind", () => {
  it("the originating card is frozen before the editor opens", async () => {
    const card = makeCard();
    const order: string[] = [];
    card.collector.on("collect", async () => {
      await card.lifecycle.transition("edit", { content: "✏️ Editing…", embeds: [], components: [] });
      order.push(
        hasEnabledComponents(card.current().components) ? "list-still-live" : "list-frozen"
      );
      order.push("editor-opened");
    });

    await card.collector.click("x:edit:1");
    expect(order).toEqual(["list-frozen", "editor-opened"]);
    expect(card.lifecycle.state).toBe("transition");
  });
});

describe("render failures never take the action down", () => {
  it("an expired interaction token is reported, not thrown", async () => {
    const collector = new FakeCollector();
    const errors: string[] = [];
    const lifecycle = new CardLifecycle({
      render: async () => {
        throw new Error("Unknown Webhook");
      },
      stop: (reason) => collector.stop(reason),
      expired: () => expiredCardView("gone"),
      onError: (_err, phase) => errors.push(phase),
    });

    await expect(lifecycle.terminal("saved", { content: "x" })).resolves.toBe(true);
    expect(errors).toEqual(["terminal"]);
    expect(collector.stopped).toBe("saved");
  });
});

// --- Repo-wide invariant --------------------------------------------------
//
// The point of #159 is that this class of bug cannot come back one card at a
// time. These scans fail if a new collector is added without the lifecycle, or
// if a stop/end path is hand-rolled around it again.

describe("orchestrator lifecycle invariant", () => {
  it("every component collector is paired with the shared lifecycle", () => {
    const collectors = ORCHESTRATOR.match(/\.createMessageComponentCollector\(/g) ?? [];
    const attached = ORCHESTRATOR.match(/this\.attachListLifecycle\(/g) ?? [];
    expect(collectors.length).toBeGreaterThan(0);
    expect(attached.length).toBe(collectors.length);
  });

  it("no collector stops or end handlers are hand-rolled outside the lifecycle", () => {
    expect(ORCHESTRATOR).not.toMatch(/collector\.stop\(/);
    expect(ORCHESTRATOR).not.toMatch(/collector\.on\("end"/);
  });

  it("every ephemeral Voice Console confirmation branch settles component-free", () => {
    const CONFIRMATIONS = [
      "fanout-keep",
      "fanout-cancel",
      "end-cancel",
      "end-preserve",
      "end-discard",
      "edit-cancel",
    ];
    for (const action of CONFIRMATIONS) {
      const block = actionBlock(ORCHESTRATOR, action);
      expect(block, `no handler block found for "${action}"`).toBeTruthy();
      expect(
        block!.includes("settleVoiceConsoleConfirmation"),
        `"${action}" must end via settleVoiceConsoleConfirmation`
      ).toBe(true);
    }
  });

  it("the confirmation settle always renders zero components", () => {
    const block = ORCHESTRATOR.slice(
      ORCHESTRATOR.indexOf("private async settleVoiceConsoleConfirmation")
    ).slice(0, 1200);
    expect(block).toContain("components: [],");
  });
});

/**
 * The balanced `if (… action === "<name>" …) { … }` block from the source.
 * Several branches test two actions at once, so the match is on the condition
 * fragment rather than the start of the `if`.
 */
function actionBlock(source: string, action: string): string | null {
  const hit = source.indexOf(`action === "${action}"`);
  if (hit === -1) return null;
  const marker = source.lastIndexOf("if (", hit);
  if (marker === -1) return null;
  const open = source.indexOf("{", hit);
  if (open === -1) return null;
  let depth = 0;
  for (let idx = open; idx < source.length; idx++) {
    const ch = source[idx];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(marker, idx + 1);
    }
  }
  return null;
}
