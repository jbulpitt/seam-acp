import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_OUTPUT_LIMIT = 8 * 1024 * 1024;
const UNSETTLED_STATES = ["active", "pending", "suspended"];

function commandFailure(command, args, result) {
  const detail = (result.stderr || result.stdout || "").trim();
  const suffix = detail ? `: ${detail}` : "";
  return new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.error?.code ?? "unknown"})${suffix}`);
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? COMMAND_OUTPUT_LIMIT,
    env: options.env ?? process.env,
  });
  if (result.error || result.status !== 0) throw commandFailure(command, args, result);
  return result.stdout;
}

export function parseWorktreeList(raw) {
  const records = [];
  let current = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: line.slice("worktree ".length), branch: null, head: null, bare: false, detached: false, locked: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    }
  }
  if (current) records.push(current);
  return records;
}

function safeJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function pathContains(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/**
 * Read the durable execution cwd for every unsettled dispatch. Claimed and
 * suspended attempts use their frozen execution identity; only not-yet-claimed
 * work falls back to the spec/preset/session. Pending and suspended work are
 * included because deleting their cwd turns a queued/resumable turn into a
 * later failure even though it is not executing at this instant (#511).
 */
export function readDispatchBindings(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return { paths: [], attemptIds: [], unknownAttemptIds: [], unavailable: `dispatch database does not exist: ${dbPath}` };
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    if (!tableExists(db, "turn_attempts")) {
      return { paths: [], attemptIds: [], unknownAttemptIds: [], unavailable: "turn_attempts table is unavailable" };
    }

    const sessions = tableExists(db, "sessions")
      ? new Map(db.prepare("SELECT channel_ref, repo_path FROM sessions WHERE repo_path IS NOT NULL AND repo_path != ''").all()
        .map((row) => [row.channel_ref, row.repo_path]))
      : new Map();
    const presets = tableExists(db, "presets")
      ? new Map(db.prepare("SELECT name, repo_path FROM presets WHERE repo_path IS NOT NULL AND repo_path != ''").all()
        .map((row) => [row.name, row.repo_path]))
      : new Map();
    const placeholders = UNSETTLED_STATES.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, state, identity, spec_json FROM turn_attempts WHERE state IN (${placeholders})`)
      .all(...UNSETTLED_STATES);
    const bindings = [];
    const unknownAttemptIds = [];

    for (const row of rows) {
      let identity = null;
      let spec = null;
      try {
        identity = row.identity ? JSON.parse(row.identity) : null;
        spec = row.spec_json ? JSON.parse(row.spec_json) : null;
      } catch {
        unknownAttemptIds.push(row.id);
        continue;
      }

      const cwd = identity?.cwd
        ?? spec?.cwd
        ?? (spec?.preset ? presets.get(spec.preset) : undefined)
        ?? (spec?.target ? sessions.get(spec.target) : undefined);
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
        unknownAttemptIds.push(row.id);
        continue;
      }
      bindings.push({ id: row.id, state: row.state, cwd: path.resolve(cwd) });
    }

    return {
      paths: bindings.map((binding) => binding.cwd),
      attemptIds: bindings.map((binding) => binding.id),
      bindings,
      unknownAttemptIds,
      unavailable: null,
    };
  } catch (error) {
    return {
      paths: [],
      attemptIds: [],
      unknownAttemptIds: [],
      unavailable: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

/** A claimed turn normally has durable cwd evidence, but a direct process-CWD
 * scan closes the gap between ledger observation and teardown. This is a
 * second authority, not a replacement for the dispatch ledger: a process that
 * has already exited still needs its queued/resumable row protected. */
export function readProcessBindings(procRoot = "/proc") {
  if (!fs.existsSync(procRoot)) {
    return { bindings: [], unavailable: `${procRoot} is unavailable` };
  }
  const bindings = [];
  try {
    for (const entry of fs.readdirSync(procRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try {
        let cwd = fs.readlinkSync(path.join(procRoot, entry.name, "cwd"));
        cwd = cwd.replace(/ \(deleted\)$/, "");
        if (path.isAbsolute(cwd)) bindings.push({ pid: Number(entry.name), cwd: path.resolve(cwd) });
      } catch (error) {
        // Processes race the scan by exiting, and another uid may be opaque.
        // The durable dispatch ledger remains the authority for those cases.
        if (!["ENOENT", "EACCES", "EPERM"].includes(error?.code)) throw error;
      }
    }
    return { bindings, unavailable: null };
  } catch (error) {
    return { bindings: [], unavailable: error instanceof Error ? error.message : String(error) };
  }
}

function terminalPullRequest(prs, branch, head) {
  // #511: ancestry called three freshly-cut, actively-dispatched worktrees
  // "merged" because they still pointed at the prior main head. A terminal PR
  // at this exact local OID is the deletion authority. The OID check also
  // refuses a branch that acquired unreviewed commits after its PR closed.
  const exact = prs.filter((pr) => pr.headRefName === branch);
  if (exact.length === 0) return { eligible: false, reason: "no_pull_request" };
  if (exact.some((pr) => pr.state === "OPEN")) return { eligible: false, reason: "pull_request_open", prs: exact };
  const matching = exact.filter((pr) => (pr.state === "MERGED" || pr.state === "CLOSED") && pr.headRefOid === head);
  if (matching.length === 0) return { eligible: false, reason: "pull_request_head_mismatch", prs: exact };
  return { eligible: true, reason: "terminal_pull_request", prs: matching };
}

function repositorySlug(repo, run) {
  const raw = run("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: repo });
  const parsed = safeJson(raw, "gh repo view output");
  if (typeof parsed.nameWithOwner !== "string" || !parsed.nameWithOwner.includes("/")) {
    throw new Error("gh repo view did not return nameWithOwner");
  }
  return parsed.nameWithOwner;
}

function pullRequestsForBranch(repo, slug, branch, run) {
  const raw = run("gh", [
    "pr", "list", "--repo", slug, "--head", branch, "--state", "all", "--limit", "100",
    "--json", "number,state,url,headRefName,headRefOid,mergedAt,closedAt",
  ], { cwd: repo });
  const parsed = safeJson(raw, `pull requests for ${branch}`);
  if (!Array.isArray(parsed)) throw new Error(`pull requests for ${branch} are not an array`);
  return parsed;
}

function statusFor(tree, run) {
  return run("git", ["-C", tree, "status", "--porcelain=v1", "--untracked-files=all"]);
}

export function planWorktreePrune({
  repo,
  dataDir,
  run = runCommand,
  dispatchReader = readDispatchBindings,
  processReader = readProcessBindings,
}) {
  const root = run("git", ["-C", repo, "rev-parse", "--show-toplevel"]).trim();
  const commonDir = run("git", ["-C", root, "rev-parse", "--git-common-dir"]).trim();
  const gitDir = run("git", ["-C", root, "rev-parse", "--git-dir"]).trim();
  const resolveGitPath = (value) => path.resolve(root, value);
  if (resolveGitPath(commonDir) !== resolveGitPath(gitDir)) {
    throw new Error(`--repo must name the main checkout, not a linked worktree: ${root}`);
  }

  const slug = repositorySlug(root, run);
  const dispatch = dispatchReader(path.join(dataDir, "seam.db"));
  const processes = processReader();
  const worktrees = parseWorktreeList(run("git", ["-C", root, "worktree", "list", "--porcelain"]));
  const decisions = [];

  for (const tree of worktrees) {
    if (path.resolve(tree.path) === path.resolve(root)) {
      decisions.push({ ...tree, eligible: false, reason: "main_checkout" });
      continue;
    }
    if (tree.bare || tree.detached || !tree.branch || !tree.head) {
      decisions.push({ ...tree, eligible: false, reason: "not_a_branch_worktree" });
      continue;
    }
    if (tree.locked) {
      decisions.push({ ...tree, eligible: false, reason: "worktree_locked" });
      continue;
    }
    if (dispatch.unavailable) {
      decisions.push({ ...tree, eligible: false, reason: "dispatch_state_unavailable", detail: dispatch.unavailable });
      continue;
    }
    if (dispatch.unknownAttemptIds.length > 0) {
      // An unsettled row with no trustworthy cwd could belong to any candidate.
      // Refuse cleanup only; worktrees and dispatch processing keep working.
      decisions.push({ ...tree, eligible: false, reason: "unmapped_unsettled_dispatch", dispatchIds: dispatch.unknownAttemptIds });
      continue;
    }
    if (processes.unavailable) {
      decisions.push({ ...tree, eligible: false, reason: "process_state_unavailable", detail: processes.unavailable });
      continue;
    }
    const bound = (dispatch.bindings ?? []).filter((binding) => pathContains(tree.path, binding.cwd));
    if (bound.length > 0) {
      decisions.push({ ...tree, eligible: false, reason: "unsettled_dispatch", dispatches: bound });
      continue;
    }
    const running = processes.bindings.filter((binding) => pathContains(tree.path, binding.cwd));
    if (running.length > 0) {
      decisions.push({ ...tree, eligible: false, reason: "process_in_worktree", processes: running });
      continue;
    }

    let status;
    try {
      status = statusFor(tree.path, run);
    } catch (error) {
      decisions.push({ ...tree, eligible: false, reason: "status_unavailable", detail: error.message });
      continue;
    }
    if (status.length > 0) {
      // A terminal PR does not prove that later local edits are expendable.
      decisions.push({ ...tree, eligible: false, reason: "dirty_worktree" });
      continue;
    }

    let pullRequest;
    try {
      pullRequest = terminalPullRequest(pullRequestsForBranch(root, slug, tree.branch, run), tree.branch, tree.head);
    } catch (error) {
      decisions.push({ ...tree, eligible: false, reason: "pull_request_state_unavailable", detail: error.message });
      continue;
    }
    decisions.push({ ...tree, ...pullRequest });
  }

  return { repo: root, repository: slug, dataDir, dispatch, processes, decisions };
}

function recheckCandidate(candidate, plan, run, dispatchReader, processReader) {
  const dispatch = dispatchReader(path.join(plan.dataDir, "seam.db"));
  if (dispatch.unavailable || dispatch.unknownAttemptIds.length > 0) {
    return { ok: false, reason: dispatch.unavailable ? "dispatch_state_unavailable" : "unmapped_unsettled_dispatch" };
  }
  if ((dispatch.bindings ?? []).some((binding) => pathContains(candidate.path, binding.cwd))) {
    return { ok: false, reason: "unsettled_dispatch" };
  }
  const processes = processReader();
  if (processes.unavailable) return { ok: false, reason: "process_state_unavailable" };
  if (processes.bindings.some((binding) => pathContains(candidate.path, binding.cwd))) {
    return { ok: false, reason: "process_in_worktree" };
  }
  if (statusFor(candidate.path, run).length > 0) return { ok: false, reason: "dirty_worktree" };
  const pr = terminalPullRequest(
    pullRequestsForBranch(plan.repo, plan.repository, candidate.branch, run),
    candidate.branch,
    candidate.head,
  );
  return pr.eligible ? { ok: true } : { ok: false, reason: pr.reason };
}

export function executeWorktreePrune({
  plan,
  apply = false,
  run = runCommand,
  dispatchReader = readDispatchBindings,
  processReader = readProcessBindings,
  wtBin = "wt",
}) {
  const eligible = plan.decisions.filter((decision) => decision.eligible);
  const removed = [];
  const refused = [];

  if (apply) {
    for (const candidate of eligible) {
      // Re-read every changing authority immediately before teardown. This
      // refuses only the candidate whose PR, dirtiness, or dispatch ownership
      // changed; other independently-proven candidates remain reclaimable.
      const current = recheckCandidate(candidate, plan, run, dispatchReader, processReader);
      if (!current.ok) {
        refused.push({ path: candidate.path, reason: current.reason });
        continue;
      }
      run(wtBin, ["teardown", "--repo", plan.repo, candidate.path], { cwd: plan.repo });
      removed.push(candidate.path);
    }
    run("git", ["-C", plan.repo, "worktree", "prune", "--verbose"]);
  } else {
    run("git", ["-C", plan.repo, "worktree", "prune", "--dry-run", "--verbose"]);
  }

  return { apply, eligible: eligible.map((candidate) => candidate.path), removed, refused };
}
