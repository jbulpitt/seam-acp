#!/usr/bin/env node
/**
 * Stage a host's own `agy` binary into a root-owned managed runtime (#342).
 *
 * #332 made macOS provenance walk every path ancestor up to `/`, because on
 * darwin the binding between verified bytes and executed bytes IS the path —
 * there is no descriptor-bound exec (#330). Current Mac staging lives under
 * `$HOME`, which the service user can rename, so it fails that walk by design.
 * Four of the five agy hosts are agy-ONLY, so enforcing before migrating would
 * leave a family laptop advertising nothing.
 *
 * This exists because that migration is four hosts of the same risky steps, and
 * a half-applied one is worse than not starting: it is the "host with zero
 * agents" outcome the blast-radius rule in AGENTS.md exists to prevent. It is
 * NOT here so the migration can run unattended.
 *
 * The ordering is the safety property, not the rollback:
 *
 *   stage and verify FIRST, write the pins LAST.
 *
 * Everything before the pin write is invisible to the running bridge — it is
 * new files under a new path nothing points at — so any failure up to that
 * moment is inherently a no-op, with the existing `$HOME` staging intact and
 * agy still serving. Rollback only has to handle the narrow window after the
 * pins move, and it restores the exact bytes that were there before.
 *
 * There is deliberately no bypass or force flag. Raised and rejected in #332:
 * a host advertising provenance-verified agy while enforcement is off is not an
 * unverified state, it is a FALSE CLAIM, which ranks below simply refusing.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Directories in the reference layout are 0755; only the binary is 0555. */
export const MANAGED_DIR_MODE = 0o755;
export const MANAGED_FILE_MODE = 0o555;
export const DEFAULT_RUNTIME_PARENT = "/opt/seam/agy-runtime";

/** The five pins #342 moves together. Order is stable for deterministic diffs. */
export const AGY_PINS = [
  "AGY_RUNTIME_ROOT",
  "AGY_SHA256",
  "AGY_CLI_PATH",
  "AGY_VERSION",
  "AGY_DEFAULT_MODEL",
];

export class StagingRefusal extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "StagingRefusal";
    if (detail) this.detail = detail;
  }
}

/**
 * Does the RUNTIME check accept this component, and is that acceptance durable?
 *
 * These are two different questions and #342's prose conflates them. The check
 * in `agy-native-runtime.ts` is `fs.accessSync(target, W_OK)` — "can the
 * service user write this right now". A directory owned by the service user at
 * mode 0555 passes it, because the owner's write bit is clear. But the owner
 * can `chmod` it back, so it is not a guarantee; that is exactly the
 * `macbook-air` state #342 describes. Only root ownership answers the second
 * question, so that is what this script requires and what it reports on.
 */
export function inspectComponent(target, opts = {}) {
  const stat = opts.statSync ? opts.statSync(target) : fs.statSync(target);
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  let writableNow = true;
  try {
    (opts.accessSync ?? fs.accessSync)(target, fs.constants.W_OK);
  } catch {
    writableNow = false;
  }
  return {
    path: target,
    uid: stat.uid,
    mode: stat.mode & 0o7777,
    rootOwned: stat.uid === 0,
    // What the running bridge will conclude.
    passesRuntimeCheck: !writableNow || uid === 0,
    // Whether that conclusion survives the owner changing their mind.
    durable: stat.uid === 0,
  };
}

/** Every component from `leaf` up to `/`, leaf first. */
export function pathChain(leaf) {
  const chain = [];
  let current = path.resolve(leaf);
  for (;;) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

/**
 * Parse a `KEY=value` environment file into an ordered map, preserving every
 * line so a rewrite is a minimal edit rather than a regeneration. A pins file
 * on a laptop holds more than agy's five keys and none of the rest are ours.
 */
export function parseEnvFile(text) {
  const lines = text.split("\n");
  const index = new Map();
  lines.forEach((line, i) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) index.set(match[1], { line: i, value: match[2] });
  });
  return { lines, index };
}

/** Apply `updates` to an env file's text, touching only those keys. */
export function renderEnvFile(text, updates) {
  const { lines, index } = parseEnvFile(text);
  const next = [...lines];
  for (const [key, value] of Object.entries(updates)) {
    const found = index.get(key);
    if (found) next[found.line] = `${key}=${value}`;
    else next.push(`${key}=${value}`);
  }
  if (next.length && next[next.length - 1] !== "") next.push("");
  return next.join("\n");
}

function sha256File(file, readFileSync = fs.readFileSync) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Read the version line the bridge will pin. `agy --version` takes no prompt
 * and bills nothing — unlike the `-p ok` probe #361 removed from the quota
 * path, which is the mistake this deliberately does not repeat.
 */
function readAgyVersion(binary, run) {
  const out = (run ?? ((file, args) =>
    execFileSync(file, args, { encoding: "utf8", timeout: 30_000 })))(binary, ["--version"]);
  const first = String(out).trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!first) throw new StagingRefusal("`agy --version` produced no version line");
  return first;
}

/**
 * Everything that must hold BEFORE anything is written. A refusal here has
 * touched nothing, which is the cheapest possible failure.
 */
export function planAgyStaging(options) {
  const io = options.io ?? {};
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const existsSync = io.existsSync ?? fs.existsSync;
  const statSync = io.statSync ?? fs.statSync;
  const runtimeParent = options.runtimeParent ?? DEFAULT_RUNTIME_PARENT;

  const source = path.resolve(options.source);
  if (!existsSync(source)) throw new StagingRefusal(`source agy binary does not exist: ${source}`);
  const sourceStat = statSync(source);
  if (!sourceStat.isFile()) throw new StagingRefusal(`source agy binary is not a regular file: ${source}`);

  // The digest is computed from the file we are about to stage, never accepted
  // as input. Digests are per-architecture (`d583be13…` arm64, `9d22bde2…`
  // x86_64) and a shared one would stage the wrong host's bytes under a name
  // that claims otherwise.
  const sha256 = sha256File(source, readFileSync);
  const version = options.version ?? readAgyVersion(source, io.run);

  // `agyManagedExecutablePath` is `<AGY_RUNTIME_ROOT>/<sha256>/agy`, so the
  // PIN is the parent and the digest directory lives beneath it. The server
  // layout confirms it: AGY_RUNTIME_ROOT=/opt/seam/agy-runtime with the
  // binary at /opt/seam/agy-runtime/<sha>/agy.
  const runtimeRoot = runtimeParent;
  const releaseDir = path.join(runtimeRoot, sha256);
  const executable = path.join(releaseDir, "agy");

  const envFile = path.resolve(options.envFile);
  if (!existsSync(envFile)) throw new StagingRefusal(`pins file does not exist: ${envFile}`);
  const envText = readFileSync(envFile, "utf8");
  const { index } = parseEnvFile(String(envText));
  const current = Object.fromEntries(AGY_PINS.map((key) => [key, index.get(key)?.value ?? null]));

  // AGY_DEFAULT_MODEL is a preference, not a fact about the binary, so it is
  // carried forward rather than invented. Refusing when there is nothing to
  // carry is better than guessing a model the host may not serve.
  const defaultModel = options.defaultModel ?? current.AGY_DEFAULT_MODEL;
  if (!defaultModel) {
    throw new StagingRefusal(
      "no AGY_DEFAULT_MODEL to carry forward; pass --default-model explicitly rather than guessing"
    );
  }

  // Ancestors that already exist must already be safe. Ones that do not yet
  // exist will be created root-owned, so they are reported as `creates`.
  const chain = pathChain(runtimeParent);
  const ancestors = [];
  const creates = [];
  for (const component of chain) {
    if (!existsSync(component)) {
      creates.push(component);
      continue;
    }
    ancestors.push(inspectComponent(component, { statSync, accessSync: io.accessSync, uid: options.uid }));
  }
  // `creates` is leaf-first from the chain walk; make it parent-first so the
  // plan reads in the order it will be executed.
  creates.reverse();

  const unsafe = ancestors.filter((entry) => !entry.rootOwned);
  return {
    source,
    sha256,
    version,
    runtimeParent,
    runtimeRoot,
    releaseDir,
    executable,
    envFile,
    current,
    updates: {
      AGY_RUNTIME_ROOT: runtimeRoot,
      AGY_SHA256: sha256,
      AGY_CLI_PATH: executable,
      AGY_VERSION: version,
      AGY_DEFAULT_MODEL: defaultModel,
    },
    ancestors,
    creates,
    unsafe,
    /** Already staged at exactly this path with this digest: nothing to do. */
    alreadyStaged:
      existsSync(executable) && sha256File(executable, readFileSync) === sha256,
  };
}

/**
 * Refuse the whole run unless every existing ancestor is root-owned.
 *
 * Deliberately STRICTER than the runtime check, which only asks whether the
 * service user can write the component today. A service-user-owned `0555`
 * directory passes that and is still one `chmod` from being replaceable, and
 * staging into it would produce a host that reports provenance-verified agy on
 * a tree its own user can swap. Naming every offending component matters
 * because the remedy is per-directory `chown`, and an operator should not have
 * to bisect their own filesystem.
 */
export function assertAncestryIsRootOwned(plan) {
  if (!plan.unsafe.length) return;
  const named = plan.unsafe
    .map((entry) => `${entry.path} (uid ${entry.uid}, mode 0${entry.mode.toString(8)})`)
    .join("\n  ");
  throw new StagingRefusal(
    `refusing to stage under a path the service user can take back. ` +
      `Every component through / must be root-owned; these are not:\n  ${named}\n` +
      `Fix with: sudo chown root <path> && sudo chmod 0${MANAGED_DIR_MODE.toString(8)} <path>`,
    { unsafe: plan.unsafe }
  );
}

function describe(plan) {
  const lines = [
    `source        ${plan.source}`,
    `sha256        ${plan.sha256}   (computed from the file being staged)`,
    `version       ${plan.version}`,
    `runtime root  ${plan.runtimeRoot}   (the AGY_RUNTIME_ROOT pin)`,
    `release dir   ${plan.releaseDir}`,
    `executable    ${plan.executable}`,
    `pins file     ${plan.envFile}`,
    "",
    "pins:",
  ];
  for (const key of AGY_PINS) {
    const before = plan.current[key] ?? "(unset)";
    const after = plan.updates[key];
    lines.push(`  ${key}`);
    lines.push(`      from ${before}`);
    lines.push(`      to   ${after}`);
  }
  lines.push("");
  lines.push("ancestry (every component must be root-owned):");
  for (const entry of plan.ancestors) {
    const mark = entry.rootOwned ? "ok    " : "UNSAFE";
    lines.push(`  ${mark} ${entry.path}  uid ${entry.uid} mode 0${entry.mode.toString(8)}`);
  }
  for (const component of plan.creates) {
    lines.push(`  create ${component}  (root:root 0${MANAGED_DIR_MODE.toString(8)})`);
  }
  return lines.join("\n");
}

/**
 * Perform the migration. Only reached with `--apply`.
 *
 * `verify` is the REAL provenance check from the adapter package; it is
 * injectable only so tests can drive it with `process.platform` forced to
 * darwin, which is the platform this migration exists for and the only one
 * where the ancestor walk runs.
 */
export async function applyAgyStaging(plan, options = {}) {
  const io = options.io ?? {};
  const mkdirSync = io.mkdirSync ?? fs.mkdirSync;
  const copyFileSync = io.copyFileSync ?? fs.copyFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  const chmodSync = io.chmodSync ?? fs.chmodSync;
  const chownSync = io.chownSync ?? fs.chownSync;
  const rmSync = io.rmSync ?? fs.rmSync;
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const existsSync = io.existsSync ?? fs.existsSync;

  const verify = options.verify ?? (async (args) => {
    const adapters = await import("@seam/adapters");
    return adapters.verifyAgyManagedRuntimeArtifact(args.executable, args.runtimeRoot, args.sha256);
  });

  // Captured BEFORE anything moves. This is the rollback material, and it is
  // the literal bytes rather than a re-render of parsed keys, so restoring
  // cannot itself introduce a change.
  const envBefore = String(readFileSync(plan.envFile, "utf8"));
  const created = [];
  let pinsWritten = false;

  const rollback = () => {
    // Pins first: while they point at an unverified tree the host is in the
    // only genuinely bad state this script can create.
    if (pinsWritten) {
      writeFileSync(plan.envFile, envBefore);
      pinsWritten = false;
    }
    // Then remove only what this run created, deepest first. Anything that
    // already existed is somebody else's, including a previous good staging.
    for (const target of [...created].reverse()) {
      // The managed modes are read-only by design, and a 0555 directory will
      // not give up its entries even to its owner. Relax what we created just
      // far enough to remove it; leaving a half-staged tree behind would make
      // the next run refuse a path this run built.
      try { chmodSync(target, 0o700); } catch { /* already gone */ }
      try { rmSync(target, { recursive: true, force: true }); } catch { /* leave it */ }
    }
    created.length = 0;
  };

  try {
    for (const component of plan.creates) {
      mkdirSync(component, { mode: MANAGED_DIR_MODE });
      created.push(component);
      chownSync(component, 0, 0);
      chmodSync(component, MANAGED_DIR_MODE);
    }
    if (!existsSync(plan.releaseDir)) {
      mkdirSync(plan.releaseDir, { recursive: true, mode: MANAGED_DIR_MODE });
      created.push(plan.releaseDir);
    }
    chownSync(plan.releaseDir, 0, 0);
    chmodSync(plan.releaseDir, MANAGED_DIR_MODE);

    // Copy to a sibling then rename, so `agy` never exists partially written at
    // the path the pins are about to name.
    const staging = `${plan.executable}.staging`;
    copyFileSync(plan.source, staging);
    chownSync(staging, 0, 0);
    chmodSync(staging, MANAGED_FILE_MODE);
    renameSync(staging, plan.executable);
    created.push(plan.executable);

    // Re-verify AFTER the copy. The digest computed from the source proves what
    // we read; this proves what actually landed, which is a different claim.
    const staged = sha256File(plan.executable, readFileSync);
    if (staged !== plan.sha256) {
      throw new StagingRefusal(
        `staged binary digest does not match the source (${staged} != ${plan.sha256})`
      );
    }

    // The real provenance check, against the real tree, before the pins move.
    await verify({
      executable: plan.executable,
      runtimeRoot: plan.runtimeRoot,
      sha256: plan.sha256,
    });

    // Only now is the tree known good, so only now do the pins point at it.
    writeFileSync(plan.envFile, renderEnvFile(envBefore, plan.updates));
    pinsWritten = true;

    if (options.restart) {
      const observed = await options.restart();
      const missing = [];
      if (!observed?.provenanceMode || observed.provenanceMode !== "immutable-path") {
        missing.push(`provenance mode: immutable-path (saw ${observed?.provenanceMode ?? "nothing"})`);
      }
      if (observed?.agyVersion !== 4) missing.push(`agy version 4 (saw ${observed?.agyVersion ?? "nothing"})`);
      if (observed?.executable !== "managed-artifact") {
        missing.push(`executable "managed-artifact" (saw ${observed?.executable ?? "nothing"})`);
      }
      if (missing.length) {
        throw new StagingRefusal(
          `bridge did not confirm the migration after restart:\n  ${missing.join("\n  ")}`
        );
      }
    }
    return { ok: true, created: [...created] };
  } catch (error) {
    rollback();
    if (options.restartAfterRollback) {
      // The host was serving agy from its old staging before we started; put it
      // back there rather than leaving it stopped. A rollback that ends with no
      // agents is the outcome this whole script exists to avoid.
      try { await options.restartAfterRollback(); } catch { /* reported below */ }
    }
    throw error;
  }
}

function parseArgs(argv) {
  const opts = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--dry-run") opts.apply = false;
    else if (arg === "--source") opts.source = argv[++i];
    else if (arg === "--env-file") opts.envFile = argv[++i];
    else if (arg === "--runtime-parent") opts.runtimeParent = argv[++i];
    else if (arg === "--default-model") opts.defaultModel = argv[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new StagingRefusal(`unknown argument ${arg}`);
  }
  return opts;
}

const USAGE = `stage-agy-runtime — migrate an agy binary into a root-owned managed runtime (#342)

  node scripts/stage-agy-runtime.mjs --source <agy> --env-file <pins> [--apply]

  --source          the host's OWN agy binary; its digest is computed here
  --env-file        the file holding the five AGY_* pins
  --runtime-parent  default ${DEFAULT_RUNTIME_PARENT}
  --default-model   only needed when there is no AGY_DEFAULT_MODEL to carry
  --apply           actually perform the migration (default is a dry run)

Dry run is the default. There is no bypass flag: staging that cannot be
verified is refused rather than forced, because a host advertising
provenance-verified agy without enforcement is a false claim (#332).
`;

export async function main(argv, out = console) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.source || !opts.envFile) {
    out.log(USAGE);
    return opts.help ? 0 : 2;
  }
  const plan = planAgyStaging(opts);
  out.log(describe(plan));
  out.log("");

  if (plan.alreadyStaged && plan.current.AGY_RUNTIME_ROOT === plan.runtimeRoot) {
    out.log("already staged at this digest with matching pins; nothing to do.");
    return 0;
  }

  try {
    assertAncestryIsRootOwned(plan);
  } catch (error) {
    out.error(`REFUSED: ${error.message}`);
    return 1;
  }

  if (!opts.apply) {
    out.log("dry run — nothing written. Re-run with --apply to perform this migration.");
    return 0;
  }
  if ((process.getuid?.() ?? -1) !== 0) {
    out.error("REFUSED: --apply needs root to create a root-owned runtime; re-run under sudo.");
    return 1;
  }
  try {
    await applyAgyStaging(plan);
    out.log(`staged ${plan.executable} and updated ${AGY_PINS.length} pins.`);
    out.log("restart the bridge and confirm: provenance mode: immutable-path, agy version 4, executable managed-artifact.");
    return 0;
  } catch (error) {
    out.error(`REFUSED (rolled back, host unchanged): ${error.message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`REFUSED: ${error?.message ?? error}`);
      process.exitCode = 1;
    });
}
