import { describe, it, expect } from "vitest";
import {
  WorkflowInventoryController,
  parseWorkflowInventoryClick,
  type WorkflowInventoryClickPort,
  type WorkflowInventoryPort,
} from "../packages/core/src/platforms/discord/workflow-inventory-controls.js";
import type { CardView } from "../packages/core/src/platforms/discord/collector-lifecycle.js";

/** Drain every pending microtask — a macrotask tick, not just `await null`. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A fake inventory backed by a mutable set of actionable row ids.
 *
 * `render` snapshots the store at *call* time and only then awaits its hook,
 * which is what makes an ordering bug observable: a rebuild that reads early
 * but writes late is exactly how a stale card resurrects consumed controls.
 */
function makePort(initial: string[]) {
  const state = new Set(initial);
  const log: string[] = [];
  const port = {
    state,
    log,
    resumeCalls: [] as string[],
    abandonCalls: [] as string[],
    renderCalls: [] as number[],
    /** Every card write, in the order it landed. */
    applied: [] as Array<{ kind: "refresh" | "terminal"; rows: string[]; reason?: string }>,
    hooks: {} as {
      resume?: (id: string) => Promise<void>;
      abandon?: (id: string) => Promise<void>;
      render?: (page: number) => Promise<void>;
    },
    async resume(id: string) {
      port.resumeCalls.push(id);
      log.push(`resume:${id}`);
      await port.hooks.resume?.(id);
      state.delete(id);
      return `resumed ${id}`;
    },
    async abandon(id: string) {
      port.abandonCalls.push(id);
      log.push(`abandon:${id}`);
      await port.hooks.abandon?.(id);
      state.delete(id);
      return `abandoned ${id}`;
    },
    async render(page: number) {
      port.renderCalls.push(page);
      log.push(`render:${page}`);
      const snapshot = [...state];
      await port.hooks.render?.(page);
      return {
        embeds: [{ rows: snapshot.join(",") }],
        components: snapshot.map((id) => ({ id })),
        page,
      };
    },
    async refresh(view: CardView) {
      const rows = ((view.components ?? []) as Array<{ id: string }>).map((c) => c.id);
      port.applied.push({ kind: "refresh", rows });
      log.push(`refresh:[${rows.join(",")}]`);
      return true;
    },
    async terminal(reason: string, _view: CardView) {
      port.applied.push({ kind: "terminal", rows: [], reason });
      log.push(`terminal:${reason}`);
      return true;
    },
  };
  return port satisfies WorkflowInventoryPort & Record<string, unknown>;
}

function makeClick(log?: string[]) {
  const state = { acks: 0, followUps: [] as string[] };
  const port: WorkflowInventoryClickPort = {
    ack: async () => {
      state.acks++;
      log?.push("ack");
    },
    followUp: async (text) => {
      state.followUps.push(text);
    },
  };
  return { port, state };
}

describe("parseWorkflowInventoryClick", () => {
  it("reads the wf:<action>:<arg> shape with no revision segment", () => {
    expect(parseWorkflowInventoryClick("wf:resume:del-1")).toEqual({ action: "resume", arg: "del-1" });
    expect(parseWorkflowInventoryClick("wf:abandon:del-1")).toEqual({ action: "abandon", arg: "del-1" });
    expect(parseWorkflowInventoryClick("wf:page:2")).toEqual({ action: "page", arg: "2" });
  });

  it("keeps colons inside an id", () => {
    expect(parseWorkflowInventoryClick("wf:resume:discord:thread:9")).toEqual({
      action: "resume",
      arg: "discord:thread:9",
    });
  });

  it("ignores other namespaces, unknown actions, and empty args", () => {
    expect(parseWorkflowInventoryClick("sl:run:1")).toBeNull();
    expect(parseWorkflowInventoryClick("pr:edit:1")).toBeNull();
    expect(parseWorkflowInventoryClick("wf:bogus:1")).toBeNull();
    expect(parseWorkflowInventoryClick("wf:resume:")).toBeNull();
    expect(parseWorkflowInventoryClick("wf:resume")).toBeNull();
  });
});

describe("concurrent clicks on one row", () => {
  // The regression QA asked for: this card stays live on purpose, so the
  // collector is not the guard — two rapid clicks would both reach the
  // mutation before the authoritative rebuild removed the control.
  it("a second click landing mid-mutation cannot run the mutation again", async () => {
    const port = makePort(["r1", "r2"]);
    const controller = new WorkflowInventoryController(port);
    const first = makeClick();
    const second = makeClick();

    const gate = deferred();
    let secondOutcome: Promise<string> | undefined;
    let reentered = false;
    port.hooks.resume = async () => {
      // Genuinely concurrent: this click arrives while resume is in flight.
      // Fired once, so a regression fails the assertions below rather than
      // recursing forever.
      if (!reentered) {
        reentered = true;
        secondOutcome = controller.handle("wf:resume:r1", second.port);
      }
      await gate.promise;
    };

    const firstOutcome = controller.handle("wf:resume:r1", first.port);
    await Promise.resolve();
    gate.resolve();

    expect(await firstOutcome).toBe("mutated");
    expect(await secondOutcome).toBe("dropped");
    expect(port.resumeCalls).toEqual(["r1"]);
    // The dropped click is still acknowledged — never "interaction failed".
    expect(second.state.acks).toBe(1);
    expect(second.state.followUps).toEqual([]);
    expect(first.state.followUps).toEqual(["resumed r1"]);
  });

  it("two clicks fired back-to-back mutate once", async () => {
    const port = makePort(["r1", "r2"]);
    const controller = new WorkflowInventoryController(port);
    const gate = deferred();
    port.hooks.resume = () => gate.promise;

    const a = controller.handle("wf:resume:r1", makeClick().port);
    const b = controller.handle("wf:resume:r1", makeClick().port);
    gate.resolve();

    expect(await a).toBe("mutated");
    expect(await b).toBe("dropped");
    expect(port.resumeCalls).toEqual(["r1"]);
  });

  it("Resume and Abandon race on the same row — the turn mutates once", async () => {
    const port = makePort(["r1", "r2"]);
    const controller = new WorkflowInventoryController(port);
    const gate = deferred();
    port.hooks.resume = () => gate.promise;

    const a = controller.handle("wf:resume:r1", makeClick().port);
    const b = controller.handle("wf:abandon:r1", makeClick().port);
    gate.resolve();

    expect(await a).toBe("mutated");
    expect(await b).toBe("dropped");
    expect(port.abandonCalls).toEqual([]);
  });

  it("different rows are not serialised behind each other", async () => {
    const port = makePort(["r1", "r2", "r3"]);
    const controller = new WorkflowInventoryController(port);
    const gate = deferred();
    port.hooks.resume = () => gate.promise;

    const a = controller.handle("wf:resume:r1", makeClick().port);
    const b = controller.handle("wf:abandon:r2", makeClick().port);
    gate.resolve();

    expect(await a).toBe("mutated");
    expect(await b).toBe("mutated");
    expect(port.resumeCalls).toEqual(["r1"]);
    expect(port.abandonCalls).toEqual(["r2"]);
  });

  it("the claim is released so the row can be acted on again later", async () => {
    const port = makePort(["r1", "r2"]);
    const controller = new WorkflowInventoryController(port);
    expect(await controller.handle("wf:resume:r1", makeClick().port)).toBe("mutated");
    expect(controller.busy).toBe(false);
    expect(await controller.handle("wf:resume:r1", makeClick().port)).toBe("mutated");
    expect(port.resumeCalls).toEqual(["r1", "r1"]);
  });

  it("a thrown mutation still releases the claim", async () => {
    const port = makePort(["r1", "r2"]);
    const controller = new WorkflowInventoryController(port);
    port.hooks.resume = async () => {
      throw new Error("store exploded");
    };
    await expect(controller.handle("wf:resume:r1", makeClick().port)).rejects.toThrow("store exploded");
    expect(controller.busy).toBe(false);
    port.hooks.resume = undefined as never;
    expect(await controller.handle("wf:resume:r1", makeClick().port)).toBe("mutated");
  });
});

describe("render ordering across keys", () => {
  // Per-row exclusion alone would leave this hole: a page change and a
  // different row's mutation rebuild concurrently, and the slower one lands
  // last — putting back a control the newer render had removed.
  it("a slow page render cannot land after a newer mutation's refresh", async () => {
    const port = makePort(["r1", "r2"]);
    const controller = new WorkflowInventoryController(port);
    const gate = deferred();
    let firstRender = true;
    port.hooks.render = async () => {
      if (!firstRender) return;
      firstRender = false;
      await gate.promise;
    };

    const paging = controller.handle("wf:page:1", makeClick().port);
    const mutating = controller.handle("wf:abandon:r1", makeClick().port);
    // Let the mutation run as far as it can while the page rebuild is parked.
    // Without card-level serialization it finishes and paints here, so the
    // parked older rebuild would repaint over it below.
    await flush();
    gate.resolve();
    expect(await paging).toBe("paged");
    expect(await mutating).toBe("mutated");

    // The last write must be the authoritative post-mutation state.
    expect(port.applied.at(-1)!.rows).toEqual(["r2"]);
    expect(port.applied.at(-1)!.rows).not.toContain("r1");
  });

  it("a slow row rebuild cannot land after another row's newer rebuild", async () => {
    const port = makePort(["r1", "r2", "r3"]);
    const controller = new WorkflowInventoryController(port);
    const gate = deferred();
    // The first row's rebuild reads the store now and paints later.
    let firstRender = true;
    port.hooks.render = async () => {
      if (!firstRender) return;
      firstRender = false;
      await gate.promise;
    };

    const a = controller.handle("wf:abandon:r1", makeClick().port);
    // r1 is consumed and its rebuild has already snapshotted [r2, r3]; it is
    // now parked mid-paint.
    await flush();
    const b = controller.handle("wf:abandon:r2", makeClick().port);
    // Without card-level serialization r2's rebuild paints [r3] here, and the
    // parked older paint below would put r2's controls straight back.
    await flush();
    gate.resolve();
    await Promise.all([a, b]);

    expect(port.applied.at(-1)!.rows).toEqual(["r3"]);
    expect(port.applied.at(-1)!.rows).not.toContain("r2");
  });

  it("a page change queued ahead of a mutation is honoured, not overwritten", async () => {
    const port = makePort(["r1", "r2"]);
    const controller = new WorkflowInventoryController(port);
    await controller.handle("wf:page:2", makeClick().port);
    expect(controller.currentPage).toBe(2);
    await controller.handle("wf:abandon:r1", makeClick().port);
    // The mutation rebuilt the page the card was actually showing.
    expect(port.renderCalls).toEqual([2, 2]);
  });
});

describe("card state after a mutation", () => {
  it("rebuilds the card from authoritative state instead of replying separately", async () => {
    const port = makePort(["r1", "r2"]);
    const controller = new WorkflowInventoryController(port);
    const click = makeClick();

    expect(await controller.handle("wf:abandon:r1", click.port)).toBe("mutated");
    expect(port.applied).toEqual([{ kind: "refresh", rows: ["r2"] }]);
    expect(click.state.followUps).toEqual(["abandoned r1"]);
  });

  it("goes terminal — no components at all — when the last row is consumed", async () => {
    const port = makePort(["r1"]);
    const controller = new WorkflowInventoryController(port);

    expect(await controller.handle("wf:abandon:r1", makeClick().port)).toBe("mutated");
    expect(port.applied).toEqual([{ kind: "terminal", rows: [], reason: "abandon" }]);
  });

  it("acknowledges the interaction before touching the original card", async () => {
    const log: string[] = [];
    const port = makePort(["r1", "r2"]);
    port.log.length = 0;
    const controller = new WorkflowInventoryController(port);
    const click = makeClick(log);
    // Share one ordered log across ack and card writes.
    const merged: string[] = [];
    const ordered: WorkflowInventoryClickPort = {
      ack: async () => {
        merged.push("ack");
        await click.port.ack();
      },
      followUp: async (t) => {
        merged.push("followUp");
        await click.port.followUp(t);
      },
    };
    const spyPort: WorkflowInventoryPort = {
      ...port,
      render: async (page) => {
        merged.push("render");
        return port.render(page);
      },
      refresh: async (view) => {
        merged.push("refresh");
        return port.refresh(view);
      },
    };
    const spyController = new WorkflowInventoryController(spyPort);
    await spyController.handle("wf:abandon:r1", ordered);
    expect(merged).toEqual(["ack", "render", "refresh", "followUp"]);
    expect(merged.indexOf("ack")).toBeLessThan(merged.indexOf("refresh"));
    void controller;
  });
});

describe("clicks that are not ours", () => {
  it("leaves another surface's customId unacknowledged", async () => {
    const port = makePort(["r1"]);
    const controller = new WorkflowInventoryController(port);
    const click = makeClick();
    expect(await controller.handle("sl:run:sch_1", click.port)).toBe("ignored");
    expect(click.state.acks).toBe(0);
    expect(port.applied).toEqual([]);
  });

  it("acknowledges an unusable page payload rather than leaving it hanging", async () => {
    const port = makePort(["r1"]);
    const controller = new WorkflowInventoryController(port);
    const click = makeClick();
    expect(await controller.handle("wf:page:not-a-number", click.port)).toBe("ignored");
    expect(click.state.acks).toBe(1);
    expect(port.applied).toEqual([]);
  });
});
