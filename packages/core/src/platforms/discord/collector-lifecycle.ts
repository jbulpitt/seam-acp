/**
 * Card lifecycle for Discord component collectors (#159).
 *
 * A card that has already spent its backing state must never keep a control
 * that looks clickable. Clicking one is not a no-op — it surfaces an
 * "expired"/"missing state" error for an action the card still advertises.
 *
 * Every component action must therefore finish in exactly one of four states:
 *
 * 1. **Repeatable** — rebuild the originating card from authoritative state
 *    and keep only the controls that are still valid (`refresh`).
 * 2. **Transition** — freeze/replace the originating card *before* opening the
 *    next editor or view, so a second live-looking listing is never left
 *    behind (`transition`).
 * 3. **Terminal** — replace (`terminal`) or delete (`dispose`) the originating
 *    card and remove all components.
 * 4. **Expired** — mark the card expired and remove all components (`expire`,
 *    driven from the collector's `end` event by `handleEnd`).
 *
 * The helper is deliberately free of `discord.js` imports: it talks to a
 * structural host (`render` / `stop`), so the invariant is unit-testable
 * without a gateway connection.
 */

/** The subset of a Discord message edit payload a card lifecycle touches. */
export interface CardView {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
}

/** The four legal end states of an interactive card. */
export type CardLifecycleState = "repeatable" | "transition" | "terminal" | "expired";

/**
 * `discord.js` stop reasons that mean the card itself is gone. There is
 * nothing left to edit, so the expiry render is skipped (an edit here would
 * only throw `Unknown Message`).
 */
export const CARD_GONE_STOP_REASONS: ReadonlySet<string> = new Set([
  "messageDelete",
  "channelDelete",
  "guildDelete",
  "threadDelete",
]);

/**
 * Stop reasons `discord.js` raises on its own. Anything not listed here is a
 * reason *we* passed to `stop(...)`; both kinds are handled the same way, and
 * an unrecognised reason deliberately falls through to "expire" so a newly
 * introduced stop reason can never leave live-looking controls behind.
 */
export const BUILTIN_COLLECTOR_STOP_REASONS: readonly string[] = [
  "time",
  "idle",
  "limit",
  "componentType",
  "messageDelete",
  "channelDelete",
  "guildDelete",
  "threadDelete",
  "user",
];

/** What the collector's `end` event should do with the originating card. */
export type CollectorEndAction = "expire" | "none";

/**
 * Pure decision for a collector `end`. "expire" is the default for every
 * unknown reason: a stop we do not recognise is still a stop, and the card
 * must not keep advertising actions no collector will answer.
 */
export function collectorEndAction(
  reason: string,
  opts: { settled: boolean }
): CollectorEndAction {
  if (opts.settled) return "none";
  if (CARD_GONE_STOP_REASONS.has(reason)) return "none";
  return "expire";
}

/** A copy of `view` guaranteed to carry no components. */
export function inertView(view: CardView): CardView {
  return { ...view, components: [] };
}

/** A component-free "this card is spent" view: text only. */
export function expiredCardView(text: string): CardView {
  return { content: text, embeds: [], components: [] };
}

function toPlain(node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined;
  const obj = node as Record<string, unknown>;
  if (typeof obj.toJSON === "function") {
    try {
      const json = (obj.toJSON as () => unknown)();
      if (json && typeof json === "object") return json as Record<string, unknown>;
    } catch {
      /* builder not complete enough to serialise — fall back to its raw data */
    }
  }
  if (obj.data && typeof obj.data === "object") {
    return obj.data as Record<string, unknown>;
  }
  return obj;
}

/**
 * Count the still-clickable components in a rendered card. Accepts raw API
 * payloads, `discord.js` builders, or any mix of the two; a component is
 * "enabled" when it is a leaf control that is not explicitly disabled.
 */
export function countEnabledComponents(components: unknown): number {
  if (components == null) return 0;
  if (Array.isArray(components)) {
    return components.reduce<number>((sum, child) => sum + countEnabledComponents(child), 0);
  }
  const plain = toPlain(components);
  if (!plain) return 0;
  const children = plain.components;
  if (Array.isArray(children)) return countEnabledComponents(children);
  const isLeaf =
    "custom_id" in plain || "customId" in plain || "url" in plain || "type" in plain;
  if (!isLeaf) return 0;
  return plain.disabled === true ? 0 : 1;
}

/** True when the card still shows a control a user could click. */
export function hasEnabledComponents(components: unknown): boolean {
  return countEnabledComponents(components) > 0;
}

/** What a `CardLifecycle` needs from its card + collector. */
export interface CardLifecycleHost {
  /** Replace the originating card (typically `interaction.editReply`). */
  render(view: CardView): Promise<void>;
  /** Stop the backing collector. Must halt collection synchronously. */
  stop(reason: string): void;
  /** Build the component-free view shown when the collector expires. */
  expired(reason: string): CardView;
  /** Rendering a settle is best-effort; failures land here instead of throwing. */
  onError?(err: unknown, phase: CardLifecycleState, reason: string): void;
}

/**
 * Enforces the four-state invariant for one interactive card.
 *
 * Settling is one-way and idempotent: the collector is stopped *before* the
 * (awaited) re-render, so a second click on a terminal control cannot be
 * collected even during the round-trip, and a late duplicate settle is a
 * no-op rather than a second mutation.
 */
export class CardLifecycle {
  private settledState: { state: CardLifecycleState; reason: string } | null = null;

  constructor(private readonly host: CardLifecycleHost) {}

  /** True once the card has reached a transition/terminal/expired state. */
  get settled(): boolean {
    return this.settledState !== null;
  }

  /** The state the card settled into, or `null` while it is still live. */
  get state(): CardLifecycleState | null {
    return this.settledState?.state ?? null;
  }

  /** The reason the card settled with, or `null` while it is still live. */
  get reason(): string | null {
    return this.settledState?.reason ?? null;
  }

  /**
   * State 1 — repeatable. Rebuild the card from authoritative state. A refresh
   * after the card has settled is ignored: a spent card must never regain
   * controls.
   */
  async refresh(view: CardView): Promise<boolean> {
    if (this.settledState) return false;
    try {
      await this.host.render(view);
    } catch (err) {
      this.host.onError?.(err, "repeatable", "refresh");
      return false;
    }
    return true;
  }

  /**
   * State 2 — transition. Freeze the originating card (components removed)
   * before the next editor/view opens, so the user is never left holding two
   * live-looking cards for the same object.
   */
  transition(reason: string, view: CardView): Promise<boolean> {
    return this.settle("transition", reason, view);
  }

  /**
   * State 2 — transition, where an external acknowledgement must be the first
   * request out.
   *
   * When the click that triggers the transition is a *component* interaction,
   * two constraints collide. The collector has to close synchronously, before
   * any `await`, or two concurrent clicks both open an editor. But the freeze
   * repaint targets the *original* interaction's token — a separate REST
   * request — and dispatching it first queues it ahead of the component's ack
   * inside Discord's 3s budget, which under per-route backoff fails the click.
   *
   * Settling already happens synchronously; this orders `acknowledge` between
   * the stop and the repaint, so the collector is closed before the first
   * await *and* the ack is the first request on the wire.
   */
  transitionWithAck(
    reason: string,
    view: CardView,
    acknowledge: () => Promise<void>
  ): Promise<boolean> {
    return this.settle("transition", reason, view, acknowledge);
  }

  /** State 3 — terminal. Replace the card with a component-free result. */
  terminal(reason: string, view: CardView): Promise<boolean> {
    return this.settle("terminal", reason, view);
  }

  /**
   * State 3 — terminal, by deletion. The caller has already removed the card,
   * so there is nothing to render; this only stops the collector and blocks
   * any later settle (including the expiry render).
   */
  async dispose(reason: string): Promise<boolean> {
    if (this.settledState) return false;
    this.settledState = { state: "terminal", reason };
    this.host.stop(reason);
    return true;
  }

  /** State 4 — expired. Mark the card expired and drop every component. */
  expire(reason: string, view?: CardView): Promise<boolean> {
    return this.settle("expired", reason, view ?? this.host.expired(reason));
  }

  /**
   * Wire this to the collector's `end` event. Reasons the handler already
   * settled, and reasons that mean the card is gone, render nothing; every
   * other reason — including any reason added later — expires the card.
   */
  async handleEnd(reason: string): Promise<void> {
    if (collectorEndAction(reason, { settled: this.settled }) === "none") return;
    await this.expire(reason);
  }

  private async settle(
    state: CardLifecycleState,
    reason: string,
    view: CardView,
    acknowledge?: () => Promise<void>
  ): Promise<boolean> {
    if (this.settledState) return false;
    this.settledState = { state, reason };
    // Stop first, synchronously: collection must be closed before any await
    // below, or a double-click lands while the replacement is still in flight.
    try {
      this.host.stop(reason);
    } catch (err) {
      this.host.onError?.(err, state, reason);
    }
    // Then the caller's acknowledgement, ahead of the repaint, so it is the
    // first request on the wire. A failed ack still leaves the card frozen.
    if (acknowledge) {
      try {
        await acknowledge();
      } catch (err) {
        this.host.onError?.(err, state, reason);
      }
    }
    try {
      await this.host.render(inertView(view));
    } catch (err) {
      // Interaction token expired, card deleted, … — the collector is already
      // stopped, so the action itself still stands.
      this.host.onError?.(err, state, reason);
    }
    return true;
  }
}

/**
 * Single-flight guard for **repeatable** cards.
 *
 * A terminal or transition action is protected by the lifecycle itself: the
 * collector stops before the awaited re-render, so a second click cannot even
 * be delivered. A repeatable card has no such protection *by design* — it stays
 * live so the operator can act on the next row — which means two rapid clicks
 * on the same control can both enter the handler before the first mutation
 * lands and the authoritative rebuild removes it.
 *
 * Claims are keyed (by row id, not by action) so acting twice on one subject is
 * impossible while its mutation is in flight, without serialising unrelated
 * rows behind each other.
 */
export class ActionGuard {
  private readonly inFlight = new Set<string>();

  /** Take `key`. `false` means another click already owns it. */
  claim(key: string): boolean {
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return true;
  }

  release(key: string): void {
    this.inFlight.delete(key);
  }

  /** True while `key` has a mutation in flight. */
  isBusy(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Number of claims currently held. */
  get pending(): number {
    return this.inFlight.size;
  }
}

/** The minimum a collector must expose for `attachCardLifecycle`. */
export interface StoppableCollector {
  on(event: "end", listener: (collected: unknown, reason: string) => void): unknown;
  stop(reason?: string): void;
}

/**
 * Build a `CardLifecycle` for a live collector and register its `end` handler.
 *
 * Every `createMessageComponentCollector` in the Discord orchestrator is
 * paired with exactly one of these — that pairing is the enforced invariant
 * (`test/collector-lifecycle.test.ts`), and it is what guarantees no card can
 * time out while still showing enabled controls.
 */
export function attachCardLifecycle(
  collector: StoppableCollector,
  opts: {
    render: (view: CardView) => Promise<void>;
    expired: (reason: string) => CardView;
    onError?: (err: unknown, phase: CardLifecycleState, reason: string) => void;
  }
): CardLifecycle {
  const lifecycle = new CardLifecycle({
    render: opts.render,
    stop: (reason) => collector.stop(reason),
    expired: opts.expired,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
  collector.on("end", (_collected, reason) => {
    void lifecycle.handleEnd(reason);
  });
  return lifecycle;
}
