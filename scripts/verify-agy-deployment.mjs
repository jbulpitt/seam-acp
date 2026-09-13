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
 * Where each pin actually resolves from.
 *
 * The distinction is the point. A pin present in the live process environment
 * and absent from every file is not "configured" — macbook-air reported
 * `provenance mode: immutable-path` from exactly that state, with a `dump.pm2`
 * stale since August, and a reboot would have resurrected it without pins and
 * dropped agy with no trail back to a cause.
 */
export function resolvePinSources(envFileText, processEnv = {}) {
  const fromFile = new Map();
  if (typeof envFileText === "string") {
    const { index } = parseEnvFile(envFileText);
    for (const key of AGY_DEPLOYMENT_PINS) {
      const found = index.get(key);
      if (found !== undefined) fromFile.set(key, found.value);
    }
  }
  const sources = {};
  for (const key of AGY_DEPLOYMENT_PINS) {
    if (fromFile.has(key)) sources[key] = { value: fromFile.get(key), source: "file" };
    else if (Object.prototype.hasOwnProperty.call(processEnv, key)) {
      sources[key] = { value: processEnv[key], source: "process-env" };
    } else sources[key] = { value: null, source: "absent" };
  }
  return sources;
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
  } = options;

  let envFileText = null;
  let envFileError = null;
  try {
    envFileText = io.readFileSync(envFile, "utf8");
  } catch (error) {
    envFileError = error?.code ?? "EUNKNOWN";
  }

  const pins = resolvePinSources(envFileText, processEnv);
  const value = (key) => pins[key]?.value ?? null;
  const checks = [];

  // 1. Pins must live in a file the bridge re-reads, not in process state.
  if (envFileError) {
    checks.push(check("pins-in-file", "fail",
      `cannot read pins file ${envFile} (${envFileError})`, "pins_file_unreadable"));
  } else {
    const absent = AGY_DEPLOYMENT_PINS.filter((k) => pins[k].source === "absent");
    const processOnly = AGY_DEPLOYMENT_PINS.filter((k) => pins[k].source === "process-env");
    if (processOnly.length) {
      checks.push(check("pins-in-file", "fail",
        `present only in the live process environment, absent from ${envFile}: ` +
        `${processOnly.join(", ")} — a restart resurrects this host without them`,
        "pins_only_in_process_env"));
    } else if (absent.length) {
      checks.push(check("pins-in-file", "fail",
        `absent from ${envFile} and from the process environment: ${absent.join(", ")}`,
        "pins_missing"));
    } else {
      checks.push(check("pins-in-file", "pass", `all ${AGY_DEPLOYMENT_PINS.length} pins read from ${envFile}`));
    }
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
    verdict: checks.some((c) => c.status === "fail") ? "fail" : "pass",
    // Always false, and asserted by the tests against a byte-level snapshot of
    // the host tree. A verifier that could repair would be a deployment tool
    // that half-applies, which is the outcome this whole story exists under.
    mutated: false,
    observed: {
      envFile,
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
  const glyph = { pass: "PASS", fail: "FAIL", skipped: "SKIP" };
  const lines = [
    `agy deployment: ${report.verdict.toUpperCase()}  (host was not modified)`,
    `  pins file      ${report.observed.envFile}`,
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

function parseArgs(argv) {
  const opts = { probe: null, json: false, processEnv: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env-file") opts.envFile = argv[++i];
    else if (arg === "--runtime-parent") opts.runtimeParent = argv[++i];
    else if (arg === "--process-env") opts.processEnvFile = argv[++i];
    else if (arg === "--probe") opts.probe = true;
    else if (arg === "--json") opts.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.envFile) throw new Error("--env-file is required");
  return opts;
}

export async function main(argv, out = console) {
  const opts = parseArgs(argv);
  if (opts.processEnvFile) {
    opts.processEnv = JSON.parse(fs.readFileSync(opts.processEnvFile, "utf8"));
  }
  const report = verifyAgyDeployment(opts);
  out.log(opts.json ? JSON.stringify(report, null, 2) : formatDeploymentReport(report));
  return report.verdict === "pass" ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}
