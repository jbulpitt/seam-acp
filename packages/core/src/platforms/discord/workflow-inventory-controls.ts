/**
 * Click handling for the `/seam workflows` interrupted inventory (#159).
 *
 * Extracted from the orchestrator so the *behaviour* — not just the card
 * layout — is testable: what a click does, how the card is rebuilt afterwards,
 * and what happens when two clicks land at once.
 *
 * The inventory is a **repeatable** card: Resume/Abandon acts on one row and
 * the list stays live for the rest. That is exactly why the collector cannot
 * be the concurrency guard here — it is still collecting, on purpose — so this
 * controller adds the two guarantees the collector no longer provides:
 *
 * - a synchronous per-row claim, so one turn is mutated exactly once;
 * - card-level serialization of rebuild-and-apply, so an older render can
 *   never land after a newer one and resurrect controls it had removed.
 */
import { SerialQueue } from "../../core/serial-queue.js";
import { ActionGuard, type CardView } from "./collector-lifecycle.js";

export type WorkflowInventoryAction = "resume" | "abandon" | "page";

/** What one `handle` call did, for logging and tests. */
export type WorkflowInventoryOutcome =
  | "ignored" // not one of ours, or a malformed id
  | "paged" // read-only page change
  | "mutated" // the row's Resume/Abandon ran
  | "dropped"; // a concurrent click on a row already being mutated

/** Card-scoped collaborators: one set per rendered inventory. */
export interface WorkflowInventoryPort {
  resume(id: string): Promise<string>;
  abandon(id: string): Promise<string>;
  /** Rebuild the card from authoritative state. */
  render(page: number): Promise<{ embeds: unknown[]; components: unknown[]; page: number }>;
  /** Repeatable re-render — the card stays live. */
  refresh(view: CardView): Promise<boolean>;
  /** Terminal replace — nothing actionable is left. */
  terminal(reason: string, view: CardView): Promise<boolean>;
}

/** Click-scoped collaborators: one set per interaction. */
export interface WorkflowInventoryClickPort {
  /** Ack inside Discord's 3s window. */
  ack(): Promise<void>;
  followUp(text: string): Promise<void>;
}

/** `wf:<action>:<arg>` — no revision, so #152 pagination composes. */
export function parseWorkflowInventoryClick(
  customId: string
): { action: WorkflowInventoryAction; arg: string } | null {
  const [ns, action, ...rest] = customId.split(":");
  if (ns !== "wf") return null;
  const arg = rest.join(":");
  if (!arg) return null;
  if (action === "resume" || action === "abandon" || action === "page") {
    return { action, arg };
  }
  return null;
}

export class WorkflowInventoryController {
  /** Per-row claims: two clicks on one turn must mutate it exactly once. */
  private readonly guard = new ActionGuard();
  /**
   * Card-level render serialization. Per-row exclusion alone is not enough:
   * a page change and a different row's mutation can rebuild concurrently, and
   * whichever *finishes* last wins — so a slow older rebuild could land after a
   * newer authoritative one and put back controls the newer one removed.
   * Reading state and writing the card is therefore one critical section.
   */
  private readonly renders = new SerialQueue();
  private page = 0;

  constructor(private readonly port: WorkflowInventoryPort) {}

  /** The page the card is currently showing. */
  get currentPage(): number {
    return this.page;
  }

  /** True while any row mutation is in flight. */
  get busy(): boolean {
    return this.guard.pending > 0;
  }

  async handle(
    customId: string,
    click: WorkflowInventoryClickPort
  ): Promise<WorkflowInventoryOutcome> {
    const parsed = parseWorkflowInventoryClick(customId);
    if (!parsed) return "ignored";

    if (parsed.action === "page") {
      const requested = Number(parsed.arg);
      // The id is ours, so it gets acked even when its payload is unusable —
      // only a customId belonging to someone else is left unanswered.
      await click.ack();
      if (!Number.isFinite(requested)) return "ignored";
      await this.rerender(requested, parsed.action);
      return "paged";
    }

    // Claim BEFORE the first await, so the claim is synchronous with respect
    // to any other click already queued on this row. Keyed by row rather than
    // by action: Resume and Abandon mutate the same turn, so firing one while
    // the other is in flight is the same double-execution.
    const claimed = this.guard.claim(parsed.arg);
    // Ack either way, and before touching the card — a click we are about to
    // drop must still not resolve as "interaction failed".
    await click.ack();
    if (!claimed) return "dropped";
    try {
      const result =
        parsed.action === "resume"
          ? await this.port.resume(parsed.arg)
          : await this.port.abandon(parsed.arg);
      await this.rerender("current", parsed.action);
      await click.followUp(result);
      return "mutated";
    } finally {
      this.guard.release(parsed.arg);
    }
  }

  /**
   * Rebuild from authoritative state and apply, as one serialized step, so the
   * consumed row's controls disappear atomically with the action rather than in
   * a separate reply. `"current"` resolves *inside* the critical section, so a
   * page change queued ahead is honoured rather than overwritten.
   */
  private rerender(page: number | "current", reason: string): Promise<void> {
    return this.renders.run(async () => {
      const rebuilt = await this.port.render(page === "current" ? this.page : page);
      this.page = rebuilt.page;
      if (rebuilt.components.length === 0) {
        // Nothing actionable left: terminal state, no components at all.
        await this.port.terminal(reason, { embeds: rebuilt.embeds, components: [] });
      } else {
        // Explicit keys: `rebuilt.page` is bookkeeping, not a Discord field.
        await this.port.refresh({ embeds: rebuilt.embeds, components: rebuilt.components });
      }
    });
  }
}
