/**
 * Remap a project folder's path through every seam config surface that
 * stores cwd/repoPath, with optional filesystem move, leftover symlink,
 * and agent-session remaps for Claude, AGY, and Grok.
 *
 * `--vendor` prefers a PATH CLI when one is present (`cc-port`, `claude-mv`,
 * `clamp`) and always runs the native fallback for JSONL/cwd/workspace refs
 * those tools miss — plus AGY and Grok, which have no packaged migrator.
 *
 * Default is dry-run. `--apply` writes. Live ACP runtimes keep the old cwd
 * until they are dropped (`/seam cancel` those threads, or `npm run redeploy`).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { isWithinRoot, normalizeFullPath } from "./path-utils.js";

export type RelocateSurface =
  | "session"
  | "preset"
  | "scheduled"
  | "channel-preset"
  | "thread-preset"
  | "dispatch"
  | "vendor-cli"
  | "vendor-claude"
  | "vendor-claude-refs"
  | "vendor-grok"
  | "vendor-grok-refs"
  | "vendor-agy"
  | "fs-move"
  | "fs-symlink";

export interface RelocateHit {
  surface: RelocateSurface;
  /** Row id, Discord snowflake, filename, or vendor dir name. */
  id: string;
  from: string;
  to: string;
  label?: string;
  meta?: Record<string, string>;
}

export interface RelocatePlan {
  from: string;
  to: string;
  hits: RelocateHit[];
  warnings: string[];
}

export interface RelocateCollectOpts {
  from: string;
  to: string;
  dbPath?: string;
  presetsPath?: string;
  dispatchDir?: string;
  /** When true, include Claude / AGY / Grok session remaps + PATH CLIs. */
  vendor?: boolean;
  claudeDir?: string;
  grokHome?: string;
  agyHome?: string;
  agySessionsPath?: string;
  /** Include a filesystem move / leftover symlink in the plan. */
  move?: boolean;
  symlink?: boolean;
  resolveBin?: (name: string) => string | null;
}

export interface RelocateApplyOpts {
  move?: boolean;
  symlink?: boolean;
  vendor?: boolean;
  backupDir?: string;
  resolveBin?: (name: string) => string | null;
  runCli?: (argv: string[]) => { ok: boolean; output: string };
}

export interface RelocateApplyResult {
  applied: RelocateHit[];
  skipped: Array<{ hit: RelocateHit; reason: string }>;
  backups: string[];
  warnings: string[];
}

export function claudeProjectSlug(cwd: string): string {
  return normalizeFullPath(cwd).replace(/\//g, "-");
}

export function grokSessionsDir(grokHome: string, cwd: string): string {
  const normalized = normalizeFullPath(cwd).replace(/\/+$/, "");
  return path.join(grokHome, "sessions", encodeURIComponent(normalized));
}

/**
 * Rewrite `value` if it is `from` or a descendant. Sibling prefix
 * (`/proj/foo` vs `/proj/foo-2`) does not match. Returns null if unchanged.
 */
export function remapAbsPath(value: string, from: string, to: string): string | null {
  if (!value || typeof value !== "string") return null;
  const v = normalizeFullPath(value);
  const src = normalizeFullPath(from);
  const dest = normalizeFullPath(to);
  if (v === src) return dest;
  if (!isWithinRoot(v, src)) return null;
  const rel = v.slice(src.length);
  return dest + rel;
}

/**
 * Sibling-safe rewrite of `from` inside a blob. `/proj/old` matches
 * `/proj/old` and `/proj/old/src`, not `/proj/old-2`.
 */
export function rewritePathOccurrences(text: string, from: string, to: string): string {
  const src = normalizeFullPath(from);
  const dest = normalizeFullPath(to);
  if (!text.includes(src)) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf(src, i);
    if (j === -1) {
      out += text.slice(i);
      break;
    }
    const after = text[j + src.length];
    const boundary =
      after === undefined || after === "/" || after === '"' || after === "'" || /\s/.test(after);
    out += text.slice(i, j);
    out += boundary ? dest : src;
    i = j + src.length;
  }
  return out;
}

function defaultResolveBin(name: string): string | null {
  try {
    const out = spawnSync("which", [name], { encoding: "utf8" });
    if (out.status !== 0) return null;
    const p = (out.stdout ?? "").trim();
    return p || null;
  } catch {
    return null;
  }
}

const CLAUDE_CLIS = ["cc-port", "claude-mv", "clamp"] as const;

function claudeCliArgv(name: string, bin: string, from: string, to: string): string[] {
  if (name === "cc-port") {
    return [bin, "move", from, to, "--apply", "--refs-only", "--deep", "--tool", "claude"];
  }
  if (name === "claude-mv") return [bin, "--no-move", from, to];
  return [bin, "--fix", "--from", from, "--to", to, "--force"];
}

function defaultRunCli(argv: string[]): { ok: boolean; output: string } {
  const [bin, ...args] = argv;
  if (!bin) return { ok: false, output: "empty argv" };
  const out = spawnSync(bin, args, { encoding: "utf8", timeout: 120_000 });
  const output = `${out.stdout ?? ""}${out.stderr ?? ""}`.trim();
  return { ok: out.status === 0, output };
}

function walkTextFiles(root: string, exts: Set<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (exts.has(ext) || exts.has(e.name)) out.push(abs);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

function rewriteFilePaths(file: string, from: string, to: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const next = rewritePathOccurrences(raw, from, to);
  if (next === raw) return false;
  fs.writeFileSync(file, next, "utf8");
  return true;
}

export function assertRelocatePaths(from: string, to: string): { from: string; to: string } {
  const src = normalizeFullPath(from);
  const dest = normalizeFullPath(to);
  if (!src || !dest) throw new Error("both --from and --to are required");
  if (src === dest) throw new Error("--from and --to resolve to the same path");
  if (isWithinRoot(dest, src) && dest !== src) {
    throw new Error(`--to (${dest}) is inside --from (${src}); that would nest the folder into itself`);
  }
  return { from: src, to: dest };
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

function collectSqlHits(
  dbPath: string,
  from: string,
  to: string,
  warnings: string[]
): RelocateHit[] {
  const hits: RelocateHit[] = [];
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    warnings.push(`SQLite not opened (${dbPath}): ${(err as Error).message}`);
    return hits;
  }
  try {
    if (tableExists(db, "sessions")) {
      const rows = db
        .prepare("SELECT id, repo_path, channel_ref FROM sessions WHERE repo_path IS NOT NULL AND repo_path != ''")
        .all() as Array<{ id: string; repo_path: string; channel_ref: string | null }>;
      for (const row of rows) {
        const next = remapAbsPath(row.repo_path, from, to);
        if (next) {
          hits.push({
            surface: "session",
            id: row.id,
            from: row.repo_path,
            to: next,
            label: row.channel_ref ?? undefined,
          });
        }
      }
    }
    if (tableExists(db, "presets")) {
      const rows = db
        .prepare("SELECT id, name, repo_path FROM presets WHERE repo_path IS NOT NULL AND repo_path != ''")
        .all() as Array<{ id: string; name: string; repo_path: string }>;
      for (const row of rows) {
        const next = remapAbsPath(row.repo_path, from, to);
        if (next) {
          hits.push({
            surface: "preset",
            id: row.id,
            from: row.repo_path,
            to: next,
            label: row.name,
          });
        }
      }
    }
    if (tableExists(db, "scheduled_prompts")) {
      const rows = db
        .prepare("SELECT id, name, cwd FROM scheduled_prompts WHERE cwd IS NOT NULL AND cwd != ''")
        .all() as Array<{ id: string; name: string; cwd: string }>;
      for (const row of rows) {
        const next = remapAbsPath(row.cwd, from, to);
        if (next) {
          hits.push({
            surface: "scheduled",
            id: row.id,
            from: row.cwd,
            to: next,
            label: row.name,
          });
        }
      }
    }
  } finally {
    db.close();
  }
  return hits;
}

function wrappedCwd(node: unknown): string | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const value = (node as { value?: unknown }).value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function collectPresetsFileHits(
  doc: unknown,
  from: string,
  to: string
): RelocateHit[] {
  const hits: RelocateHit[] = [];
  if (!doc || typeof doc !== "object") return hits;
  const rec = doc as { channels?: Record<string, unknown>; threads?: Record<string, unknown> };
  for (const [id, entry] of Object.entries(rec.channels ?? {})) {
    const cwd = wrappedCwd(
      entry && typeof entry === "object" ? (entry as { cwd?: unknown }).cwd : undefined
    );
    if (!cwd) continue;
    const next = remapAbsPath(cwd, from, to);
    if (next) hits.push({ surface: "channel-preset", id, from: cwd, to: next });
  }
  for (const [id, entry] of Object.entries(rec.threads ?? {})) {
    const cwd = wrappedCwd(
      entry && typeof entry === "object" ? (entry as { cwd?: unknown }).cwd : undefined
    );
    if (!cwd) continue;
    const next = remapAbsPath(cwd, from, to);
    if (next) hits.push({ surface: "thread-preset", id, from: cwd, to: next });
  }
  return hits;
}

function applyPresetsFileHits(doc: unknown, hits: RelocateHit[]): unknown {
  if (!doc || typeof doc !== "object") return doc;
  const next = structuredClone(doc) as {
    channels?: Record<string, { cwd?: { value?: string } }>;
    threads?: Record<string, { cwd?: { value?: string } }>;
  };
  for (const hit of hits) {
    const bucket = hit.surface === "channel-preset" ? next.channels : next.threads;
    const entry = bucket?.[hit.id];
    if (entry?.cwd && typeof entry.cwd === "object") entry.cwd.value = hit.to;
  }
  return next;
}

function collectDispatchHits(dispatchDir: string, from: string, to: string): RelocateHit[] {
  const hits: RelocateHit[] = [];
  for (const bucket of ["pending", "running"] as const) {
    const dir = path.join(dispatchDir, bucket);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const abs = path.join(dir, name);
      let raw: string;
      try {
        raw = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        continue;
      }
      const cwd =
        json && typeof json === "object" && typeof (json as { cwd?: unknown }).cwd === "string"
          ? (json as { cwd: string }).cwd
          : null;
      if (!cwd) continue;
      const next = remapAbsPath(cwd, from, to);
      if (next) {
        hits.push({
          surface: "dispatch",
          id: path.join(bucket, name),
          from: cwd,
          to: next,
        });
      }
    }
  }
  return hits;
}

function resolveClaudeProjectDir(claudeDir: string, cwd: string): string | null {
  const projectsRoot = path.join(claudeDir, "projects");
  const computed = path.join(projectsRoot, claudeProjectSlug(cwd));
  if (fs.existsSync(computed)) return computed;
  let entries: string[];
  try {
    entries = fs.readdirSync(projectsRoot);
  } catch {
    return null;
  }
  const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-+/g, "-");
  const target = norm(claudeProjectSlug(cwd));
  const match = entries.find((e) => norm(e) === target);
  return match ? path.join(projectsRoot, match) : null;
}

function fileContainsPath(file: string, from: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").includes(normalizeFullPath(from));
  } catch {
    return false;
  }
}

function collectClaudeHits(
  claudeDir: string,
  from: string,
  to: string,
  resolveBin: (name: string) => string | null,
  move: boolean
): RelocateHit[] {
  const hits: RelocateHit[] = [];
  const claudeFrom = resolveClaudeProjectDir(claudeDir, from);
  const dest = path.join(path.join(claudeDir, "projects"), claudeProjectSlug(to));
  if (claudeFrom) {
    hits.push({
      surface: "vendor-claude",
      id: path.basename(claudeFrom),
      from: claudeFrom,
      to: dest,
    });
  }

  const historyFile = path.join(claudeDir, "history.jsonl");
  const claudeJson = path.join(claudeDir, "claude.json");
  const homeClaudeJson = path.join(path.dirname(claudeDir), ".claude.json");
  const configFile = fs.existsSync(claudeJson)
    ? claudeJson
    : fs.existsSync(homeClaudeJson)
      ? homeClaudeJson
      : undefined;
  const scanRoot = claudeFrom ?? dest;
  const jsonl = scanRoot && fs.existsSync(scanRoot)
    ? walkTextFiles(scanRoot, new Set([".jsonl"])).filter((f) => fileContainsPath(f, from))
    : [];
  const historyHit = fs.existsSync(historyFile) && fileContainsPath(historyFile, from);
  const configHit = configFile ? fileContainsPath(configFile, from) : false;
  if (historyHit || jsonl.length > 0 || configHit) {
    const parts = [
      historyHit ? "history.jsonl" : null,
      jsonl.length > 0 ? `${jsonl.length} jsonl cwd` : null,
      configHit ? path.basename(configFile!) : null,
    ].filter(Boolean);
    hits.push({
      surface: "vendor-claude-refs",
      id: claudeDir,
      from,
      to,
      label: parts.join(" + "),
      meta: {
        claudeDir,
        ...(configFile ? { configFile } : {}),
        historyFile,
      },
    });
  }

  for (const name of CLAUDE_CLIS) {
    const bin = resolveBin(name);
    if (!bin) continue;
    if (name === "clamp" && !move && !fs.existsSync(to)) {
      continue;
    }
    hits.push({
      surface: "vendor-cli",
      id: name,
      from,
      to,
      label: claudeCliArgv(name, bin, from, to).join(" "),
      meta: { bin, cli: name },
    });
    break;
  }
  return hits;
}

function collectGrokHits(grokHome: string, from: string, to: string): RelocateHit[] {
  const hits: RelocateHit[] = [];
  const grokFrom = grokSessionsDir(grokHome, from);
  if (!fs.existsSync(grokFrom)) return hits;
  hits.push({
    surface: "vendor-grok",
    id: path.basename(grokFrom),
    from: grokFrom,
    to: grokSessionsDir(grokHome, to),
  });
  const files = walkTextFiles(grokFrom, new Set([".json", ".jsonl", ".txt"])).filter((f) =>
    fileContainsPath(f, from)
  );
  if (files.length > 0) {
    hits.push({
      surface: "vendor-grok-refs",
      id: grokHome,
      from,
      to,
      label: `${files.length} session file${files.length === 1 ? "" : "s"}`,
      meta: { grokHome },
    });
  }
  return hits;
}

function collectAgyHits(
  agyHome: string,
  agySessionsPath: string | undefined,
  from: string,
  to: string
): RelocateHit[] {
  const parts: string[] = [];
  const mappingFiles = [
    agySessionsPath,
    path.join(agyHome, "seam_sessions.json"),
  ].filter((p): p is string => typeof p === "string" && fs.existsSync(p));
  for (const file of mappingFiles) {
    if (fileContainsPath(file, from)) parts.push(path.basename(file));
  }
  const settings = path.join(agyHome, "settings.json");
  if (fs.existsSync(settings) && fileContainsPath(settings, from)) parts.push("settings.json");
  const history = path.join(agyHome, "history.jsonl");
  if (fs.existsSync(history) && fileContainsPath(history, from)) parts.push("history.jsonl");
  const summaries = path.join(agyHome, "conversation_summaries.db");
  let summaryCount = 0;
  if (fs.existsSync(summaries)) {
    try {
      const db = new Database(summaries, { readonly: true, fileMustExist: true });
      try {
        const row = db
          .prepare("SELECT COUNT(*) AS n FROM conversation_summaries WHERE workspace_uris LIKE ?")
          .get(`%${normalizeFullPath(from)}%`) as { n: number };
        summaryCount = row?.n ?? 0;
      } finally {
        db.close();
      }
    } catch {
      /* ignore */
    }
    if (summaryCount > 0) parts.push(`${summaryCount} conversation summaries`);
  }
  if (parts.length === 0) return [];
  return [
    {
      surface: "vendor-agy",
      id: agyHome,
      from,
      to,
      label: parts.join(" + "),
      meta: {
        agyHome,
        ...(agySessionsPath ? { agySessionsPath } : {}),
      },
    },
  ];
}

function collectVendorHits(opts: RelocateCollectOpts, from: string, to: string): RelocateHit[] {
  const home = process.env.HOME ?? "";
  const claudeDir = opts.claudeDir ?? path.join(home, ".claude");
  const grokHome = opts.grokHome ?? path.join(home, ".grok");
  const agyHome = opts.agyHome ?? path.join(home, ".gemini", "antigravity-cli");
  const resolveBin = opts.resolveBin ?? defaultResolveBin;
  return [
    ...collectClaudeHits(claudeDir, from, to, resolveBin, Boolean(opts.move)),
    ...collectGrokHits(grokHome, from, to),
    ...collectAgyHits(agyHome, opts.agySessionsPath, from, to),
  ];
}

export function collectRelocatePlan(opts: RelocateCollectOpts): RelocatePlan {
  const { from, to } = assertRelocatePaths(opts.from, opts.to);
  const warnings: string[] = [];
  const hits: RelocateHit[] = [];

  if (opts.dbPath) hits.push(...collectSqlHits(opts.dbPath, from, to, warnings));

  if (opts.presetsPath) {
    try {
      const raw = fs.readFileSync(opts.presetsPath, "utf8");
      const doc = JSON.parse(raw) as unknown;
      hits.push(...collectPresetsFileHits(doc, from, to));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`channel-presets.json: ${(err as Error).message}`);
      }
    }
  }

  if (opts.dispatchDir) hits.push(...collectDispatchHits(opts.dispatchDir, from, to));

  if (opts.vendor) hits.push(...collectVendorHits(opts, from, to));

  if (opts.move) {
    hits.push({ surface: "fs-move", id: from, from, to });
    if (!fs.existsSync(from)) {
      warnings.push(`--move: ${from} does not exist on this host`);
    } else if (fs.existsSync(to)) {
      warnings.push(`--move: ${to} already exists`);
    }
  }
  if (opts.symlink) {
    hits.push({ surface: "fs-symlink", id: from, from, to });
  }

  if (hits.some((h) => h.surface === "session")) {
    warnings.push(
      "A successful --apply writes a force-restart sentinel so live ACP turns take SIGTERM and turn-resume continues them at the new cwd. Pass --no-restart to skip."
    );
  }

  return { from, to, hits, warnings };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp-relocate`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function renameDir(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true });
  }
}

function applyVendorDirHit(
  hit: RelocateHit,
  symlink: boolean,
  skipped: RelocateApplyResult["skipped"]
): boolean {
  if (fs.existsSync(hit.to) && !fs.existsSync(hit.from)) {
    skipped.push({ hit, reason: "destination already exists (CLI may have renamed it)" });
    return false;
  }
  if (!fs.existsSync(hit.from)) {
    skipped.push({ hit, reason: "source dir missing" });
    return false;
  }
  if (fs.existsSync(hit.to)) {
    skipped.push({ hit, reason: "destination already exists" });
    return false;
  }
  renameDir(hit.from, hit.to);
  if (symlink) {
    try {
      fs.symlinkSync(hit.to, hit.from);
    } catch (err) {
      skipped.push({ hit, reason: `renamed, but leftover symlink failed: ${(err as Error).message}` });
    }
  }
  return true;
}

function applyClaudeRefs(hit: RelocateHit): number {
  const claudeDir = hit.meta?.claudeDir ?? hit.id;
  const from = hit.from;
  const to = hit.to;
  let n = 0;
  const historyFile = hit.meta?.historyFile ?? path.join(claudeDir, "history.jsonl");
  if (fs.existsSync(historyFile) && rewriteFilePaths(historyFile, from, to)) n++;
  const configFile =
    hit.meta?.configFile ??
    (fs.existsSync(path.join(path.dirname(claudeDir), ".claude.json"))
      ? path.join(path.dirname(claudeDir), ".claude.json")
      : path.join(claudeDir, "claude.json"));
  if (fs.existsSync(configFile) && rewriteFilePaths(configFile, from, to)) n++;
  const slugDir = resolveClaudeProjectDir(claudeDir, to) ?? resolveClaudeProjectDir(claudeDir, from);
  if (slugDir) {
    for (const file of walkTextFiles(slugDir, new Set([".jsonl", ".json"]))) {
      if (rewriteFilePaths(file, from, to)) n++;
    }
  }
  return n;
}

function applyGrokRefs(hit: RelocateHit): number {
  const grokHome = hit.meta?.grokHome ?? hit.id;
  const dest = grokSessionsDir(grokHome, hit.to);
  const src = grokSessionsDir(grokHome, hit.from);
  const root = fs.existsSync(dest) ? dest : src;
  let n = 0;
  for (const file of walkTextFiles(root, new Set([".json", ".jsonl", ".txt"]))) {
    if (rewriteFilePaths(file, hit.from, hit.to)) n++;
  }
  return n;
}

function applyAgy(hit: RelocateHit): number {
  const agyHome = hit.meta?.agyHome ?? hit.id;
  let n = 0;
  const mappingFiles = [
    hit.meta?.agySessionsPath,
    path.join(agyHome, "seam_sessions.json"),
  ].filter((p): p is string => typeof p === "string" && fs.existsSync(p));
  for (const file of mappingFiles) {
    if (rewriteFilePaths(file, hit.from, hit.to)) n++;
  }
  const settings = path.join(agyHome, "settings.json");
  if (fs.existsSync(settings) && rewriteFilePaths(settings, hit.from, hit.to)) n++;
  const history = path.join(agyHome, "history.jsonl");
  if (fs.existsSync(history) && rewriteFilePaths(history, hit.from, hit.to)) n++;
  const summaries = path.join(agyHome, "conversation_summaries.db");
  if (fs.existsSync(summaries)) {
    const db = new Database(summaries);
    try {
      const rows = db
        .prepare(
          "SELECT conversation_id, workspace_uris FROM conversation_summaries WHERE workspace_uris LIKE ?"
        )
        .all(`%${normalizeFullPath(hit.from)}%`) as Array<{
        conversation_id: string;
        workspace_uris: string | null;
      }>;
      const upd = db.prepare(
        "UPDATE conversation_summaries SET workspace_uris = ? WHERE conversation_id = ?"
      );
      const tx = db.transaction(() => {
        for (const row of rows) {
          if (!row.workspace_uris) continue;
          const next = rewritePathOccurrences(row.workspace_uris, hit.from, hit.to);
          if (next !== row.workspace_uris) {
            upd.run(next, row.conversation_id);
            n++;
          }
        }
      });
      tx();
    } finally {
      db.close();
    }
  }
  return n;
}

export function applyRelocatePlan(
  plan: RelocatePlan,
  opts: RelocateApplyOpts & {
    dbPath?: string;
    presetsPath?: string;
    dispatchDir?: string;
  }
): RelocateApplyResult {
  const applied: RelocateHit[] = [];
  const skipped: RelocateApplyResult["skipped"] = [];
  const backups: string[] = [];
  const warnings = [...plan.warnings];
  const ts = stamp();

  const moveHit = plan.hits.find((h) => h.surface === "fs-move");
  const symlinkHit = plan.hits.find((h) => h.surface === "fs-symlink");
  const configHits = plan.hits.filter(
    (h) =>
      h.surface === "session" ||
      h.surface === "preset" ||
      h.surface === "scheduled" ||
      h.surface === "channel-preset" ||
      h.surface === "thread-preset" ||
      h.surface === "dispatch"
  );
  const vendorHits = plan.hits.filter((h) => h.surface.startsWith("vendor-"));

  if (opts.move && moveHit) {
    if (!fs.existsSync(moveHit.from)) {
      throw new Error(`--move: source does not exist: ${moveHit.from}`);
    }
    if (fs.lstatSync(moveHit.from).isSymbolicLink()) {
      throw new Error(`--move: source is a symlink (${moveHit.from}); refuse to move the alias`);
    }
    if (fs.existsSync(moveHit.to)) {
      throw new Error(`--move: destination already exists: ${moveHit.to}`);
    }
    renameDir(moveHit.from, moveHit.to);
    applied.push(moveHit);
  }

  if (opts.dbPath && configHits.some((h) => h.surface === "session" || h.surface === "preset" || h.surface === "scheduled")) {
    const bak = `${opts.dbPath}.bak-relocate-${ts}`;
    try {
      fs.copyFileSync(opts.dbPath, bak);
      backups.push(bak);
    } catch (err) {
      warnings.push(`could not copy sqlite backup: ${(err as Error).message}`);
    }
    const db = new Database(opts.dbPath);
    try {
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        for (const hit of configHits) {
          if (hit.surface === "session") {
            db.prepare("UPDATE sessions SET repo_path = ?, updated_utc = ? WHERE id = ?").run(
              hit.to,
              now,
              hit.id
            );
            applied.push(hit);
          } else if (hit.surface === "preset") {
            db.prepare("UPDATE presets SET repo_path = ?, updated_utc = ? WHERE id = ?").run(
              hit.to,
              now,
              hit.id
            );
            applied.push(hit);
          } else if (hit.surface === "scheduled") {
            db.prepare("UPDATE scheduled_prompts SET cwd = ?, updated_utc = ? WHERE id = ?").run(
              hit.to,
              now,
              hit.id
            );
            applied.push(hit);
          }
        }
      });
      tx();
    } finally {
      db.close();
    }
  }

  const presetHits = configHits.filter(
    (h) => h.surface === "channel-preset" || h.surface === "thread-preset"
  );
  if (opts.presetsPath && presetHits.length > 0) {
    const abs = path.resolve(opts.presetsPath);
    const bak = `${abs}.bak-relocate-${ts}`;
    fs.copyFileSync(abs, bak);
    backups.push(bak);
    const doc = JSON.parse(fs.readFileSync(abs, "utf8")) as unknown;
    atomicWriteJson(abs, applyPresetsFileHits(doc, presetHits));
    applied.push(...presetHits);
  }

  if (opts.dispatchDir) {
    for (const hit of configHits.filter((h) => h.surface === "dispatch")) {
      const abs = path.join(opts.dispatchDir, hit.id);
      try {
        const json = JSON.parse(fs.readFileSync(abs, "utf8")) as { cwd?: string };
        json.cwd = hit.to;
        atomicWriteJson(abs, json);
        applied.push(hit);
      } catch (err) {
        skipped.push({ hit, reason: (err as Error).message });
      }
    }
  }

  if (opts.vendor) {
    const runCli = opts.runCli ?? defaultRunCli;
    for (const hit of vendorHits.filter((h) => h.surface === "vendor-cli")) {
      const bin = hit.meta?.bin;
      const cli = hit.meta?.cli;
      if (!bin || !cli) {
        skipped.push({ hit, reason: "missing cli metadata" });
        continue;
      }
      const argv = claudeCliArgv(cli, bin, hit.from, hit.to);
      const result = runCli(argv);
      if (result.ok) applied.push(hit);
      else skipped.push({ hit, reason: result.output || "cli exited non-zero" });
    }
    for (const hit of vendorHits.filter(
      (h) => h.surface === "vendor-claude" || h.surface === "vendor-grok"
    )) {
      if (applyVendorDirHit(hit, Boolean(opts.symlink), skipped)) applied.push(hit);
    }
    for (const hit of vendorHits.filter((h) => h.surface === "vendor-claude-refs")) {
      applyClaudeRefs(hit);
      applied.push(hit);
    }
    for (const hit of vendorHits.filter((h) => h.surface === "vendor-grok-refs")) {
      applyGrokRefs(hit);
      applied.push(hit);
    }
    for (const hit of vendorHits.filter((h) => h.surface === "vendor-agy")) {
      applyAgy(hit);
      applied.push(hit);
    }
  }

  if (opts.symlink && symlinkHit) {
    if (fs.existsSync(symlinkHit.from)) {
      skipped.push({
        hit: symlinkHit,
        reason: `${symlinkHit.from} still exists; leftover symlink not created`,
      });
    } else if (!fs.existsSync(symlinkHit.to)) {
      skipped.push({
        hit: symlinkHit,
        reason: `${symlinkHit.to} does not exist; leftover symlink not created`,
      });
    } else {
      fs.symlinkSync(symlinkHit.to, symlinkHit.from);
      applied.push(symlinkHit);
    }
  }

  return { applied, skipped, backups, warnings };
}
