import type { AdapterErrorKind, ErrorRule } from "@seam/adapters";

/** Upstream policy DATA for the frozen resolver (#441). Ship these rows with
 * work; do not teach a rarely updated daemon provider semantics. Unknown
 * billing/effects stay unknown: a failure can arrive after a paid tool turn.
 * Terminal describes this request, not permission to abandon the work. */
const POLICY: Record<Exclude<AdapterErrorKind, "unclassified">,
  Pick<ErrorRule["then"], "transience" | "startRung" | "needsHuman">> = {
  rate_limit: { transience: "transient", startRung: 1, needsHuman: "no" },
  quota_exhausted: { transience: "terminal", startRung: 2, needsHuman: "unknown" },
  auth_expired: { transience: "terminal", startRung: 2, needsHuman: "yes" },
  auth_contention: { transience: "transient", startRung: 1, needsHuman: "no" },
  auth_required: { transience: "terminal", startRung: 2, needsHuman: "yes" },
  permission_denied: { transience: "terminal", startRung: 2, needsHuman: "unknown" },
  session_gone: { transience: "terminal", startRung: 4, needsHuman: "no" },
  connection_closed: { transience: "transient", startRung: 3, needsHuman: "no" },
  protocol_error: { transience: "unknown", startRung: 1, needsHuman: "unknown" },
  agent_exit: { transience: "unknown", startRung: 3, needsHuman: "unknown" },
  overloaded: { transience: "transient", startRung: 1, needsHuman: "no" },
  invalid_request: { transience: "terminal", startRung: 4, needsHuman: "unknown" },
  context_length: { transience: "terminal", startRung: 4, needsHuman: "no" },
  model_not_found: { transience: "terminal", startRung: 2, needsHuman: "no" },
  capability_absent: { transience: "terminal", startRung: 2, needsHuman: "unknown" },
  server_error: { transience: "transient", startRung: 1, needsHuman: "no" },
  timeout: { transience: "transient", startRung: 1, needsHuman: "unknown" },
  cancelled: { transience: "terminal", startRung: 5, needsHuman: "no" },
};

export const DEFAULT_ERROR_RULES: readonly ErrorRule[] = Object.freeze(
  Object.entries(POLICY).map(([errorKind, policy]) => Object.freeze({
    id: errorKind,
    when: Object.freeze({ errorKind: errorKind as Exclude<AdapterErrorKind, "unclassified"> }),
    then: Object.freeze({
      ...policy,
      charged: "unknown" as const,
      sideEffects: "unknown" as const,
      sessionUsable: errorKind === "session_gone" ? "no" as const : "unknown" as const,
      // An explicit cancellation is not an unexpected failure. Preserve stop;
      // every genuine failure still has a visible recovery route (#448).
      action: errorKind === "cancelled" ? "stop" as const : "recover" as const,
    }),
  })),
);
