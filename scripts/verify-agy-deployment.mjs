#!/usr/bin/env node
/**
 * Answer one question about a host that is ALREADY deployed: is it correct?
 *
 * #342 migrated five hosts by hand and every one of them was shaped
 * differently — two staged under `/opt/seam`, two under `$HOME`, and one had
 * its pins only in a live pm2 process environment, present in no file on disk
 * (#390). Each was repaired in isolation because there was no way to ask a host
 * "are you right?" and get a specific answer. `scripts/stage-agy-runtime.mjs`
 * (#365) performs the migration and #266's gate guards an upgrade; neither
 * describes a host that is already running.
 *
 * The two properties that make this safe are both structural rather than
 * promised:
 *
 *   1. It CANNOT write. Its whole filesystem surface is `readOnlyIo()`, five
 *      read functions. There is no write, no chmod, no rename, no spawn on the
 *      default path. A host that fails verification is reported, never
 *      repaired — repair is `stage-agy-runtime.mjs`, which an operator runs
 *      deliberately after reading this output.
 *   2. It never claims more than it checked. `agy 1.2.2` passed every identity
 *      check on macbook-pro while serving zero turns (#371), so identity checks
 *      here report identity and say so. Capability is a separate check that is
 *      SKIPPED unless `--probe` is passed, and a skipped check is reported as
 *      skipped rather than quietly omitted.
 *
 * There is deliberately no version allowlist. #266 settled that: the gate binds
 * evidence to an exact version and digest, and "1.2.2 is bad" is an incident
 * label, not a runtime policy. A verifier that blocklisted versions would be
 * making a policy this repo already decided not to have.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGY_PINS,
  DEFAULT_RUNTIME_PARENT,
  MANAGED_FILE_MODE,
  inspectComponent,
  parseEnvFile,
  pathChain,
  verifyAgyCapability,
} from "./stage-agy-runtime.mjs";

export const AGY_DEPLOYMENT_SCHEMA_VERSION = 1;

/**
 * The pins that must be readable from a FILE. `AGY_ENABLED` joins the five
 * `AGY_PINS` because a host whose enablement lives only in process state is the
 * same reboot-shaped failure as one whose digest does (#390 case 1).
 */
export const AGY_DEPLOYMENT_PINS = Object.freeze([...AGY_PINS, "AGY_ENABLED"]);

/**
 * The entire filesystem surface. Five functions, all read-only, frozen.
 *
 * This is the mechanism, not a convention: the module closes over nothing else,
 * so "verification cannot mutate the host" is a property of what it is able to
 * call rather than a claim about what it happens to call. Tests drive it with
 * an `io` that throws on any other key.
 */
export function readOnlyIo(base = fs) {
  return Object.freeze({
    statSync: (p) => base.statSync(p),
    lstatSync: (p) => base.lstatSync(p),
    readFileSync: (p, enc) => base.readFileSync(p, enc),
    accessSync: (p, mode) => base.accessSync(p, mode),
    realpathSync: (p) => base.realpathSync(p),
  });
}

function check(id, status, detail, reasonCode) {
  return reasonCode ? { id, status, reasonCode, detail } : { id, status, detail };
}

/**
 * Blank out `//` and block comments while preserving every newline, so line
 * positions survive. String-aware, because a `//` inside a path value is not a
 * comment — and `AGY_CLI_PATH` is full of slashes.
 */
export function stripJsComments(src) {
  let out = "";
  let i = 0;
  let inString = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i += 2; continue; }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; out += c; i += 1; continue; }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  "; i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  "; i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Index of the `}` matching the `{` at `open`, or -1. String-aware. */
function matchBrace(src, open) {
  let depth = 0;
  let inString = null;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (inString) {
      if (c === "\\") { i += 1; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** Only a complete single-line string literal counts as a pin value. */
const PM2_PIN_LINE =
  /^\s*(?:(AGY_[A-Za-z0-9_]+)|"(AGY_[A-Za-z0-9_]+)"|'(AGY_[A-Za-z0-9_]+)')\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*,?\s*$/;

/**
 * Read AGY pins out of a pm2 ecosystem file WITHOUT executing it (#395).
 *
 * `require()`ing host config here would hand arbitrary host code the verifier's
 * process, which is precisely the property `readOnlyIo()` exists to guarantee
 * away — a misdiagnosis must not be able to take an agy-only laptop to zero
 * agents, and running the file makes that guarantee unprovable. So this is a
 * text scan, and it is deliberately strict rather than lenient: a lenient match
 * over JS syntax produces a quiet FALSE PASS, which is worse here than a
 * refusal, because the whole tool exists to tell an operator the truth about a
 * host that looks fine.
 *
 * What it will not accept, each for a reason:
 *   - a commented-out pin — comments are blanked first;
 *   - a pin whose value spans lines, or is a concatenation, template or
 *     variable reference — the line must be a whole string literal;
 *   - a pin nested inside some deeper object within `env` — depth is tracked;
 *   - pins spread across more than one app's env block, which is ambiguous
 *     rather than wrong, and is reported as such instead of guessed at.
 */
export function parsePm2EcosystemPins(text) {
  const src = stripJsComments(text);
  const blocks = [];
  for (const match of src.matchAll(/\benv(?:_[A-Za-z0-9_]+)?\s*:\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    const end = matchBrace(src, open);
    if (end < 0) continue;
    const before = src.slice(0, match.index);
    const names = [...before.matchAll(/\bname\s*:\s*(?:"([^"]*)"|'([^']*)')/g)];
    const last = names[names.length - 1];
    const pins = new Map();
    let depth = 0;
    for (const rawLine of src.slice(open + 1, end).split("\n")) {
      if (depth === 0) {
        const pin = PM2_PIN_LINE.exec(rawLine);
        if (pin) {
          const key = pin[1] ?? pin[2] ?? pin[3];
          const value = pin[4] ?? pin[5] ?? "";
          pins.set(key, value.replace(/\\(.)/g, "$1"));
        }
      }
      for (const c of rawLine.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "")) {
        if (c === "{" || c === "[") depth += 1;
        else if (c === "}" || c === "]") depth -= 1;
      }
    }
    if (pins.size) blocks.push({ app: last?.[1] ?? last?.[2] ?? null, pins });
  }
  return {
    blocks,
    ambiguous: blocks.length > 1,
    pins: blocks.length === 1 ? blocks[0].pins : new Map(),
    app: blocks.length === 1 ? blocks[0].app : null,
  };
}

/** Does this text look like a pm2 ecosystem module rather than a KEY=VALUE file? */
export function looksLikePm2Ecosystem(text) {
  return /\bmodule\s*\.\s*exports\s*=/.test(stripJsComments(text ?? ""));
}

/**
 * Where each pin actually resolves from.
 *
 * The distinction is the point, and there are THREE sources rather than two.
 * A pin present in the live process environment and absent from every file is
 * not "configured" — macbook-air reported `provenance mode: immutable-path`
 * from exactly that state, with a `dump.pm2` stale since August, and a reboot
 * would have resurrected it without pins and dropped agy with no trail back to
 * a cause. A pin in the pm2 ecosystem file IS recorded on disk, but pm2 only
 * re-reads that file on `delete` + `start <file>`, so it is its own state with
 * its own consequence and is labelled separately (#395).
 */
/**
 * Read AGY pins out of `~/.pm2/dump.pm2` — what a REBOOT actually restores.
 *
 * Observed on macbook-pro/macbook-air/home-hub on 2026-09-13: the dump is a
 * JSON **array** of app objects, each with `name` and `env`. Some pm2 versions
 * write `{ apps: [...] }`, so both are accepted — but the array form is the one
 * this fleet has, and it is the one the fixtures are built from.
 *
 * Parsed as JSON through the frozen read calls, never by shelling out to `pm2`:
 * the binary is not on a non-interactive PATH on any Mac in this fleet (#390's
 * sixth failure, which bit twice while building this), and spawning a process
 * manager from a read-only verifier would discard the property that makes a
 * misdiagnosis unable to change anything.
 */
export function parsePm2DumpPins(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { apps: [], malformed: true };
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.apps) ? raw.apps : null;
  if (!list) return { apps: [], malformed: true };
  const apps = [];
  for (const app of list) {
    const env = app?.env;
    if (!env || typeof env !== "object") continue;
    const pins = new Map();
    for (const key of AGY_DEPLOYMENT_PINS) {
      if (Object.prototype.hasOwnProperty.call(env, key)) pins.set(key, String(env[key]));
    }
    apps.push({ name: typeof app?.name === "string" ? app.name : null, pins });
  }
  return { apps, malformed: false };
}

/** A source is unavailable (not checked) rather than empty (checked, nothing there). */
const UNAVAILABLE = Symbol("unavailable");

/**
 * Compare the three sources of truth on a pm2 host (#390).
 *
 * There are three, and until now nothing compared them:
 *
 *   file  — `ecosystem.config.cjs`, what an operator edits. `pm2 restart` does
 *           NOT re-read it; only `delete` + `start <file>` applies a change.
 *   dump  — `~/.pm2/dump.pm2`, what a reboot restores. `pm2 save` writes it from
 *           the RUNNING list, so it can lag the file or drop apps entirely.
 *   live  — the running process environment, what is serving turns right now.
 *
 * macbook-air had pins in `live` only: the file lacked them and the dump was
 * stale since Aug 30. It worked, reported `immutable-path`, and no file on the
 * host explained why — one reboot from silently losing agy.
 *
 * A source that could not be READ is `UNAVAILABLE`, which is a third state and
 * never folded into "the pin is absent". Reporting "cannot tell" as "drifted"
 * would make the check cry wolf; reporting it as "consistent" would make it
 * useless. Both are the question-4 failure.
 */
export function compareAgyPinSources({ file, dump, live }) {
  const available = Object.entries({ file, dump, live })
    .filter(([, v]) => v !== UNAVAILABLE && v != null)
    .map(([name, v]) => [name, v instanceof Map ? v : new Map(Object.entries(v))]);
  const unavailable = ["file", "dump", "live"]
    .filter((n) => !available.some(([name]) => name === n));
  if (available.length < 2) {
    return { status: "unknown", differences: [], unavailable, compared: available.map(([n]) => n) };
  }
  const differences = [];
  for (const key of AGY_DEPLOYMENT_PINS) {
    const present = available.filter(([, pins]) => pins.has(key));
    if (!present.length) continue;
    const missing = available.filter(([, pins]) => !pins.has(key)).map(([name]) => name);
    if (missing.length) {
      differences.push({ key, kind: "missing", in: missing, from: present.map(([n]) => n) });
      continue;
    }
    const values = new Set(present.map(([, pins]) => pins.get(key)));
    if (values.size > 1) {
      differences.push({
        key,
        kind: "value",
        sources: Object.fromEntries(present.map(([n, pins]) => [n, pins.get(key)])),
      });
    }
  }
  return {
    status: differences.length ? "drifted" : "consistent",
    differences,
    unavailable,
    compared: available.map(([n]) => n),
  };
}

/** The consequence and the command, per drift shape. Generic advice is useless here. */
function driftConsequence(difference, pinsFile) {
  if (difference.kind === "value") {
    return `${difference.key} differs between ` +
      `${Object.entries(difference.sources).map(([s, v]) => `${s}=${v}`).join(" and ")}`;
  }
  const missingIn = difference.in.join(", ");
  if (difference.in.includes("dump")) {
    return `${difference.key} is absent from ${missingIn} — a reboot restores from ` +
      `~/.pm2/dump.pm2 and would start without it`;
  }
  if (difference.in.includes("file")) {
    return `${difference.key} is absent from ${missingIn} (${pinsFile}) — applying any ` +
      `config change means \`pm2 delete\` + \`pm2 start\`, which would drop it`;
  }
  return `${difference.key} is absent from ${missingIn}`;
}

export function resolvePinSources(pinsFileText, processEnv = {}, format = null) {
  const fromFile = new Map();
  // "absent" rather than "file" when there is nothing to read, so the header
  // does not label a missing file with the format it would have had.
  let fileSource = typeof pinsFileText === "string" ? "file" : "absent";
  let ecosystem = null;
  if (typeof pinsFileText === "string") {
    const isEcosystem = format === "pm2-ecosystem"
      || (format === null && looksLikePm2Ecosystem(pinsFileText));
    if (isEcosystem) {
      fileSource = "pm2-ecosystem";
      ecosystem = parsePm2EcosystemPins(pinsFileText);
      if (!ecosystem.ambiguous) {
        for (const key of AGY_DEPLOYMENT_PINS) {
          if (ecosystem.pins.has(key)) fromFile.set(key, ecosystem.pins.get(key));
        }
      }
    } else {
      const { index } = parseEnvFile(pinsFileText);
      for (const key of AGY_DEPLOYMENT_PINS) {
        const found = index.get(key);
        if (found !== undefined) fromFile.set(key, found.value);
      }
    }
  }
  const sources = {};
  for (const key of AGY_DEPLOYMENT_PINS) {
    if (fromFile.has(key)) sources[key] = { value: fromFile.get(key), source: fileSource };
    else if (Object.prototype.hasOwnProperty.call(processEnv, key)) {
      sources[key] = { value: processEnv[key], source: "process-env" };
    } else sources[key] = { value: null, source: "absent" };
  }
  return { sources, fileSource, ecosystem };
}

/** The canonical executable for a root and digest, per docs/agy-native-runtime.md. */
export function canonicalExecutable(runtimeRoot, sha256, platform = process.platform) {
  return path.join(runtimeRoot, sha256, platform === "win32" ? "agy.exe" : "agy");
}

function digestOf(file, io) {
  return createHash("sha256").update(io.readFileSync(file)).digest("hex");
}

/**
 * Verify an already-deployed host. Returns a report; never throws for a host
 * that is merely wrong, because "wrong" is the output, not an error.
 */
export function verifyAgyDeployment(options, io = readOnlyIo()) {
  const {
    envFile,
    processEnv = {},
    runtimeParent = DEFAULT_RUNTIME_PARENT,
    platform = process.platform,
    probe = null,
    format = null,
    pm2Dump = null,
  } = options;

  let envFileText = null;
  let envFileError = null;
  try {
    envFileText = io.readFileSync(envFile, "utf8");
  } catch (error) {
    envFileError = error?.code ?? "EUNKNOWN";
  }

  const { sources: pins, fileSource, ecosystem } =
    resolvePinSources(envFileText, processEnv, format);
  const value = (key) => pins[key]?.value ?? null;
  const checks = [];

  const absent = AGY_DEPLOYMENT_PINS.filter((k) => pins[k].source === "absent");
  const processOnly = AGY_DEPLOYMENT_PINS.filter((k) => pins[k].source === "process-env");

  // A host with no pins file and no AGY pins anywhere is NOT DEPLOYED, which is
  // a different fact from being deployed wrongly. media-server is exactly this:
  // it runs a bridge and no agy. Reporting that as a failure would be the
  // question-4 error this tool exists to avoid — it would describe a correct
  // host as broken — so it gets its own verdict and its own exit status.
  // "Ambiguous" is emphatically not "absent": a file with AGY pins in two apps
  // has agy deployed and cannot say which app owns it. Letting that fall into
  // the not-deployed path would report a configuration conflict as a host that
  // simply does not run agy.
  const notDeployed = absent.length === AGY_DEPLOYMENT_PINS.length
    && !processOnly.length
    && !ecosystem?.ambiguous;

  // 1. Pins must live in a file, not only in volatile process state.
  if (notDeployed) {
    checks.push(check("pins-in-file", "skipped",
      envFileError
        ? `no pins file at ${envFile} (${envFileError}) and no AGY pins in the process environment`
        : `${envFile} carries no AGY pins, and neither does the process environment`,
      "agy_not_deployed"));
  } else if (envFileError) {
    checks.push(check("pins-in-file", "fail",
      `cannot read pins file ${envFile} (${envFileError})`, "pins_file_unreadable"));
  } else if (ecosystem?.ambiguous) {
    checks.push(check("pins-in-file", "fail",
      `AGY pins appear in ${ecosystem.blocks.length} separate env blocks ` +
      `(${ecosystem.blocks.map((b) => b.app ?? "unnamed").join(", ")}); ` +
      `which app serves agy cannot be determined from the file alone`,
      "pins_in_multiple_apps"));
  } else if (processOnly.length) {
    checks.push(check("pins-in-file", "fail",
      `present only in the live process environment, absent from ${envFile}: ` +
      `${processOnly.join(", ")} — a restart resurrects this host without them`,
      "pins_only_in_process_env"));
  } else if (absent.length) {
    checks.push(check("pins-in-file", "fail",
      `absent from ${envFile} and from the process environment: ${absent.join(", ")}`,
      "pins_missing"));
  } else if (fileSource === "pm2-ecosystem") {
    // PASS, deliberately. The question this check asks is whether the pins are
    // recorded on disk rather than existing only in volatile process state, and
    // here they are — in the file the whole fleet actually uses. Failing it
    // would mean no host in the fleet can reach the passing state, which is a
    // gate nobody can satisfy. The pm2 lifecycle hazard below is real but it is
    // a property of pm2, not of this host being misdeployed (#390), so it is
    // reported as the consequence rather than as the verdict.
    checks.push(check("pins-in-file", "pass",
      `all ${AGY_DEPLOYMENT_PINS.length} pins read from the pm2 ecosystem file ` +
      `${envFile}${ecosystem?.app ? ` (app "${ecosystem.app}")` : ""}. ` +
      `pm2 re-reads this file only on \`pm2 delete <app> && pm2 start ${envFile}\` — ` +
      `\`pm2 restart\` does not — and a reboot restores from ~/.pm2/dump.pm2, not ` +
      `from here, so run \`pm2 save\` after any change or the next boot uses the ` +
      `last saved process list instead`));
  } else {
    checks.push(check("pins-in-file", "pass",
      `all ${AGY_DEPLOYMENT_PINS.length} pins read from ${envFile}`));
  }

  // 1b. The three sources of truth, compared (#390).
  //
  // This is the check that would have caught macbook-air. Everything else in
  // this file describes the artifact; this one asks whether the configuration
  // pointing at it will still be there after a restart or a reboot.
  let dumpPins = UNAVAILABLE;
  let dumpNote = null;
  if (pm2Dump) {
    let dumpText = null;
    try {
      dumpText = io.readFileSync(pm2Dump, "utf8");
    } catch (error) {
      dumpNote = `cannot read ${pm2Dump} (${error?.code ?? "EUNKNOWN"})`;
    }
    if (dumpText !== null) {
      const parsed = parsePm2DumpPins(dumpText);
      if (parsed.malformed) dumpNote = `${pm2Dump} is not a pm2 dump this can read`;
      else {
        // Match the app the ecosystem file names. Falling back to "the only app
        // carrying AGY pins" covers a KEY=VALUE host; more than one is ambiguous
        // and is reported as unknown rather than resolved by guessing.
        const named = ecosystem?.app
          ? parsed.apps.filter((a) => a.name === ecosystem.app)
          : parsed.apps.filter((a) => a.pins.size);
        if (named.length === 1) dumpPins = named[0].pins;
        else if (!named.length) {
          dumpNote = ecosystem?.app
            ? `${pm2Dump} has no app named "${ecosystem.app}", so a reboot would not start it`
            : `${pm2Dump} carries no AGY pins for any app`;
          dumpPins = new Map();
        } else dumpNote = `${pm2Dump} has ${named.length} apps carrying AGY pins`;
      }
    }
  }

  const livePins = Object.keys(processEnv).length
    ? new Map(AGY_DEPLOYMENT_PINS
      .filter((k) => Object.prototype.hasOwnProperty.call(processEnv, k))
      .map((k) => [k, String(processEnv[k])]))
    : UNAVAILABLE;

  const filePins = envFileError || ecosystem?.ambiguous
    ? UNAVAILABLE
    : new Map(AGY_DEPLOYMENT_PINS
      .filter((k) => pins[k].source === fileSource && pins[k].value !== null)
      .map((k) => [k, pins[k].value]));

  const comparison = compareAgyPinSources({ file: filePins, dump: dumpPins, live: livePins });
  if (notDeployed) {
    checks.push(check("pm2-state-consistent", "skipped",
      "agy is not deployed here, so there is no configuration to compare", "agy_not_deployed"));
  } else if (comparison.status === "unknown") {
    checks.push(check("pm2-state-consistent", "skipped",
      `fewer than two sources could be read (had: ${comparison.compared.join(", ") || "none"}; ` +
      `missing: ${comparison.unavailable.join(", ")})` + (dumpNote ? `. ${dumpNote}` : "") +
      ". Supply the running environment with --process-env <file.json> to compare all three.",
      "sources_unavailable"));
  } else if (comparison.status === "drifted") {
    checks.push(check("pm2-state-consistent", "drift",
      // The note explains WHY a source came back empty — "the dump has no app
      // by that name" is a different fault from "the dump lacks these keys",
      // and an operator needs the distinction to know what to run.
      (dumpNote ? `${dumpNote}. ` : "") +
      `${comparison.compared.join(", ")} disagree: ` +
      comparison.differences.map((d) => driftConsequence(d, envFile)).join("; ") +
      `. \`pm2 restart\` does not re-read ${envFile}; apply a change with ` +
      `\`pm2 delete ${ecosystem?.app ?? "<app>"} && pm2 start ${envFile}\`, then \`pm2 save\` ` +
      "so the next reboot restores what is actually running" +
      (comparison.unavailable.length ? `. Not compared: ${comparison.unavailable.join(", ")}` : ""),
      "pm2_state_drift"));
  } else {
    checks.push(check("pm2-state-consistent", "pass",
      `${comparison.compared.join(", ")} agree on all ${AGY_DEPLOYMENT_PINS.length} pins` +
      (comparison.unavailable.length
        ? `. Not compared: ${comparison.unavailable.join(", ")}` : "")));
  }

  const runtimeRoot = value("AGY_RUNTIME_ROOT");
  const sha256 = value("AGY_SHA256");
  const cliPath = value("AGY_CLI_PATH");

  // 2 and 3. The layout itself, before anything is read off the disk.
  if (!runtimeRoot || !sha256 || !cliPath) {
    checks.push(check("layout-canonical", "skipped",
      "AGY_RUNTIME_ROOT, AGY_SHA256 or AGY_CLI_PATH is unset", "pins_missing"));
    checks.push(check("runtime-root-managed", "skipped",
      "AGY_RUNTIME_ROOT is unset", "pins_missing"));
  } else {
    const expected = canonicalExecutable(runtimeRoot, sha256, platform);
    checks.push(cliPath === expected
      ? check("layout-canonical", "pass", `AGY_CLI_PATH is <root>/<sha256>/agy`)
      : check("layout-canonical", "fail",
        `AGY_CLI_PATH is ${cliPath}, expected ${expected}`, "cli_path_not_canonical"));

    const managed = path.resolve(runtimeParent);
    // Containment by path components, not by string prefix: a bare
    // `startsWith` admits `/opt/seam/agy-runtime-backup`, which is a sibling of
    // the managed parent rather than a child of it. Found by mutation.
    const relative = path.relative(managed, path.resolve(runtimeRoot));
    const withinManaged = relative === ""
      || (!relative.startsWith("..") && !path.isAbsolute(relative));
    checks.push(withinManaged
      ? check("runtime-root-managed", "pass", `AGY_RUNTIME_ROOT is under ${managed}`)
      : check("runtime-root-managed", "fail",
        `AGY_RUNTIME_ROOT is ${runtimeRoot}, outside the managed parent ${managed}`,
        "runtime_root_outside_managed_parent"));
  }

  // 4, 5, 6. The artifact the pins point at — which may simply be gone. Two of
  // the three hosts that had agy 1.1.27 lost it during #342, which is why this
  // is a first-class check and not an assumption.
  let artifactStat = null;
  if (!cliPath) {
    for (const id of ["artifact-present", "artifact-digest", "artifact-mode"]) {
      checks.push(check(id, "skipped", "AGY_CLI_PATH is unset", "pins_missing"));
    }
  } else {
    try {
      artifactStat = io.lstatSync(cliPath);
    } catch (error) {
      artifactStat = null;
      checks.push(check("artifact-present", "fail",
        `${cliPath} cannot be read (${error?.code ?? "EUNKNOWN"})`, "artifact_missing"));
    }
    if (artifactStat && !artifactStat.isFile()) {
      checks.push(check("artifact-present", "fail",
        `${cliPath} is not a regular file`, "artifact_not_regular_file"));
      artifactStat = null;
    } else if (artifactStat) {
      checks.push(check("artifact-present", "pass", `${cliPath} is a regular file`));
    }

    if (!artifactStat) {
      checks.push(check("artifact-digest", "skipped", "artifact is unreadable", "artifact_missing"));
      checks.push(check("artifact-mode", "skipped", "artifact is unreadable", "artifact_missing"));
    } else {
      let observedDigest = null;
      try {
        observedDigest = digestOf(cliPath, io);
      } catch (error) {
        checks.push(check("artifact-digest", "fail",
          `cannot hash ${cliPath} (${error?.code ?? "EUNKNOWN"})`, "artifact_missing"));
      }
      if (observedDigest) {
        checks.push(observedDigest === sha256
          ? check("artifact-digest", "pass", `sha256 matches AGY_SHA256`)
          : check("artifact-digest", "fail",
            `sha256 is ${observedDigest}, AGY_SHA256 pins ${sha256}`, "digest_mismatch"));
      }
      const mode = artifactStat.mode & 0o7777;
      checks.push(mode === MANAGED_FILE_MODE
        ? check("artifact-mode", "pass", `mode is 0${MANAGED_FILE_MODE.toString(8)}`)
        : check("artifact-mode", "fail",
          `mode is 0${mode.toString(8)}, reference layout is 0${MANAGED_FILE_MODE.toString(8)}`,
          "artifact_mode"));
    }
  }

  // 7. A symlink anywhere in the chain defeats the ancestor walk below: the
  // walk would inspect the link's own path components while exec follows it
  // somewhere else entirely. `docs/agy-native-runtime.md` requires a real,
  // non-symlink path for exactly this reason, and nothing checked it.
  if (!cliPath) {
    checks.push(check("path-not-symlinked", "skipped", "AGY_CLI_PATH is unset", "pins_missing"));
  } else {
    let resolved = null;
    try {
      resolved = io.realpathSync(cliPath);
    } catch (error) {
      checks.push(check("path-not-symlinked", "skipped",
        `cannot resolve ${cliPath} (${error?.code ?? "EUNKNOWN"})`, "artifact_missing"));
    }
    if (resolved !== null) {
      checks.push(resolved === cliPath
        ? check("path-not-symlinked", "pass", "AGY_CLI_PATH is already its real path")
        : check("path-not-symlinked", "fail",
          `AGY_CLI_PATH resolves to ${resolved}; the verified path and the executed ` +
          `path are different, so the ancestor walk inspects the wrong chain`,
          "path_is_symlinked"));
    }
  }

  // 8. Durability, which is NOT what the running bridge checks.
  //
  // `inspectComponent` separates "the service user cannot write this right now"
  // from "the service user cannot make this writable". A 0555 tree the service
  // user OWNS satisfies the first and fails the second, and a host in that state
  // reports `immutable-path` while being one chmod from replaceable. That is
  // reported as a failure on every platform, not only darwin, because the
  // question here is whether the host matches the reference layout — macbook-air
  // worked, reported immutable-path, and was still one reboot from dark.
  if (!cliPath) {
    checks.push(check("ancestors-durable", "skipped", "AGY_CLI_PATH is unset", "pins_missing"));
  } else {
    const weak = [];
    const acceptedToday = [];
    for (const component of pathChain(cliPath)) {
      let inspected;
      try {
        inspected = inspectComponent(component, {
          statSync: io.statSync,
          accessSync: io.accessSync,
        });
      } catch {
        continue; // A component that cannot be stat'd is covered by artifact-present.
      }
      if (!inspected.durable) weak.push(component);
      if (inspected.passesRuntimeCheck && !inspected.durable) acceptedToday.push(component);
    }
    if (!weak.length) {
      checks.push(check("ancestors-durable", "pass", `every component up to / is root-owned`));
    } else {
      // Naming the subset the runtime currently accepts is the difference
      // between a refusal an operator acts on and one they read as a false
      // positive, because agy is visibly working on every host in this state.
      const admitted = acceptedToday.length
        ? ` The running bridge accepts ${acceptedToday.length} of these today` +
          ` (${acceptedToday.join(", ")}), which is why this stays invisible.`
        : "";
      checks.push(check("ancestors-durable", "fail",
        `not root-owned, so the tree can be replaced by its owner: ${weak.join(", ")}.${admitted}`,
        "ancestor_not_root_owned"));
    }
  }

  // 9. Capability. Identity is not capability (#371); saying nothing about
  // capability is honest, and claiming it without probing would not be.
  if (!probe) {
    checks.push(check("capability", "skipped",
      "not probed; identity checks above do not prove this binary can serve a turn (#371). " +
      "Re-run with --probe to spawn the prompt-free `agy models` check.", "not_probed"));
  } else if (!cliPath || !artifactStat) {
    checks.push(check("capability", "skipped", "no readable artifact to probe", "artifact_missing"));
  } else {
    try {
      const { modelsObserved } = verifyAgyCapability(cliPath, probe === true ? {} : probe);
      checks.push(check("capability", "pass",
        `prompt-free \`agy models\` listed ${modelsObserved} model(s)`));
    } catch (error) {
      checks.push(check("capability", "fail",
        error instanceof Error ? error.message : String(error), "capability_failed"));
    }
  }

  return {
    schemaVersion: AGY_DEPLOYMENT_SCHEMA_VERSION,
    kind: "agy-deployment-verification",
    // Precedence: a wrong artifact outranks fragile configuration, which
    // outranks "agy is not here". Each is a different remediation.
    verdict: checks.some((c) => c.status === "fail") ? "fail"
      : notDeployed ? "not-deployed"
        : checks.some((c) => c.status === "drift") ? "drift" : "pass",
    // Always false, and asserted by the tests against a byte-level snapshot of
    // the host tree. A verifier that could repair would be a deployment tool
    // that half-applies, which is the outcome this whole story exists under.
    mutated: false,
    observed: {
      pinsFile: envFile,
      pinsFileFormat: fileSource,
      pm2Dump,
      pinSourcesCompared: comparison.compared,
      pm2App: ecosystem?.app ?? null,
      runtimeParent: path.resolve(runtimeParent),
      pinSources: Object.fromEntries(
        AGY_DEPLOYMENT_PINS.map((k) => [k, pins[k].source])),
      version: value("AGY_VERSION"),
      sha256,
      cliPath,
      runtimeRoot,
      enabled: value("AGY_ENABLED"),
    },
    checks,
  };
}

export function formatDeploymentReport(report) {
  const glyph = { pass: "PASS", fail: "FAIL", skipped: "SKIP", drift: "DRIFT" };
  const lines = [
    `agy deployment: ${report.verdict.toUpperCase()}  (host was not modified)`,
    `  pins file      ${report.observed.pinsFile} (${report.observed.pinsFileFormat})`,
    `  runtime root   ${report.observed.runtimeRoot ?? "(unset)"}`,
    `  version        ${report.observed.version ?? "(unset)"}`,
    "",
  ];
  for (const c of report.checks) {
    lines.push(`  ${glyph[c.status]}  ${c.id}`);
    lines.push(`        ${c.detail}`);
  }
  const skipped = report.checks.filter((c) => c.status === "skipped");
  if (skipped.length) {
    lines.push("", `  ${skipped.length} check(s) skipped — this report does not cover them.`);
  }
  return lines.join("\n");
}

/**
 * Every flag this tool accepts. None of them may be a name `node` itself parses
 * (#397): node scans the whole argv for its own options even after the script
 * path, so a collision is resolved by the runtime before the script starts and
 * the script cannot report, catch or work around it.
 */
export const AGY_DEPLOYMENT_FLAGS = Object.freeze([
  "--pins-file", "--format", "--runtime-parent", "--process-env", "--pm2-dump", "--probe", "--json",
]);

/**
 * The exit-code contract a rollout script reads. Separate from `main` because
 * exit 0 needs a root-owned tree that an unprivileged test cannot build, so
 * without this the mapping could only be checked on a real host — and a
 * mutation swapping pass and fail survived the whole suite because of it.
 *
 *   0  correct
 *   1  deployed, but not to the reference layout
 *   3  agy is not deployed here at all — an observation, not a failure
 */
export function exitCodeFor(verdict) {
  if (verdict === "pass") return 0;
  if (verdict === "not-deployed") return 3;
  // 4 is its own code because drift is not "misdeployed": the host is serving
  // turns correctly and will not survive a restart. The remediation is
  // `pm2 save` / `delete` + `start`, not re-staging the artifact, and a
  // caller that cannot tell those apart will do the wrong one.
  if (verdict === "drift") return 4;
  return 1;
}

/**
 * Where pm2 keeps the dump on every host in this fleet. Not derived from `pm2`
 * itself: the binary is absent from a non-interactive PATH on all three Macs
 * (#390's sixth failure), so asking it would fail in the exact situation this
 * check exists to examine.
 */
function defaultPm2Dump() {
  const home = process.env.PM2_HOME ?? (process.env.HOME ? path.join(process.env.HOME, ".pm2") : null);
  return home ? path.join(home, "dump.pm2") : null;
}

function parseArgs(argv) {
  const opts = { probe: null, json: false, processEnv: {}, pm2Dump: defaultPm2Dump() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pins-file") opts.envFile = argv[++i];
    else if (arg === "--env-file") {
      // Removed rather than documented (#397). `--env-file` is a node option:
      // pointed at a MISSING file node aborts with exit 9 before this script
      // runs, so the one host the not-deployed verdict was written for could
      // never report it. A flag whose name the runtime owns cannot be made to
      // work, and this synonym only ever existed for a documented path
      // (~/.seam/bridge.env) that has never existed on any host (#395).
      throw new Error(
        "--env-file is a node option and cannot be used here: pointed at a " +
        "missing file, node exits 9 before this script starts. Use --pins-file.");
    }
    else if (arg === "--format") opts.format = argv[++i];
    else if (arg === "--runtime-parent") opts.runtimeParent = argv[++i];
    else if (arg === "--process-env") opts.processEnvFile = argv[++i];
    else if (arg === "--pm2-dump") opts.pm2Dump = argv[++i];
    else if (arg === "--probe") opts.probe = true;
    else if (arg === "--json") opts.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.envFile) throw new Error("--pins-file is required");
  return opts;
}

export async function main(argv, out = console) {
  const opts = parseArgs(argv);
  if (opts.processEnvFile) {
    opts.processEnv = JSON.parse(fs.readFileSync(opts.processEnvFile, "utf8"));
  }
  const report = verifyAgyDeployment(opts);
  out.log(opts.json ? JSON.stringify(report, null, 2) : formatDeploymentReport(report));
  return exitCodeFor(report.verdict);
}

/**
 * Run only when invoked directly. Compared through `realpath` because on macOS
 * `/tmp` is a symlink to `/private/tmp`: `import.meta.url` resolves the link and
 * `process.argv[1]` does not, so the naive string comparison silently does
 * nothing and exits 0 — which is exactly how this was found, running the
 * verifier from `/tmp` on three Macs and getting no output at all.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  return real(fileURLToPath(import.meta.url)) === real(entry);
})();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}
