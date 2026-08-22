import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  applyRelocatePlan,
  assertRelocatePaths,
  claudeProjectSlug,
  collectPresetsFileHits,
  collectRelocatePlan,
  grokSessionsDir,
  remapAbsPath,
  rewritePathOccurrences,
} from "../packages/core/src/core/relocate-repo.js";

describe("remapAbsPath", () => {
  const from = "/home/ubuntu/Projects/old-name";
  const to = "/home/ubuntu/Projects/new-name";

  it("rewrites an exact match", () => {
    expect(remapAbsPath(from, from, to)).toBe(to);
  });

  it("rewrites a nested path", () => {
    expect(remapAbsPath(`${from}/src/app`, from, to)).toBe(`${to}/src/app`);
  });

  it("does not match a sibling that shares a prefix", () => {
    expect(remapAbsPath("/home/ubuntu/Projects/old-name-2", from, to)).toBeNull();
  });

  it("does not match an unrelated path", () => {
    expect(remapAbsPath("/home/ubuntu/Projects/other", from, to)).toBeNull();
  });
});

describe("rewritePathOccurrences", () => {
  const from = "/home/ubuntu/Projects/old-name";
  const to = "/home/ubuntu/Projects/new-name";

  it("rewrites cwd JSON and nested files, not sibling prefixes", () => {
    const src = `{"cwd":"${from}","other":"${from}-2","file":"${from}/src/a.ts"}`;
    expect(rewritePathOccurrences(src, from, to)).toBe(
      `{"cwd":"${to}","other":"${from}-2","file":"${to}/src/a.ts"}`
    );
  });

  it("rewrites file:// URIs used by AGY summaries", () => {
    const src = `["file://${from}","file:///tmp/seam-attachments"]`;
    expect(rewritePathOccurrences(src, from, to)).toBe(
      `["file://${to}","file:///tmp/seam-attachments"]`
    );
  });
});

describe("assertRelocatePaths", () => {
  it("refuses nesting the destination inside the source", () => {
    expect(() =>
      assertRelocatePaths("/tmp/proj", "/tmp/proj/nested")
    ).toThrow(/inside --from/);
  });

  it("refuses a no-op", () => {
    expect(() => assertRelocatePaths("/tmp/proj", "/tmp/proj")).toThrow(/same path/);
  });
});

describe("collectPresetsFileHits", () => {
  it("rewrites channel and thread cwd wrappers only", () => {
    const from = "/repos/a";
    const to = "/repos/b";
    const hits = collectPresetsFileHits(
      {
        channels: {
          "111": { cwd: { value: from }, agent: { value: "grok" } },
          "222": { cwd: { value: "/repos/other" } },
        },
        threads: {
          "333": { cwd: { value: `${from}/sub` }, rider: { value: "keep me" } },
        },
      },
      from,
      to
    );
    expect(hits).toEqual([
      { surface: "channel-preset", id: "111", from, to },
      { surface: "thread-preset", id: "333", from: `${from}/sub`, to: `${to}/sub` },
    ]);
  });
});

describe("collect + apply against sqlite, presets, dispatch, fs", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rewrites every seam surface and can move + leave a symlink", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seam-reloc-"));
    const from = path.join(tmp, "old-proj");
    const to = path.join(tmp, "new-proj");
    fs.mkdirSync(from);
    fs.writeFileSync(path.join(from, "README.md"), "hi");

    const dbPath = path.join(tmp, "seam.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, repo_path TEXT, channel_ref TEXT, updated_utc TEXT);
      CREATE TABLE presets (id TEXT PRIMARY KEY, name TEXT, repo_path TEXT, updated_utc TEXT);
      CREATE TABLE scheduled_prompts (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, updated_utc TEXT);
      CREATE TABLE ingest_endpoints (id TEXT PRIMARY KEY, name TEXT, cwd TEXT);
    `);
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run("s1", from, "chan-1", "t0");
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run("s2", "/elsewhere", "chan-2", "t0");
    db.prepare("INSERT INTO presets VALUES (?,?,?,?)").run("p1", "worker", `${from}/app`, "t0");
    db.prepare("INSERT INTO scheduled_prompts VALUES (?,?,?,?)").run("sch1", "nightly", from, "t0");
    db.prepare("INSERT INTO ingest_endpoints VALUES (?,?,?)").run("ie1", "quiz", from);
    db.close();

    const presetsPath = path.join(tmp, "channel-presets.json");
    fs.writeFileSync(
      presetsPath,
      JSON.stringify({
        channels: { "999": { cwd: { value: from }, locked: true } },
        threads: { "888": { rider: { value: "no cwd here" } } },
      })
    );

    const dispatchDir = path.join(tmp, "dispatch");
    fs.mkdirSync(path.join(dispatchDir, "pending"), { recursive: true });
    fs.writeFileSync(
      path.join(dispatchDir, "pending", "job.json"),
      JSON.stringify({ target: "1", prompt: "x", session: "live", cwd: from })
    );

    const plan = collectRelocatePlan({
      from,
      to,
      dbPath,
      presetsPath,
      dispatchDir,
      move: true,
      symlink: true,
    });
    const surfaces = plan.hits.map((h) => h.surface).sort();
    expect(surfaces).toEqual(
      ["channel-preset", "dispatch", "fs-move", "fs-symlink", "ingest-endpoint", "preset", "scheduled", "session"].sort()
    );

    const result = applyRelocatePlan(plan, {
      dbPath,
      presetsPath,
      dispatchDir,
      move: true,
      symlink: true,
    });
    expect(result.applied.length).toBeGreaterThanOrEqual(6);
    expect(fs.existsSync(to)).toBe(true);
    expect(fs.readFileSync(path.join(to, "README.md"), "utf8")).toBe("hi");
    expect(fs.lstatSync(from).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(from)).toBe(fs.realpathSync(to));

    const after = new Database(dbPath, { readonly: true });
    expect(after.prepare("SELECT repo_path FROM sessions WHERE id = 's1'").get()).toEqual({
      repo_path: to,
    });
    expect(after.prepare("SELECT repo_path FROM sessions WHERE id = 's2'").get()).toEqual({
      repo_path: "/elsewhere",
    });
    expect(after.prepare("SELECT repo_path FROM presets WHERE id = 'p1'").get()).toEqual({
      repo_path: `${to}/app`,
    });
    expect(after.prepare("SELECT cwd FROM scheduled_prompts WHERE id = 'sch1'").get()).toEqual({
      cwd: to,
    });
    expect(after.prepare("SELECT cwd FROM ingest_endpoints WHERE id = 'ie1'").get()).toEqual({
      cwd: to,
    });
    after.close();

    const presets = JSON.parse(fs.readFileSync(presetsPath, "utf8")) as {
      channels: Record<string, { cwd: { value: string }; locked: boolean }>;
      threads: Record<string, { rider: { value: string } }>;
    };
    expect(presets.channels["999"]?.cwd.value).toBe(to);
    expect(presets.channels["999"]?.locked).toBe(true);
    expect(presets.threads["888"]?.rider.value).toBe("no cwd here");

    const spec = JSON.parse(
      fs.readFileSync(path.join(dispatchDir, "pending", "job.json"), "utf8")
    ) as { cwd: string };
    expect(spec.cwd).toBe(to);
    expect(result.backups.length).toBeGreaterThanOrEqual(2);
  });
});

describe("vendor encodings", () => {
  it("slug Claude the same way the adapter does (slash → dash)", () => {
    expect(claudeProjectSlug("/home/ubuntu/Projects/foo")).toBe("-home-ubuntu-Projects-foo");
  });

  it("encodes Grok session dirs the same way the adapter does", () => {
    const dir = grokSessionsDir("/tmp/.grok", "/home/ubuntu/Projects/foo");
    expect(dir).toBe(`/tmp/.grok/sessions/${encodeURIComponent("/home/ubuntu/Projects/foo")}`);
  });
});

describe("vendor dir remap", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("renames Claude and Grok session dirs and can leave old-name symlinks", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seam-vendor-"));
    const from = "/home/ubuntu/Projects/old-name";
    const to = "/home/ubuntu/Projects/new-name";
    const claudeDir = path.join(tmp, ".claude");
    const grokHome = path.join(tmp, ".grok");
    const claudeFrom = path.join(claudeDir, "projects", claudeProjectSlug(from));
    const grokFrom = grokSessionsDir(grokHome, from);
    fs.mkdirSync(claudeFrom, { recursive: true });
    fs.writeFileSync(path.join(claudeFrom, "session.jsonl"), "{}");
    fs.mkdirSync(grokFrom, { recursive: true });
    fs.writeFileSync(path.join(grokFrom, "prompt_history.jsonl"), "");

    const plan = collectRelocatePlan({
      from,
      to,
      vendor: true,
      claudeDir,
      grokHome,
      agyHome: path.join(tmp, ".agy-empty"),
      resolveBin: () => null,
    });
    expect(plan.hits.map((h) => h.surface).sort()).toEqual(["vendor-claude", "vendor-grok"]);

    const result = applyRelocatePlan(plan, { vendor: true, symlink: true, resolveBin: () => null });
    expect(result.applied.map((h) => h.surface).sort()).toEqual(["vendor-claude", "vendor-grok"]);
    const claudeTo = path.join(claudeDir, "projects", claudeProjectSlug(to));
    const grokTo = grokSessionsDir(grokHome, to);
    expect(fs.existsSync(path.join(claudeTo, "session.jsonl"))).toBe(true);
    expect(fs.lstatSync(claudeFrom).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(grokTo, "prompt_history.jsonl"))).toBe(true);
    expect(fs.lstatSync(grokFrom).isSymbolicLink()).toBe(true);
  });

  it("rewrites Claude jsonl cwd, Grok working_directory, and AGY mapping/summaries", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seam-vendor-refs-"));
    const from = path.join(tmp, "old-proj");
    const to = path.join(tmp, "new-proj");
    const claudeDir = path.join(tmp, ".claude");
    const grokHome = path.join(tmp, ".grok");
    const agyHome = path.join(tmp, ".agy");
    const claudeFrom = path.join(claudeDir, "projects", claudeProjectSlug(from));
    fs.mkdirSync(claudeFrom, { recursive: true });
    fs.writeFileSync(
      path.join(claudeFrom, "sess.jsonl"),
      JSON.stringify({ type: "user", cwd: from, sessionId: "abc" }) + "\n"
    );
    fs.writeFileSync(
      path.join(claudeDir, "history.jsonl"),
      JSON.stringify({ project: from, display: "hi" }) + "\n"
    );
    fs.writeFileSync(
      path.join(tmp, ".claude.json"),
      JSON.stringify({ projects: { [from]: { allowedTools: [] } } })
    );

    const grokFrom = grokSessionsDir(grokHome, from);
    fs.mkdirSync(grokFrom, { recursive: true });
    fs.writeFileSync(
      path.join(grokFrom, "summary.json"),
      JSON.stringify({ git_root_dir: from + "/" })
    );
    fs.writeFileSync(
      path.join(grokFrom, "prompt_context.json"),
      JSON.stringify({ working_directory: from })
    );

    const mapping = path.join(tmp, "agy-sessions.json");
    fs.writeFileSync(
      mapping,
      JSON.stringify({ "sid-1": { cascadeId: "c1", maxStepIndex: 1, cwd: from } })
    );
    fs.mkdirSync(agyHome, { recursive: true });
    fs.writeFileSync(
      path.join(agyHome, "settings.json"),
      JSON.stringify({ trustedWorkspaces: [from, "/tmp"] })
    );
    fs.writeFileSync(
      path.join(agyHome, "history.jsonl"),
      JSON.stringify({ display: "x", workspace: from }) + "\n"
    );
    const summaries = path.join(agyHome, "conversation_summaries.db");
    const sdb = new Database(summaries);
    sdb.exec(
      "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT)"
    );
    sdb.prepare("INSERT INTO conversation_summaries VALUES (?, ?)").run(
      "cid-1",
      JSON.stringify([`file://${from}`, "file:///tmp/seam-attachments"])
    );
    sdb.close();

    const plan = collectRelocatePlan({
      from,
      to,
      vendor: true,
      claudeDir,
      grokHome,
      agyHome,
      agySessionsPath: mapping,
      resolveBin: () => null,
    });
    const surfaces = plan.hits.map((h) => h.surface).sort();
    expect(surfaces).toEqual(
      [
        "vendor-agy",
        "vendor-claude",
        "vendor-claude-refs",
        "vendor-grok",
        "vendor-grok-refs",
      ].sort()
    );

    applyRelocatePlan(plan, { vendor: true, resolveBin: () => null });

    const claudeTo = path.join(claudeDir, "projects", claudeProjectSlug(to));
    const jsonl = fs.readFileSync(path.join(claudeTo, "sess.jsonl"), "utf8");
    expect(jsonl).toContain(`"cwd":"${to}"`);
    expect(fs.readFileSync(path.join(claudeDir, "history.jsonl"), "utf8")).toContain(
      `"project":"${to}"`
    );
    expect(fs.readFileSync(path.join(tmp, ".claude.json"), "utf8")).toContain(to);

    const grokTo = grokSessionsDir(grokHome, to);
    expect(JSON.parse(fs.readFileSync(path.join(grokTo, "summary.json"), "utf8")).git_root_dir).toBe(
      `${to}/`
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(grokTo, "prompt_context.json"), "utf8")).working_directory
    ).toBe(to);

    expect(JSON.parse(fs.readFileSync(mapping, "utf8"))["sid-1"].cwd).toBe(to);
    expect(JSON.parse(fs.readFileSync(path.join(agyHome, "settings.json"), "utf8")).trustedWorkspaces).toEqual(
      [to, "/tmp"]
    );
    const adb = new Database(summaries, { readonly: true });
    const uris = adb.prepare("SELECT workspace_uris FROM conversation_summaries").get() as {
      workspace_uris: string;
    };
    adb.close();
    expect(uris.workspace_uris).toContain(`file://${to}`);
    expect(uris.workspace_uris).toContain("file:///tmp/seam-attachments");
  });

  it("invokes a PATH Claude CLI before the native fallback", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seam-vendor-cli-"));
    const from = path.join(tmp, "old-proj");
    const to = path.join(tmp, "new-proj");
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(path.join(claudeDir, "projects", claudeProjectSlug(from)), { recursive: true });
    const ran: string[][] = [];
    const plan = collectRelocatePlan({
      from,
      to,
      vendor: true,
      claudeDir,
      grokHome: path.join(tmp, ".grok-empty"),
      agyHome: path.join(tmp, ".agy-empty"),
      resolveBin: (name) => (name === "clamp" ? "/usr/bin/clamp" : null),
      move: true,
    });
    expect(plan.hits.some((h) => h.surface === "vendor-cli" && h.id === "clamp")).toBe(true);
    applyRelocatePlan(plan, {
      vendor: true,
      runCli: (argv) => {
        ran.push(argv);
        return { ok: true, output: "ok" };
      },
    });
    expect(ran[0]?.slice(0, 2)).toEqual(["/usr/bin/clamp", "--fix"]);
  });
});
