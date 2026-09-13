/**
 * #390 — three sources of truth on a pm2 host, and nothing compared them.
 *
 *   file  `~/.seam/bridge/ecosystem.config.cjs` — what an operator edits.
 *         `pm2 restart` does NOT re-read it; only `delete` + `start <file>`.
 *   dump  `~/.pm2/dump.pm2` — what a REBOOT restores. `pm2 save` writes it from
 *         the running list, so it can lag the file or drop apps entirely.
 *   live  the running process environment — what is serving turns right now.
 *
 * macbook-air had pins in `live` only, with the file missing them and the dump
 * stale since Aug 30. It worked, reported `provenance mode: immutable-path`,
 * and no file on the host explained how. One reboot from silently losing agy on
 * an agy-only laptop.
 *
 * The dump fixtures are the shape observed on macbook-pro, macbook-air and
 * home-hub on 2026-09-13: a JSON **array** of app objects, each with `name` and
 * `env`. That matters — #395 happened because a fixture's file shape came from
 * documentation instead of from a host, so this one was read off a host first.
 *
 * The load-bearing distinction is three-valued. A source that could not be READ
 * is neither "agrees" nor "disagrees"; folding unreadable into absent would make
 * the check cry wolf, and folding it into consistent would make it useless.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGY_DEPLOYMENT_PINS,
  compareAgyPinSources,
  exitCodeFor,
  parsePm2DumpPins,
  readOnlyIo,
  verifyAgyDeployment,
} from "../scripts/verify-agy-deployment.mjs";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

const BODY = Buffer.from("#!/bin/sh\nexit 0\n");
const DIGEST = createHash("sha256").update(BODY).digest("hex");

function pins(overrides: Record<string, string | null> = {}): Record<string, string> {
  const base: Record<string, string> = {
    AGY_RUNTIME_ROOT: "/opt/seam/agy-runtime",
    AGY_SHA256: DIGEST,
    AGY_CLI_PATH: `/opt/seam/agy-runtime/${DIGEST}/agy`,
    AGY_VERSION: "1.1.27",
    AGY_DEFAULT_MODEL: "gemini-3.8-flash-high",
    AGY_ENABLED: "true",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete base[k]; else base[k] = v;
  }
  return base;
}

/** The dump shape as it is actually written on this fleet: a bare array. */
function dumpText(apps: Array<{ name: string; env: Record<string, string> }>): string {
  return JSON.stringify(apps.map((a) => ({
    name: a.name,
    args: ["connect", "--server", "wss://example.invalid/bridge"],
    env: { HOME: "/Users/fixture", PATH: "/usr/bin", ...a.env },
  })), null, 2);
}

interface Host { root: string; pinsFile: string; dumpFile: string; runtimeParent: string }

function host(opts: {
  file?: Record<string, string>;
  dump?: Array<{ name: string; env: Record<string, string> }> | "absent" | "malformed";
} = {}): Host {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seam-390-")));
  roots.push(root);
  const runtimeParent = path.join(root, "opt", "seam", "agy-runtime");
  const release = path.join(runtimeParent, DIGEST);
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, "agy"), BODY);
  fs.chmodSync(path.join(release, "agy"), 0o555);

  const filePins = opts.file ?? pins({
    AGY_RUNTIME_ROOT: runtimeParent,
    AGY_CLI_PATH: path.join(release, "agy"),
  });
  const pinsFile = path.join(root, "ecosystem.config.cjs");
  fs.writeFileSync(pinsFile, [
    "module.exports = {",
    "  apps: [",
    "    {",
    `      name: "seam-bridge",`,
    "      env: {",
    ...Object.entries(filePins).map(([k, v]) => `        ${k}: "${v}",`),
    "      },",
    "    },",
    "  ],",
    "};",
    "",
  ].join("\n"));

  const dumpFile = path.join(root, "dump.pm2");
  if (opts.dump === "malformed") fs.writeFileSync(dumpFile, "{not json");
  else if (opts.dump !== "absent") {
    fs.writeFileSync(dumpFile, dumpText(opts.dump ?? [{ name: "seam-bridge", env: filePins }]));
  }
  return { root, pinsFile, dumpFile, runtimeParent };
}

/**
 * A root-owned tree is the one thing an unprivileged test cannot create, so
 * `statSync` reports uid 0 — the same concession the other suites make. Without
 * it every fixture fails `ancestors-durable` on the real /tmp and the verdict
 * is `fail`, which would hide the drift distinction this file exists to test.
 */
function rootOwnedIo(): ReturnType<typeof readOnlyIo> {
  const base = readOnlyIo();
  return Object.freeze({
    ...base,
    statSync: (p: string) => ({ uid: 0, mode: base.statSync(p).mode }),
  }) as ReturnType<typeof readOnlyIo>;
}

function verify(h: Host, extra: Record<string, unknown> = {}) {
  return verifyAgyDeployment({
    envFile: h.pinsFile,
    runtimeParent: h.runtimeParent,
    pm2Dump: h.dumpFile,
    platform: "darwin",
    ...extra,
  }, rootOwnedIo());
}

const byId = (r: { checks: Array<{ id: string }> }, id: string) => r.checks.find((c) => c.id === id)!;

describe("#390 the comparison itself", () => {
  it("needs two sources before it can say anything", () => {
    const only = compareAgyPinSources({ file: pins(), dump: null, live: null });
    expect(only.status).toBe("unknown");
    expect(only.compared).toEqual(["file"]);
    expect(only.unavailable).toEqual(["dump", "live"]);
  });

  it("reports agreement across all three", () => {
    const p = pins();
    expect(compareAgyPinSources({ file: p, dump: p, live: p })).toMatchObject({
      status: "consistent", differences: [], compared: ["file", "dump", "live"],
    });
  });

  it("reports a pin the dump is missing, which is the reboot hazard", () => {
    const result = compareAgyPinSources({
      file: pins(), dump: pins({ AGY_SHA256: null }), live: pins(),
    });
    expect(result.status).toBe("drifted");
    expect(result.differences).toEqual([
      { key: "AGY_SHA256", kind: "missing", in: ["dump"], from: ["file", "live"] },
    ]);
  });

  it("reports a pin only the live process has, which is macbook-air", () => {
    const result = compareAgyPinSources({
      file: pins({ AGY_SHA256: null }), dump: pins({ AGY_SHA256: null }), live: pins(),
    });
    expect(result.status).toBe("drifted");
    expect(result.differences[0]).toMatchObject({
      key: "AGY_SHA256", kind: "missing", in: ["file", "dump"], from: ["live"],
    });
  });

  it("reports a value that differs rather than only a key that is missing", () => {
    const result = compareAgyPinSources({
      file: pins({ AGY_VERSION: "1.1.28" }), dump: pins(), live: null,
    });
    expect(result.differences).toEqual([
      { key: "AGY_VERSION", kind: "value", sources: { file: "1.1.28", dump: "1.1.27" } },
    ]);
  });

  it("does not treat a pin absent from every source as a difference", () => {
    // A host that never set AGY_DEFAULT_MODEL anywhere is not drifting; it is
    // missing a pin, which `pins-in-file` already reports.
    const result = compareAgyPinSources({
      file: pins({ AGY_DEFAULT_MODEL: null }),
      dump: pins({ AGY_DEFAULT_MODEL: null }),
      live: null,
    });
    expect(result.status).toBe("consistent");
  });
});

describe("#390 unreadable is not absent", () => {
  it("skips rather than drifting when the dump does not exist", () => {
    const check = byId(verify(host({ dump: "absent" })), "pm2-state-consistent");
    expect(check.status).toBe("skipped");
    expect(check.reasonCode).toBe("sources_unavailable");
    expect(check.detail).toContain("cannot read");
  });

  it("skips rather than drifting when the dump is not parseable", () => {
    const check = byId(verify(host({ dump: "malformed" })), "pm2-state-consistent");
    expect(check.status).toBe("skipped");
    expect(check.detail).toContain("not a pm2 dump");
  });

  it("names which sources it did not compare, so a pass is not over-read", () => {
    const check = byId(verify(host()), "pm2-state-consistent");
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("file, dump");
    expect(check.detail).toContain("Not compared: live");
  });
});

describe("#390 the drift verdict and what it tells an operator", () => {
  it("reports drift, not failure, when the host is serving correctly but will not survive", () => {
    const h = host({ dump: [{ name: "seam-bridge", env: pins({ AGY_SHA256: null }) }] });
    const report = verify(h);
    expect(report.verdict).toBe("drift");
    expect(exitCodeFor(report.verdict)).toBe(4);
    // The artifact is fine. Calling this "fail" would send an operator to
    // re-stage a runtime that is not the problem.
    for (const id of ["artifact-present", "artifact-digest", "artifact-mode"]) {
      expect(byId(report, id).status).toBe("pass");
    }
  });

  it("names the consequence and the exact command, not generic advice", () => {
    const h = host({ dump: [{ name: "seam-bridge", env: pins({ AGY_SHA256: null }) }] });
    const detail = byId(verify(h), "pm2-state-consistent").detail;
    expect(detail).toContain("a reboot restores from ~/.pm2/dump.pm2");
    expect(detail).toContain("pm2 restart` does not re-read");
    expect(detail).toContain("pm2 delete seam-bridge");
    expect(detail).toContain("pm2 save");
  });

  it("says the app is absent from the dump entirely, which is failure 4 in the issue", () => {
    // `pm2 save` writes whatever is running, so a save at the wrong moment
    // REMOVES an app from what resurrects.
    const h = host({ dump: [{ name: "chisel-tunnel", env: {} }] });
    const detail = byId(verify(h), "pm2-state-consistent").detail;
    expect(detail).toContain('has no app named "seam-bridge"');
    expect(detail).toContain("a reboot would not start it");
  });

  it("picks the dump app the ecosystem file names, not just the one with pins", () => {
    // Found by mutation: with one pinned app in the dump, matching by name and
    // "take the only app with AGY pins" are indistinguishable. They differ the
    // moment a second app carries AGY_* — a stale second bridge, or an agy
    // sidecar — and then guessing reports the wrong host's configuration.
    const h = host({
      dump: [
        { name: "some-other-agent", env: pins({ AGY_VERSION: "9.9.9", AGY_SHA256: "f".repeat(64) }) },
        { name: "seam-bridge", env: pins() },
      ],
    });
    const check = byId(verify(h), "pm2-state-consistent");
    // seam-bridge's dump entry agrees with the file on version and digest, so
    // the only differences are the fixture-root paths — never 9.9.9.
    expect(check.detail).not.toContain("9.9.9");
    expect(check.detail).not.toContain("apps carrying AGY pins");
  });

  it("lets a real failure outrank drift, because the remediations differ", () => {
    const h = host({ dump: [{ name: "seam-bridge", env: pins({ AGY_SHA256: null }) }] });
    fs.chmodSync(path.join(h.runtimeParent, DIGEST, "agy"), 0o755);
    const report = verify(h);
    expect(byId(report, "pm2-state-consistent").status).toBe("drift");
    expect(byId(report, "artifact-mode").status).toBe("fail");
    expect(report.verdict).toBe("fail");
    expect(exitCodeFor(report.verdict)).toBe(1);
  });

  it("compares the live environment when one is supplied", () => {
    const h = host();
    const report = verify(h, { processEnv: pins({ AGY_VERSION: "1.2.0" }) });
    expect(report.verdict).toBe("drift");
    const detail = byId(report, "pm2-state-consistent").detail;
    expect(detail).toContain("AGY_VERSION differs");
    expect(detail).toContain("live=1.2.0");
    expect(report.observed.pinSourcesCompared).toEqual(["file", "dump", "live"]);
  });
});

describe("#390 the dump parser, against the shape the fleet writes", () => {
  it("reads a bare array of apps", () => {
    const parsed = parsePm2DumpPins(dumpText([{ name: "seam-bridge", env: pins() }]));
    expect(parsed.malformed).toBe(false);
    expect(parsed.apps).toHaveLength(1);
    expect(parsed.apps[0].name).toBe("seam-bridge");
    expect([...parsed.apps[0].pins.keys()].sort()).toEqual([...AGY_DEPLOYMENT_PINS].sort());
  });

  it("also reads the { apps: [...] } form some pm2 versions write", () => {
    const wrapped = JSON.stringify({ apps: [{ name: "seam-bridge", env: pins() }] });
    expect(parsePm2DumpPins(wrapped).apps[0].pins.get("AGY_VERSION")).toBe("1.1.27");
  });

  it("reports malformed input rather than throwing or returning empty", () => {
    // Empty and malformed must not be the same answer: one means "no pins",
    // the other means "I could not tell".
    expect(parsePm2DumpPins("{not json").malformed).toBe(true);
    expect(parsePm2DumpPins('"a string"').malformed).toBe(true);
    expect(parsePm2DumpPins("[]")).toMatchObject({ malformed: false, apps: [] });
  });

  it("skips an app with no env rather than counting it as pinless", () => {
    const parsed = parsePm2DumpPins(JSON.stringify([{ name: "no-env" }, { name: "ok", env: pins() }]));
    expect(parsed.apps.map((a) => a.name)).toEqual(["ok"]);
  });

  it("coerces a non-string env value instead of comparing object identity", () => {
    // pm2 writes whatever was passed; `AGY_ENABLED: true` as a boolean would
    // otherwise never equal the file's "true".
    const parsed = parsePm2DumpPins(JSON.stringify([{ name: "a", env: { AGY_ENABLED: true } }]));
    expect(parsed.apps[0].pins.get("AGY_ENABLED")).toBe("true");
  });
});
