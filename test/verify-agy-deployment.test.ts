/**
 * #265 (AGY R9) — "is this host correctly deployed?" has to have an answer.
 *
 * Five hosts were migrated by hand on 2026-09-12 and every one was shaped
 * differently. The three shapes below are the ones actually observed, and they
 * are the fixtures here rather than invented cases:
 *
 *   A. root-owned `/opt/seam/agy-runtime/<sha>/agy`, pins in a file  — correct
 *   B. `$HOME/.seam/agy-runtime/<sha>/agy`, pins in a file           — replaceable
 *   C. pins present only in the live pm2 process environment (#390)  — one reboot from dark
 *
 * B and C both WORKED when observed. Both reported `provenance mode:
 * immutable-path`. That is the whole difficulty: the failure is invisible from
 * the host's own point of view, so most of this file asserts that the verifier
 * reports the specific thing that is wrong rather than an overall mood.
 *
 * The second load-bearing property is negative. Four of five hosts are agy-only,
 * so a tool that "fixes" a host it misdiagnosed takes a family laptop to zero
 * agents — outcome 4 in the blast-radius ordering. The verifier therefore has no
 * write surface at all, and that is asserted two ways: a byte-level snapshot of
 * a failing host before and after, and an `io` that throws on any function
 * outside the five read calls.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGY_DEPLOYMENT_PINS,
  canonicalExecutable,
  formatDeploymentReport,
  main,
  parsePm2EcosystemPins,
  readOnlyIo,
  resolvePinSources,
  verifyAgyDeployment,
} from "../scripts/verify-agy-deployment.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Only two tests harden directories to 0555, so try the cheap removal first
    // and walk chmod'ing only if that fails. The unconditional recursive walk
    // this replaced was enough extra filesystem churn to tip already-marginal
    // timing tests elsewhere in the suite over their budgets when scheduled
    // alongside this file — see the PR for the run-by-run evidence.
    try {
      fs.rmSync(root, { recursive: true, force: true });
      continue;
    } catch { /* a 0555 directory is in the way; relax and retry */ }
    const relax = (dir: string): void => {
      let entries: fs.Dirent[] = [];
      try {
        fs.chmodSync(dir, 0o700);
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch { return; }
      for (const entry of entries) if (entry.isDirectory()) relax(path.join(dir, entry.name));
    };
    relax(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const BODY = Buffer.from(`#!/bin/sh
if [ "$1" = "--log-file" ] && [ "$3" = "models" ]; then
  printf 'fixture-model\\tFixture Model\\n'
  exit 0
fi
exit 2
`);
const DIGEST = createHash("sha256").update(BODY).digest("hex");

interface Host {
  root: string;
  envFile: string;
  runtimeParent: string;
  runtimeRoot: string;
  cliPath: string;
  processEnv: Record<string, string>;
}

/**
 * Build one of the observed layouts.
 *
 * `underHome` chooses between the managed parent and `$HOME` staging;
 * `pinsInFile: false` writes an env file with no AGY keys and puts them in the
 * process environment instead, which is exactly macbook-air as found.
 */
function host(opts: {
  underHome?: boolean;
  pinsInFile?: boolean;
  version?: string;
  mode?: number;
  body?: Buffer;
  omitPins?: string[];
  /** Stage in `<parent>-backup`: a sibling that shares the parent's prefix. */
  siblingOfParent?: boolean;
  /** "pm2" writes the ecosystem module the fleet actually uses (#395). */
  pinsFormat?: "env" | "pm2";
} = {}): Host {
  const {
    underHome = false, pinsInFile = true, version = "1.1.28",
    mode = 0o555, body = BODY, omitPins = [],
  } = opts;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seam-265-")));
  roots.push(root);

  const runtimeParent = path.join(root, "opt", "seam", "agy-runtime");
  const homeParent = path.join(root, "home", "seam", ".seam", "agy-runtime");
  const runtimeRoot = opts.siblingOfParent
    ? `${runtimeParent}-backup`
    : underHome ? homeParent : runtimeParent;

  const digest = createHash("sha256").update(body).digest("hex");
  const release = path.join(runtimeRoot, digest);
  fs.mkdirSync(release, { recursive: true });
  const cliPath = path.join(release, "agy");
  fs.writeFileSync(cliPath, body);
  fs.chmodSync(cliPath, mode);

  const pins: Record<string, string> = {
    AGY_RUNTIME_ROOT: runtimeRoot,
    AGY_SHA256: digest,
    AGY_CLI_PATH: cliPath,
    AGY_VERSION: version,
    AGY_DEFAULT_MODEL: "gemini-3.1-pro-high",
    AGY_ENABLED: "true",
  };
  for (const key of omitPins) delete pins[key];

  const fileEntries: Record<string, string> = {
    SEAM_BRIDGE_ID: "fixture-host",
    GROK_CLI_PATH: "/usr/local/bin/grok",
    ...(pinsInFile ? pins : {}),
  };

  // The fleet keeps pins in a pm2 ecosystem module, not a KEY=VALUE file. This
  // shape is copied from macbook-pro/macbook-air/home-hub as observed on
  // 2026-09-13 — indentation, quoting and trailing commas included — because
  // the previous fixtures took the pins-file shape from the documentation and
  // that is the single assumption #395 turned on.
  const envFile = path.join(root, opts.pinsFormat === "pm2" ? "ecosystem.config.cjs" : "bridge.env");
  fs.writeFileSync(envFile, opts.pinsFormat === "pm2"
    ? [
      "module.exports = {",
      "  apps: [",
      "    {",
      `      name: "seam-bridge",`,
      `      cwd: "${root}",`,
      `      script: "packages/bridge/dist/index.js",`,
      "      env: {",
      ...Object.entries(fileEntries).map(([k, v]) => `        ${k}: "${v}",`),
      "      },",
      "    },",
      "  ],",
      "};",
      "",
    ].join("\n")
    : `${Object.entries(fileEntries).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);

  return {
    root, envFile, runtimeParent, runtimeRoot, cliPath,
    processEnv: pinsInFile ? {} : pins,
  };
}

/**
 * The one thing an unprivileged test cannot create is a root-owned tree, so it
 * is injected — the same concession `stage-agy-runtime.test.ts` makes for
 * `chown`. Everything else about layout A is real: real files, real modes, real
 * `access(W_OK)`.
 */
function rootOwnedIo(): ReturnType<typeof readOnlyIo> {
  const base = readOnlyIo();
  return Object.freeze({
    ...base,
    statSync: (p: string) => ({ uid: 0, mode: base.statSync(p).mode }),
  }) as ReturnType<typeof readOnlyIo>;
}

function verdictFor(h: Host, extra: Record<string, unknown> = {}, io = rootOwnedIo()) {
  return verifyAgyDeployment({
    envFile: h.envFile,
    processEnv: h.processEnv,
    runtimeParent: h.runtimeParent,
    platform: "darwin",
    ...extra,
  }, io);
}

const byId = (report: { checks: Array<{ id: string }> }, id: string) =>
  report.checks.find((c) => c.id === id)!;

/** Every byte, mode, owner and mtime under a tree — the no-mutation oracle. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      const stat = fs.lstatSync(full);
      const bits = `${stat.mode.toString(8)}:${stat.uid}:${stat.gid}:${stat.mtimeMs}`;
      if (entry.isDirectory()) {
        out[rel] = `dir ${bits}`;
        visit(full);
      } else {
        out[rel] = `file ${bits}:${createHash("sha256")
          .update(fs.readFileSync(full)).digest("hex")}`;
      }
    }
  };
  visit(root);
  return out;
}

describe("#265 the three layouts observed on 2026-09-12", () => {
  it("reports a root-owned host with file pins as correct", () => {
    const report = verdictFor(host());
    expect(report.verdict).toBe("pass");
    expect(report.observed.pinSources).toEqual(
      Object.fromEntries(AGY_DEPLOYMENT_PINS.map((k) => [k, "file"])));
    for (const id of ["pins-in-file", "layout-canonical", "runtime-root-managed",
      "artifact-present", "artifact-digest", "artifact-mode", "ancestors-durable"]) {
      expect(byId(report, id).status).toBe("pass");
    }
  });

  it("refuses a $HOME-staged host and names the components that are not root-owned", () => {
    const h = host({ underHome: true });
    // Real ownership this time: the fixture tree genuinely belongs to the test
    // user, which is exactly what `~/.seam/agy-runtime` is on a Mac.
    const report = verdictFor(h, {}, readOnlyIo());
    expect(report.verdict).toBe("fail");
    expect(byId(report, "runtime-root-managed").reasonCode)
      .toBe("runtime_root_outside_managed_parent");
    const ancestors = byId(report, "ancestors-durable");
    expect(ancestors.status).toBe("fail");
    expect(ancestors.reasonCode).toBe("ancestor_not_root_owned");
    expect(ancestors.detail).toContain(h.runtimeRoot);
  });

  it("refuses a host whose pins exist only in the live process environment", () => {
    const h = host({ pinsInFile: false });
    const report = verdictFor(h);
    expect(report.verdict).toBe("fail");
    const pinCheck = byId(report, "pins-in-file");
    expect(pinCheck.reasonCode).toBe("pins_only_in_process_env");
    // The cost has to be in the message, because the host looks healthy.
    expect(pinCheck.detail).toContain("restart");
    expect(report.observed.pinSources.AGY_SHA256).toBe("process-env");
    // Everything downstream still resolves, which is why this was invisible:
    // the artifact is genuinely fine, only its configuration is unrecorded.
    expect(byId(report, "artifact-digest").status).toBe("pass");
  });

  it("says the running bridge admits the replaceable tree today, which is why nobody noticed", () => {
    // `inspectComponent` separates "not writable now" from "cannot be made
    // writable". A 0555 tree owned by the service user satisfies the first and
    // fails the second — it reports immutable-path while being one chmod from
    // replaceable. Without this sentence an operator reads the refusal as a
    // false positive, because agy is visibly working.
    const h = host({ underHome: true });
    const hardened = [path.dirname(h.cliPath), h.runtimeRoot];
    for (const dir of hardened) fs.chmodSync(dir, 0o555);
    const detail = byId(verdictFor(h, {}, readOnlyIo()), "ancestors-durable").detail;
    expect(detail).toContain("which is why this stays invisible");
    // Named individually, because those are the ones an operator will look at
    // and conclude are already correct.
    for (const dir of hardened) expect(detail).toContain(dir);
  });
});

describe("#265 a failing host is reported, never repaired", () => {
  it.each([
    ["$HOME staging", { underHome: true }],
    ["process-env pins", { pinsInFile: false }],
    ["vanished artifact", { }],
  ])("leaves every byte, mode and mtime unchanged: %s", (label, opts) => {
    const h = host(opts as Parameters<typeof host>[0]);
    if (label === "vanished artifact") fs.rmSync(h.cliPath);
    const before = snapshot(h.root);
    const report = verdictFor(h, {}, readOnlyIo());
    expect(report.verdict).toBe("fail");
    expect(report.mutated).toBe(false);
    expect(snapshot(h.root)).toEqual(before);
  });

  it("completes with an io that throws on anything that is not one of five read calls", () => {
    // Behavioural rather than a grep: if the module ever reached for a write,
    // chmod, rename, unlink or spawn, this would throw instead of reporting.
    const allowed = new Set(["statSync", "lstatSync", "readFileSync", "accessSync", "realpathSync"]);
    const base = readOnlyIo();
    const guarded = new Proxy(base as Record<string, unknown>, {
      get(target, key: string) {
        if (!allowed.has(key)) throw new Error(`verifier reached for io.${String(key)}`);
        return target[key];
      },
    }) as ReturnType<typeof readOnlyIo>;
    const report = verifyAgyDeployment(
      { envFile: host({ underHome: true }).envFile, platform: "darwin" }, guarded);
    expect(report.verdict).toBe("fail");
  });

  it("exposes no repair, fix or force entry point", async () => {
    const module = await import("../scripts/verify-agy-deployment.mjs");
    expect(Object.keys(module).filter((k) => /repair|fix|force|apply|write|migrate/i.test(k)))
      .toEqual([]);
  });
});

describe("#265 the artifact the pins point at", () => {
  it("reports a vanished binary rather than assuming it is there", () => {
    // agy 1.1.27 disappeared from two of the three hosts that had it during
    // #342, which is why an archived copy exists at all.
    const h = host();
    fs.rmSync(h.cliPath);
    const report = verdictFor(h);
    expect(report.verdict).toBe("fail");
    expect(byId(report, "artifact-present").reasonCode).toBe("artifact_missing");
    expect(byId(report, "artifact-digest").status).toBe("skipped");
  });

  it("reports a digest that no longer matches its pin", () => {
    const h = host();
    const stale = `${h.cliPath}`;
    fs.chmodSync(stale, 0o755);
    fs.writeFileSync(stale, Buffer.concat([BODY, Buffer.from("\n# drifted\n")]));
    fs.chmodSync(stale, 0o555);
    const report = verdictFor(h);
    expect(byId(report, "artifact-digest").reasonCode).toBe("digest_mismatch");
  });

  it("reports a mode that is not 0555", () => {
    const h = host({ mode: 0o755 });
    const report = verdictFor(h);
    expect(byId(report, "artifact-mode").reasonCode).toBe("artifact_mode");
    // Still the same bytes, so the digest is fine — the report must not blur
    // the two, because the remediation differs.
    expect(byId(report, "artifact-digest").status).toBe("pass");
  });

  it("reports a symlinked executable as not a regular file", () => {
    const h = host();
    const real = `${h.cliPath}.real`;
    fs.renameSync(h.cliPath, real);
    fs.symlinkSync(real, h.cliPath);
    const report = verdictFor(h);
    expect(byId(report, "artifact-present").reasonCode).toBe("artifact_not_regular_file");
  });

  it("reports a symlinked ancestor, which would make the walk inspect the wrong chain", () => {
    // The ancestor walk climbs the components of AGY_CLI_PATH. If one of them
    // is a link, exec follows it somewhere the walk never looked, so every
    // durability conclusion above is about a different directory.
    const h = host();
    const realRelease = path.dirname(h.cliPath);
    const alias = path.join(h.runtimeRoot, "current");
    fs.symlinkSync(realRelease, alias);
    const linked = path.join(alias, "agy");
    const text = fs.readFileSync(h.envFile, "utf8")
      .replace(/^AGY_CLI_PATH=.*$/m, `AGY_CLI_PATH=${linked}`);
    fs.writeFileSync(h.envFile, text);
    const report = verdictFor(h);
    const symlink = byId(report, "path-not-symlinked");
    expect(symlink.reasonCode).toBe("path_is_symlinked");
    expect(symlink.detail).toContain(h.cliPath);
  });

  it("reports a non-canonical AGY_CLI_PATH without guessing the right one", () => {
    const h = host();
    const text = fs.readFileSync(h.envFile, "utf8")
      .replace(/^AGY_CLI_PATH=.*$/m, `AGY_CLI_PATH=${path.join(h.runtimeRoot, "agy")}`);
    fs.writeFileSync(h.envFile, text);
    const report = verdictFor(h);
    expect(byId(report, "layout-canonical").reasonCode).toBe("cli_path_not_canonical");
    expect(byId(report, "layout-canonical").detail)
      .toContain(canonicalExecutable(h.runtimeRoot, path.basename(path.dirname(h.cliPath)), "darwin"));
  });
});

describe("#265 identity is not capability", () => {
  it("skips the capability check by default and says that it skipped it", () => {
    // macbook-pro passed every identity check while serving zero turns (#371).
    // A report that silently omitted capability would read as "verified".
    const report = verdictFor(host());
    const capability = byId(report, "capability");
    expect(capability.status).toBe("skipped");
    expect(capability.reasonCode).toBe("not_probed");
    expect(capability.detail).toContain("do not prove");
  });

  it("fails a host whose identity is perfect and whose language server cannot list models", () => {
    const h = host();
    const report = verdictFor(h, {
      probe: {
        run: () => { const e = new Error("missing CSRF token"); (e as { status?: number }).status = 23; throw e; },
      },
    });
    expect(byId(report, "artifact-digest").status).toBe("pass");
    expect(byId(report, "ancestors-durable").status).toBe("pass");
    expect(byId(report, "capability").reasonCode).toBe("capability_failed");
    expect(report.verdict).toBe("fail");
  });

  it("passes when the prompt-free models probe actually lists models", () => {
    const h = host();
    const report = verdictFor(h, {
      probe: { run: () => "fixture-model\tFixture Model\n" },
    });
    expect(report.verdict).toBe("pass");
    expect(byId(report, "capability").detail).toContain("1 model");
  });
});

describe("#265 no version policy", () => {
  it("records the deployed version without judging it", () => {
    // #266 settled this: the gate binds evidence to an exact version and digest,
    // and there is no allowlist or blocklist. 1.2.2 is an incident label, not a
    // runtime policy, so a correctly-staged 1.2.2 host passes identity here and
    // is caught by --probe or by the upgrade gate, not by its version string.
    const report = verdictFor(host({ version: "1.2.2" }));
    expect(report.observed.version).toBe("1.2.2");
    expect(report.verdict).toBe("pass");
    expect(JSON.stringify(report.checks)).not.toContain("1.2.2");
  });
});

describe("#265 mutation survivors, closed", () => {
  it("requires these six pins by name, not whatever the constant happens to list", () => {
    // Asserting against AGY_DEPLOYMENT_PINS made the earlier check circular:
    // dropping AGY_ENABLED from the constant changed the expectation with it.
    expect([...AGY_DEPLOYMENT_PINS]).toEqual([
      "AGY_RUNTIME_ROOT", "AGY_SHA256", "AGY_CLI_PATH",
      "AGY_VERSION", "AGY_DEFAULT_MODEL", "AGY_ENABLED",
    ]);
  });

  it("refuses a sibling of the managed parent, not merely a string that starts like it", () => {
    // The runtime root is `<parent>-backup`, which a string prefix test accepts
    // as being inside `<parent>` and a component test does not. The direction
    // matters: the root has to be the sibling, not the parent.
    const h = host({ siblingOfParent: true });
    expect(h.runtimeRoot).toBe(`${h.runtimeParent}-backup`);
    const report = verdictFor(h);
    expect(byId(report, "runtime-root-managed").reasonCode)
      .toBe("runtime_root_outside_managed_parent");
  });

  it("says in the text report how many checks it did not cover", () => {
    // The skipped count is the honesty property of the default run: without it
    // a reader sees only passes and concludes the host is fully verified.
    const h = host();
    const text = formatDeploymentReport(verdictFor(h));
    // Two now: capability, and the three-source comparison when neither the
    // pm2 dump nor a live environment was supplied (#390).
    expect(text).toContain("2 check(s) skipped");
    expect(text).toContain("host was not modified");
    // The header must name the file it read and how it read it. A stale key
    // here printed `undefined` on three live hosts before anyone noticed.
    expect(text).toContain(`${h.envFile} (file)`);
  });
});

/** The fleet's real file, reduced to the parts that matter. No token. */
function ecosystem(envLines: string[], opts: { apps?: string[] } = {}): string {
  const apps = opts.apps ?? ["seam-bridge"];
  return [
    "module.exports = {",
    "  apps: [",
    ...apps.flatMap((name) => [
      "    {",
      `      name: "${name}",`,
      "      env: {",
      ...envLines.map((l) => `        ${l}`),
      "      },",
      "    },",
    ]),
    "  ],",
    "};",
    "",
  ].join("\n");
}

describe("#395 pins where the fleet actually keeps them", () => {
  it("reads a pm2 ecosystem module without executing it", () => {
    const report = verdictFor(host({ pinsFormat: "pm2" }));
    expect(report.verdict).toBe("pass");
    expect(report.observed.pinsFileFormat).toBe("pm2-ecosystem");
    expect(report.observed.pm2App).toBe("seam-bridge");
    for (const key of AGY_DEPLOYMENT_PINS) {
      expect(report.observed.pinSources[key]).toBe("pm2-ecosystem");
    }
    // The substantive checks must actually run — the #395 symptom was eight
    // skips behind one false FAIL.
    for (const id of ["layout-canonical", "runtime-root-managed", "artifact-present",
      "artifact-digest", "artifact-mode", "path-not-symlinked", "ancestors-durable"]) {
      expect(byId(report, id).status).toBe("pass");
    }
  });

  it("names the pm2 lifecycle consequence an operator has to act on", () => {
    const detail = byId(verdictFor(host({ pinsFormat: "pm2" })), "pins-in-file").detail;
    expect(detail).toContain("pm2 restart");
    expect(detail).toContain("pm2 save");
    expect(detail).toContain("dump.pm2");
  });

  it("never executes the module: the io has no require, import or spawn to reach for", () => {
    // If the implementation ever switched to require()ing the config, the
    // frozen five-call io would be bypassed and this contract would be a lie.
    const io = readOnlyIo();
    expect(Object.keys(io).sort())
      .toEqual(["accessSync", "lstatSync", "readFileSync", "realpathSync", "statSync"]);
  });

  it("reads a pm2 value containing // without treating it as a comment", () => {
    const { pins } = parsePm2EcosystemPins(ecosystem([
      `AGY_CLI_PATH: "https://example.invalid//opt/agy",`,
    ]));
    expect(pins.get("AGY_CLI_PATH")).toBe("https://example.invalid//opt/agy");
  });
});

describe("#395 the matcher refuses rather than guessing", () => {
  it("ignores a commented-out pin", () => {
    const { pins } = parsePm2EcosystemPins(ecosystem([
      `// AGY_ENABLED: "true",`,
      `AGY_VERSION: "1.1.27",`,
    ]));
    expect(pins.has("AGY_ENABLED")).toBe(false);
    expect(pins.get("AGY_VERSION")).toBe("1.1.27");
  });

  it("ignores a pin inside a block comment", () => {
    const { pins } = parsePm2EcosystemPins(ecosystem([
      `/* AGY_ENABLED: "true", */`,
      `AGY_VERSION: "1.1.27",`,
    ]));
    expect(pins.has("AGY_ENABLED")).toBe(false);
  });

  it("keeps a real pin that has a comment after it on the same line", () => {
    // Mutation found that comment-stripping and the `^` anchor were each
    // covering for the other in every test. They differ here: without
    // stripping, the trailing comment defeats the end anchor and a CORRECT pin
    // is silently missed — a false FAIL on a good host, which is #395 again.
    const { pins } = parsePm2EcosystemPins(ecosystem([
      `AGY_VERSION: "1.1.27", // pinned by #342`,
    ]));
    expect(pins.get("AGY_VERSION")).toBe("1.1.27");
  });

  it("ignores a pin on an interior line of a block comment", () => {
    // And they differ the other way here: the interior line begins with the
    // key, so the anchor alone accepts it. Only stripping refuses it, and
    // accepting it would be a false PASS carrying a fabricated version.
    const { pins } = parsePm2EcosystemPins(ecosystem([
      "/*",
      `AGY_VERSION: "9.9.9",`,
      "*/",
      `AGY_ENABLED: "true",`,
    ]));
    expect(pins.has("AGY_VERSION")).toBe(false);
    expect(pins.get("AGY_ENABLED")).toBe("true");
  });

  it("ignores a pin that is not the first thing on its line", () => {
    // `^` is what refuses this; a second assignment sharing a line is not a
    // shape the fleet writes, and guessing at it is how a false PASS starts.
    const { pins } = parsePm2EcosystemPins(ecosystem([
      `SOME_OTHER: "x", AGY_VERSION: "9.9.9",`,
    ]));
    expect(pins.has("AGY_VERSION")).toBe(false);
  });

  it("ignores a value that is not a complete single-line string literal", () => {
    for (const line of [
      "AGY_VERSION: process.env.AGY_VERSION,",
      "AGY_VERSION: `1.1.27`,",
      `AGY_VERSION: "1.1." +`,
      `AGY_VERSION: "1.1.27" + suffix,`,
    ]) {
      expect(parsePm2EcosystemPins(ecosystem([line])).pins.has("AGY_VERSION")).toBe(false);
    }
  });

  it("ignores a pin nested inside a deeper object within env", () => {
    const { pins } = parsePm2EcosystemPins(ecosystem([
      "nested: {",
      `  AGY_VERSION: "9.9.9",`,
      "},",
      `AGY_ENABLED: "true",`,
    ]));
    expect(pins.has("AGY_VERSION")).toBe(false);
    expect(pins.get("AGY_ENABLED")).toBe("true");
  });

  it("refuses when two apps both carry AGY pins instead of picking one", () => {
    const text = ecosystem([`AGY_VERSION: "1.1.27",`], { apps: ["seam-bridge", "other-agent"] });
    const parsed = parsePm2EcosystemPins(text);
    expect(parsed.ambiguous).toBe(true);
    expect(parsed.pins.size).toBe(0);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seam-265-")));
    roots.push(root);
    const file = path.join(root, "ecosystem.config.cjs");
    fs.writeFileSync(file, text);
    const report = verifyAgyDeployment({ envFile: file, platform: "darwin" }, readOnlyIo());
    expect(byId(report, "pins-in-file").reasonCode).toBe("pins_in_multiple_apps");
    expect(byId(report, "pins-in-file").detail).toContain("other-agent");
  });

  it("does not mistake an AGY key outside any env block for a pin", () => {
    const text = [
      "module.exports = {",
      "  apps: [",
      "    {",
      `      name: "seam-bridge",`,
      `      AGY_VERSION: "9.9.9",`,
      "      env: {",
      `        AGY_ENABLED: "true",`,
      "      },",
      "    },",
      "  ],",
      "};",
    ].join("\n");
    const { pins } = parsePm2EcosystemPins(text);
    expect(pins.has("AGY_VERSION")).toBe(false);
    expect(pins.get("AGY_ENABLED")).toBe("true");
  });
});

describe("#395 a host where agy is simply not deployed", () => {
  it("reports 'not deployed' rather than a failure, with its own exit status", async () => {
    // media-server runs a bridge and no agy, and has no ecosystem file at all.
    // Calling that "fail" would describe a correct host as broken.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seam-265-")));
    roots.push(root);
    const report = verifyAgyDeployment(
      { envFile: path.join(root, "ecosystem.config.cjs"), platform: "darwin" }, readOnlyIo());
    expect(report.verdict).toBe("not-deployed");
    expect(byId(report, "pins-in-file").reasonCode).toBe("agy_not_deployed");
    // Not "file": there is no file, and labelling it with a format it never
    // had is the kind of small lie this tool exists to avoid.
    expect(report.observed.pinsFileFormat).toBe("absent");
    // Every substantive check must say it was skipped, not silently pass.
    for (const c of report.checks) expect(c.status).toBe("skipped");
    const lines: string[] = [];
    const code = await main(["--pins-file", path.join(root, "ecosystem.config.cjs")],
      { log: (s: string) => lines.push(s) });
    expect(code).toBe(3);
    expect(lines.join("\n")).toContain("NOT-DEPLOYED");
  });

  it("still fails a host that has a pins file carrying only some of the pins", () => {
    // Partial pins are a misdeployment, not an absence, and must not be
    // swallowed by the not-deployed path.
    const report = verdictFor(host({ pinsFormat: "pm2", omitPins: ["AGY_SHA256"] }));
    expect(report.verdict).toBe("fail");
    expect(byId(report, "pins-in-file").reasonCode).toBe("pins_missing");
  });
});

describe("#265 pin resolution", () => {
  it("prefers the file over the process environment when both have a key", () => {
    // pm2 keeps a stale copy of everything; the file is the source of truth and
    // the process env is only a cache of it (#390).
    const { sources } = resolvePinSources("AGY_SHA256=from-file\n", { AGY_SHA256: "from-process" });
    expect(sources.AGY_SHA256).toEqual({ value: "from-file", source: "file" });
  });

  it("reports a pin that is in neither place as absent, not as empty", () => {
    const report = verdictFor(host({ omitPins: ["AGY_VERSION"] }));
    expect(byId(report, "pins-in-file").reasonCode).toBe("pins_missing");
    expect(report.observed.pinSources.AGY_VERSION).toBe("absent");
    expect(report.observed.version).toBeNull();
  });
});
