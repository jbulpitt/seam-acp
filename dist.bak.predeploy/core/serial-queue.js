/**
 * A minimal FIFO async serializer.
 *
 * Tasks queued via `run()` execute strictly one at a time, in the order they
 * were queued: the next task starts only after the previous one's promise has
 * settled. Enqueueing is synchronous, so call order — not completion timing —
 * fixes execution order.
 *
 * Why this exists: some upstream sources dispatch work concurrently. The ACP
 * SDK's read loop, for instance, calls its message handler without awaiting it,
 * so a later notification's handler can start while an earlier one is parked on
 * an `await`. When those handlers mutate shared state (a streamed-text buffer,
 * a send pipeline), the interleaving reorders output. Funnelling them through a
 * SerialQueue restores arrival order end-to-end.
 *
 * A task that throws/rejects does NOT poison the queue: its failure is isolated
 * so subsequent tasks still run, while `run()` still rejects to *that task's*
 * caller, so callers can await and handle their own errors.
 */
export class SerialQueue {
    tail = Promise.resolve();
    /**
     * Queue `task` to run after all previously-queued tasks have settled.
     * Returns a promise that settles with `task`'s result.
     */
    run(task) {
        const result = this.tail.then(() => task());
        // Advance the tail to a never-rejecting promise so one task's failure
        // cannot break the chain for the tasks queued behind it.
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
    /** Resolves once everything queued so far has settled. */
    idle() {
        return this.tail.then(() => undefined);
    }
}
//# sourceMappingURL=serial-queue.js.map