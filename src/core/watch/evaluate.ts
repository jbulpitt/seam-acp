/**
 * Watch predicate evaluators (#60) — the cheap poll that runs in the bridge, not
 * the model (D1). Each returns a `WatchEvalResult`: whether the condition
 * tripped, the captured event text, and a snapshot to persist for the next
 * comparison. A transient failure (a network blip, a missing file) must NOT kill
 * the watch — it returns `{ fired: false, error }` and the watch keeps polling
 * (`|| true` semantics).
 *
 * SOURCE ROLLOUT (D8): `file` and `http` are safe — a `stat` of a path and a
 * `GET` of a URL. `command` is a privileged capability: it executes an
 * agent-authored string, so it is refused here unless the deployment enabled it
 * AND the exact command is on the allowlist. That is a defense-in-depth backstop
 * to the registration-time refusal in `Orchestrator.createWatch` — the real gate
 * is at creation, but a watch persisted before the flag flipped must also be
 * refused at evaluation time.
 */
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { WatchEvent, WatchEvalResult } from "./types.js";
import {
  WATCH_HTTP_TIMEOUT_MS,
  WATCH_COMMAND_TIMEOUT_MS,
  WATCH_EVENT_TEXT_MAX,
} from "./types.js";

/** Deployment policy for the privileged `command` source (D8). */
export interface WatchCommandPolicy {
  /** WATCH_COMMAND_ENABLED — the flag gate. Default OFF. */
  enabled: boolean;
  /** Exact command strings that may run. A watch whose `spec` is not in this set
   *  is refused even when the flag is on — never shell-eval an arbitrary string. */
  allowlist: readonly string[];
}

/** Cap captured text so a chatty source can't inject an unbounded prompt. */
export function clampEventText(s: string): string {
  const t = s.trim();
  return t.length > WATCH_EVENT_TEXT_MAX
    ? `${t.slice(0, WATCH_EVENT_TEXT_MAX)}\n…(truncated)`
    : t;
}

/** Is this command permitted to run? Exact-match against the allowlist — no
 *  substring / prefix matching, because a prefix match ("git" allows
 *  "git; rm -rf") is exactly the injection D8 warns about. */
export function isCommandAllowed(spec: string, policy: WatchCommandPolicy): boolean {
  if (!policy.enabled) return false;
  const wanted = spec.trim();
  return policy.allowlist.some((c) => c.trim() === wanted);
}

/** `file` — existence / size / mtime change against the last observation. The
 *  first check establishes a baseline (records the signature, does not fire), so
 *  "wait for this file to appear/change" fires on the *next* differing check. */
async function evalFile(watch: WatchEvent): Promise<WatchEvalResult> {
  let signature: string;
  try {
    const st = await stat(watch.spec);
    signature = `exists:${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    signature = "absent";
  }
  if (watch.lastObserved === null) {
    // Baseline — record without firing.
    return { fired: false, eventText: "", observed: signature };
  }
  if (signature !== watch.lastObserved) {
    return {
      fired: true,
      eventText: clampEventText(
        `File ${watch.spec} changed: ${watch.lastObserved} → ${signature}`
      ),
      observed: signature,
    };
  }
  return { fired: false, eventText: "", observed: signature };
}

/** `http` — GET the URL and match. `match` config:
 *   - `"status:NNN"` → fire when the response status equals NNN;
 *   - any other non-empty string → fire when the body matches it as a regex;
 *   - absent → default change-detection (status + body length differs).
 *  A request that throws/times out is a transient failure: no fire, no death. */
async function evalHttp(watch: WatchEvent): Promise<WatchEvalResult> {
  let res: Response;
  try {
    res = await fetch(watch.spec, {
      signal: AbortSignal.timeout(WATCH_HTTP_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (err) {
    // Transient — one failed request must not kill the watch (D-sketch).
    return {
      fired: false,
      eventText: "",
      observed: watch.lastObserved,
      error: `http request failed: ${(err as Error).message}`,
    };
  }
  const status = res.status;
  const match = (watch.match ?? "").trim();

  if (match.startsWith("status:")) {
    const want = Number(match.slice("status:".length));
    if (Number.isFinite(want) && status === want) {
      return {
        fired: true,
        eventText: clampEventText(`HTTP ${watch.spec} returned status ${status}`),
        observed: `status:${status}`,
      };
    }
    return { fired: false, eventText: "", observed: `status:${status}` };
  }

  const body = await res.text().catch(() => "");
  if (match) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(match);
    } catch {
      re = null;
    }
    if (re && re.test(body)) {
      return {
        fired: true,
        eventText: clampEventText(
          `HTTP ${watch.spec} (status ${status}) body matched /${match}/`
        ),
        observed: "matched",
      };
    }
    return { fired: false, eventText: "", observed: "unmatched" };
  }

  // Default: change-detection on status + body length.
  const signature = `${status}:${body.length}`;
  if (watch.lastObserved === null) {
    return { fired: false, eventText: "", observed: signature };
  }
  if (signature !== watch.lastObserved) {
    return {
      fired: true,
      eventText: clampEventText(
        `HTTP ${watch.spec} changed (${watch.lastObserved} → ${signature})`
      ),
      observed: signature,
    };
  }
  return { fired: false, eventText: "", observed: signature };
}

/** `command` — run the allowlisted command detached from the agent's process
 *  group, with a short timeout, and fire when it emits non-empty stdout; the
 *  stdout becomes the event text. Refuses (does not run) if the flag is off or
 *  the command is not on the allowlist (D8 backstop). Never shell-evaluates the
 *  string with a shell: it is split on whitespace and run argv-style, so there
 *  is no `;`/`&&`/`|` metacharacter surface even if a bad string slips past the
 *  allowlist. */
async function evalCommand(
  watch: WatchEvent,
  policy: WatchCommandPolicy
): Promise<WatchEvalResult> {
  if (!isCommandAllowed(watch.spec, policy)) {
    return {
      fired: false,
      eventText: "",
      observed: watch.lastObserved,
      refused: policy.enabled
        ? `command "${watch.spec}" is not on the allowlist`
        : "command watches are disabled on this deployment",
    };
  }
  const parts = watch.spec.trim().split(/\s+/);
  const cmd = parts[0]!;
  const argv = parts.slice(1);

  const stdout = await new Promise<string>((resolve) => {
    let out = "";
    let settled = false;
    const done = (s: string) => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // `detached: true` puts the child in its OWN process group, so it does not
      // ride the agent's group (which `/seam cancel scope:all` reaps) — the whole point of a
      // bridge-owned watch. `shell: false` (default) means no metacharacter eval.
      child = spawn(cmd, argv, { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      done("");
      return;
    }
    const timer = setTimeout(() => {
      try {
        // Kill the whole group we created (negative pid), not just the leader.
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      done(out);
    }, WATCH_COMMAND_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > WATCH_EVENT_TEXT_MAX * 2) {
        // Enough — stop reading a runaway producer.
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      done(out);
    });
    child.on("close", () => {
      clearTimeout(timer);
      done(out);
    });
  });

  const trimmed = stdout.trim();
  if (trimmed.length > 0) {
    return {
      fired: true,
      eventText: clampEventText(trimmed),
      observed: `fired:${trimmed.length}`,
    };
  }
  return { fired: false, eventText: "", observed: "empty" };
}

/**
 * Evaluate one watch's predicate. Dispatches on `kind`; the command policy gates
 * the privileged source. Pure w.r.t. the store — the caller persists `observed`
 * and acts on `fired` — so it is trivially testable with a hand-built watch.
 */
export async function evaluateWatch(
  watch: WatchEvent,
  policy: WatchCommandPolicy
): Promise<WatchEvalResult> {
  switch (watch.kind) {
    case "file":
      return evalFile(watch);
    case "http":
      return evalHttp(watch);
    case "command":
      return evalCommand(watch, policy);
    default:
      return {
        fired: false,
        eventText: "",
        observed: watch.lastObserved,
        error: `unknown watch kind: ${String(watch.kind)}`,
      };
  }
}
