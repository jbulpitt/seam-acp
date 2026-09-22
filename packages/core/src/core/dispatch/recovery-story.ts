/**
 * Resume situation (#451). Templates over facts the caller already holds.
 *
 * The attempt records the session directory, the agent, the model, and a
 * stall reason when one was stored. It does not record a worktree the turn
 * created or a pull request. Those are not invented here. A local caller may
 * pass the default-branch tip it just read; a missing tip is no opinion.
 *
 * The model text starts with the word "continue" and appends the situation.
 * The note repeats the same sentences, so the two cannot disagree. Variable
 * text stays out of the harness preamble: prompt caching keys on the prefix.
 */
import { isLocalLocation } from "../location.js";
import { CONTINUE_PROMPT, RESUME_ANNOUNCE } from "./turn-resume.js";

const LEAD = "The turn stopped and this session is being resumed in place.";
const CHECK_WORK =
  "If this session created a worktree, check whether a pull request for that work is already merged before repeating it, and rebase onto the default branch only after checking. The attempt does not record that worktree or pull request.";
const TRANSCRIPT =
  "What is safe to assume is the transcript: tool calls and their results from before the stop are already in this session.";

export type RecoveryCause = "process_restart" | "classified_retry" | "reauthentication";

/** Attempt `stalled_reason` prefixes (#454). One spelling, shared with the negotiator. */
export const REAUTH_WAITING_PREFIX = "reauth-waiting:";
export const REAUTH_COMPLETED_PREFIX = "reauth-completed:";

export interface DefaultBranchHead {
  /** `origin/main` shape. The caller observed it; this module does not. */
  name: string;
  sha: string;
}

export interface RecoveryStoryFacts {
  cause: RecoveryCause;
  /** `stalled_reason` already stored on the attempt. */
  recordedReason?: string;
  /** Seconds since `updatedUtc`, when that stamp is still the stop. */
  gapSeconds?: number;
  agentId?: string;
  model?: string;
  /** Provider title parsed from `providerIdentity`, when it had one. */
  provider?: string;
  /** Session directory on the attempt. Not a worktree the turn created. */
  cwd?: string;
  location?: string;
  promptStarted?: boolean;
  errorKind?: string;
  /** Ladder rung this continuation is actually executing. */
  rung?: number;
  /** Set only when this attempt is changing model. */
  substitutedModel?: string;
  alreadyProducedOutput?: boolean;
  retry?: number;
  retryBudget?: number;
  backoffSeconds?: number;
  defaultBranch?: DefaultBranchHead;
}

export interface RecoveryAttemptSource {
  updatedUtc?: string;
  stalledReason?: string | null;
  /** Original stall. A later accept refreshes `updatedUtc` and must not erase the gap. */
  stalledUtc?: string | null;
  promptStarted?: boolean;
  providerIdentity?: string | null;
  identity?: string | null;
  spec?: { cwd?: string };
  location?: string;
}

export interface RecoveryRender {
  /** Whole model prompt: the word continue, then the situation. */
  prompt: string;
  /** Human-facing note. Same situation sentences as `prompt`. */
  note: string;
}

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^origin\/[A-Za-z0-9._/-]+$/;
const TOKEN = /^[a-z][a-z0-9_]*$/;
const RUNG = new Set([1, 2, 3, 4, 5]);

function clamp(value: string, max: number): string | undefined {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.includes("\0")) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function ident(value: string | undefined, max = 120): string | undefined {
  if (!value) return undefined;
  return clamp(value, max);
}

/** Facts a boot resume can read off the attempt. No git and no network. */
export function recoveryFactsFromAttempt(
  source: RecoveryAttemptSource,
  now: Date = new Date(),
): RecoveryStoryFacts {
  let agentId: string | undefined;
  let model: string | undefined;
  let location: string | undefined;
  let cwd: string | undefined;
  if (source.identity) {
    try {
      const parsed = JSON.parse(source.identity) as {
        agent?: unknown;
        model?: unknown;
        location?: unknown;
        cwd?: unknown;
      };
      if (typeof parsed.agent === "string") agentId = ident(parsed.agent);
      if (typeof parsed.model === "string") model = ident(parsed.model);
      if (typeof parsed.location === "string") location = ident(parsed.location);
      if (typeof parsed.cwd === "string") cwd = ident(parsed.cwd, 500);
    } catch {
      // An unreadable identity is no opinion, not a guessed one.
    }
  }
  if (!cwd && source.spec?.cwd) cwd = ident(source.spec.cwd, 500);
  if (!location && source.location) location = ident(source.location);
  const recorded = source.stalledReason ? clamp(source.stalledReason, 500) : undefined;
  const cause: RecoveryCause = recorded?.startsWith(REAUTH_COMPLETED_PREFIX)
    ? "reauthentication"
    : "process_restart";
  const gapSeconds = gapSince(
    cause === "reauthentication" && source.stalledUtc ? source.stalledUtc : source.updatedUtc,
    now,
  );
  const provider = providerLabel(source.providerIdentity);
  return {
    cause,
    ...(cause === "process_restart" && recorded ? { recordedReason: recorded } : {}),
    ...(gapSeconds !== undefined ? { gapSeconds } : {}),
    ...(agentId ? { agentId } : {}),
    ...(model ? { model } : {}),
    ...(location ? { location } : {}),
    ...(cwd ? { cwd } : {}),
    ...(provider ? { provider } : {}),
    promptStarted: source.promptStarted === true,
  };
}

function providerLabel(raw: string | null | undefined): string | undefined {
  if (!raw || raw === "null") return undefined;
  try {
    const parsed = JSON.parse(raw) as { title?: unknown; name?: unknown };
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.title === "string") return ident(parsed.title);
      if (typeof parsed.name === "string") return ident(parsed.name);
      return undefined;
    }
  } catch {
    // A plain label is usable. Anything else is not a provider name.
  }
  return ident(raw);
}

function gapSince(updatedUtc: string | undefined, now: Date): number | undefined {
  if (!updatedUtc) return undefined;
  const then = Date.parse(updatedUtc);
  if (!Number.isFinite(then)) return undefined;
  const seconds = Math.floor((now.getTime() - then) / 1000);
  // A stamp rewritten at claim time is ~0 and is not the stop. Omit it.
  if (!Number.isFinite(seconds) || seconds < 1) return undefined;
  return seconds;
}

function formatGap(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 48) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function situation(facts: RecoveryStoryFacts): string[] {
  const lines: string[] = [];
  if (facts.cause === "reauthentication") {
    lines.push("Authentication was completed outside this turn.");
  } else if (facts.cause === "classified_retry") {
    const kind = facts.errorKind && TOKEN.test(facts.errorKind) ? facts.errorKind : "unclassified";
    const agent = ident(facts.agentId);
    lines.push(agent ? `${agent} reported ${kind}.` : `The error kind is ${kind}.`);
  } else {
    const reason = facts.recordedReason ? clamp(facts.recordedReason, 500) : undefined;
    if (reason) lines.push(`The recorded reason is: ${reason.replace(/\.+$/, "")}.`);
    else lines.push("The process restarted while the turn was in flight.");
  }

  if (
    (facts.cause === "process_restart" || facts.cause === "reauthentication") &&
    facts.gapSeconds !== undefined && facts.gapSeconds >= 1
  ) {
    lines.push(`The attempt was last recorded ${formatGap(facts.gapSeconds)} ago.`);
  }

  if (facts.rung !== undefined && RUNG.has(facts.rung)) {
    const retry = integer(facts.retry);
    const budget = integer(facts.retryBudget);
    const backoff = facts.backoffSeconds;
    const wait = backoff !== undefined && Number.isFinite(backoff) && backoff >= 0
      ? ` after ${Math.round(backoff)}s`
      : "";
    const count = retry !== undefined && budget !== undefined ? `, retry ${retry} of ${budget}${wait}` : "";
    lines.push(`The recovery ladder is executing rung ${facts.rung}${count}.`);
  }

  const substituted = ident(facts.substitutedModel);
  if (substituted) lines.push(`The model for this attempt is ${substituted}.`);
  else {
    const model = ident(facts.model);
    if (model) lines.push(`The recorded model is ${model}.`);
  }

  const agent = ident(facts.agentId);
  if (facts.cause === "process_restart" && agent) lines.push(`The recorded agent is ${agent}.`);

  const provider = ident(facts.provider);
  if (provider) lines.push(`The provider is ${provider}.`);

  const cwd = ident(facts.cwd, 500);
  if (cwd) lines.push(`The session directory is ${cwd}.`);

  const location = ident(facts.location);
  if (location && !isLocalLocation(location)) {
    lines.push(`The session runs on ${location}. This resume does not include that host's git state.`);
  }

  const branch = facts.defaultBranch;
  if (
    facts.cause === "process_restart" &&
    branch &&
    BRANCH.test(branch.name) &&
    SHA.test(branch.sha) &&
    isLocalLocation(location)
  ) {
    lines.push(`The default branch ${branch.name} is currently ${branch.sha}.`);
  }

  if (facts.cause === "reauthentication") {
    lines.push("The prompt had already been submitted. Do not repeat it. The transcript in this session is the work done before the stop.");
    lines.push(TRANSCRIPT);
  } else if (facts.alreadyProducedOutput) {
    lines.push("The turn already produced output, so this is continuing the existing conversation.");
  } else if (facts.cause === "classified_retry") {
    lines.push("The request had not produced output yet, so this retries it as-is.");
  } else if (facts.promptStarted) {
    lines.push("The prompt had already been submitted. The transcript in this session is the work done before the stop.");
    lines.push(TRANSCRIPT);
  }

  if (facts.cause === "process_restart") lines.push(CHECK_WORK);
  return lines;
}

function integer(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

/** Model prompt and human note from one fact set. */
export function recoveryStory(facts: RecoveryStoryFacts): RecoveryRender {
  const body = situation(facts).join("\n");
  const prompt = `${CONTINUE_PROMPT}\n\n${LEAD}\n\n${body}`;
  const header = facts.cause === "process_restart" ? RESUME_ANNOUNCE : "Recovery:";
  return { prompt, note: `${header}\n\n${LEAD}\n\n${body}` };
}
