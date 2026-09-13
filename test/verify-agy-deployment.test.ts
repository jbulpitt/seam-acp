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
  readOnlyIo,
  resolvePinSources,
  verifyAgyDeployment,
} from "../scripts/verify-agy-deployment.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
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
} = {}): Host {
  const {
    underHome = false, pinsInFile = true, version = "1.1.28",
    mode = 0o555, body = BODY, omitPins = [],
  } = opts;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seam-265-")));
  roots.push(root);

  const runtimeParent = path.join(root, "opt", "seam", "agy-runtime");
  const homeParent = path.join(root, "home", "seam", ".seam", "agy-runtime");
  const runtimeRoot = underHome ? homeParent : runtimeParent;

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

  const envFile = path.join(root, "bridge.env");
  const fileEntries: Record<string, string> = {
    SEAM_BRIDGE_ID: "fixture-host",
    GROK_CLI_PATH: "/usr/local/bin/grok",
    ...(pinsInFile ? pins : {}),
  };
  fs.writeFileSync(
    envFile,
    `${Object.entries(fileEntries).map(([k, v]) => `${k}=${v}`).join("\n")}\n`
  );

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

describe("#265 pin resolution", () => {
  it("prefers the file over the process environment when both have a key", () => {
    // pm2 keeps a stale copy of everything; the file is the source of truth and
    // the process env is only a cache of it (#390).
    const sources = resolvePinSources("AGY_SHA256=from-file\n", { AGY_SHA256: "from-process" });
    expect(sources.AGY_SHA256).toEqual({ value: "from-file", source: "file" });
  });

  it("reports a pin that is in neither place as absent, not as empty", () => {
    const report = verdictFor(host({ omitPins: ["AGY_VERSION"] }));
    expect(byId(report, "pins-in-file").reasonCode).toBe("pins_missing");
    expect(report.observed.pinSources.AGY_VERSION).toBe("absent");
    expect(report.observed.version).toBeNull();
  });
});
