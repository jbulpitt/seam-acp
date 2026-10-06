import type { Logger } from "../lib/logger.js";

/** Delivery diagnostics only; callers retain their existing error handling. */
export class AssistantOutputLog {
  readonly logger: Logger;
  private readonly counts = {
    textChunks: 0, textChars: 0, thoughtChunks: 0, thoughtChars: 0,
    deliveredSegments: 0, deliveredChars: 0,
    edits: 0, lastEditChars: 0,
    failedSegments: 0, failedChars: 0,
    skippedSegments: 0, skippedChars: 0,
    routedSegments: 0, routedChars: 0,
  };

  constructor(logger: Logger, context: {
    thread: string; session: string; turn?: string; dispatch?: string;
  }) {
    this.logger = logger.child(context);
  }

  receive(event: { kind: string; text?: string }): void {
    if (event.kind === "agent-text") {
      this.counts.textChunks += 1;
      this.counts.textChars += event.text?.length ?? 0;
    } else if (event.kind === "agent-thought") {
      if (!this.counts.thoughtChunks) {
        this.logger.info({ reason: "agent-thought is status output, not assistant text" },
          "assistant output routed to thinking excerpt");
      }
      this.counts.thoughtChunks += 1;
      this.counts.thoughtChars += event.text?.length ?? 0;
    }
  }

  async deliver<T>(text: string, operation: string, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      if (operation === "edit") {
        this.counts.edits += 1;
        this.counts.lastEditChars = text.length;
      } else {
        this.counts.deliveredSegments += 1;
        this.counts.deliveredChars += text.length;
      }
      this.logger.info({ operation, chars: text.length }, "assistant output delivered");
      return result;
    } catch (err) {
      this.counts.failedSegments += 1;
      this.counts.failedChars += text.length;
      this.logger.warn({ err, operation, chars: text.length }, "assistant output delivery failed");
      throw err;
    }
  }

  skip(text: string, reason: string): void {
    this.counts.skippedSegments += 1;
    this.counts.skippedChars += text.length;
    this.logger.warn({ reason, chars: text.length }, "assistant output skipped");
  }

  route(text: string, reason: string): void {
    this.counts.routedSegments += 1;
    this.counts.routedChars += text.length;
    this.logger.info({ reason, chars: text.length }, "assistant output routed");
  }

  summary(bufferedChars = 0): void {
    this.logger.info({ ...this.counts, bufferedChars, thoughtDestination: "thinking excerpt" },
      "assistant output summary");
  }
}
