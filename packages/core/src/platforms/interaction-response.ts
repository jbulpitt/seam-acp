/** Modal-first actions cannot defer their initial response. */
export type InteractionResponseMode = "ephemeral" | "public" | "modal";

/** Preserve handler-entry reads while the acknowledgement travels to Discord. */
export function runAcknowledged<T>(acknowledgement: Promise<void>, handle: () => Promise<T>): Promise<T> {
  return Promise.all([acknowledgement, new Promise<T>(resolve => resolve(handle()))]).then(([, result]) => result);
}
