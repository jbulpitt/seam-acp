/**
 * #342 — the staging migration must be a no-op when any gate fails.
 *
 * Four Macs need this and four of the five agy hosts are agy-ONLY, so a
 * half-applied run leaves a family laptop advertising nothing: outcome 4 in the
 * blast-radius ordering, which is the outcome that ordering exists to prevent.
 * `allie-laptop` has already been taken to zero agents once by an improvised
 * partial upgrade. The load-bearing property is therefore not "it migrates
 * correctly" but "a failed run changed nothing", so that is what most of this
 * file asserts.
 *
 * Everything here runs offline against synthetic trees in a tmpdir. The
 * provenance check is the REAL one from the adapter, with `process.platform`
 * forced to darwin the way `test/agy-provenance-platform.test.ts` does, because
 * the ancestor walk only runs on darwin and darwin is the whole reason this
 * migration exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyAgyManagedRuntimeArtifact } from "../packages/adapters/src/agy-native-runtime.js";
import {
  AGY_PINS,
  MANAGED_DIR_MODE,
  MANAGED_FILE_MODE,
  applyAgyStaging,
  assertAncestryIsRootOwned,
  inspectComponent,
  parseEnvFile,
  planAgyStaging,
  renderEnvFile,
} from "../scripts/stage-agy-runtime.mjs";

const realPlatform = process.platform;
const roots: string[] = [];

function forcePlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  forcePlatform(realPlatform);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    // The staged trees are deliberately read-only; make every directory
    // removable again, deepest first.
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

const BODY = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x41, 0x47, 0x59]);
const DIGEST = createHash("sha256").update(BODY).digest("hex");

/**
 * A host: a source `agy`, a pins file holding its CURRENT `$HOME` staging, and
 * a place to migrate into. `runtimeParent` is relocatable so the test never
 * touches the real `/opt/seam`.
 */
function host(overrides: Partial<Record<string, string>> = {}): {
  root: string; source: string; envFile: string; runtimeParent: string;
  pins: () => Record<string, string | null>;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seam-342-")));
  roots.push(root);
  const homeStage = path.join(root, "home", ".seam", "agy-runtime", DIGEST);
  fs.mkdirSync(homeStage, { recursive: true });
  const source = path.join(homeStage, "agy");
  fs.writeFileSync(source, BODY, { mode: 0o555 });

  const envFile = path.join(root, "bridge.env");
  const before: Record<string, string> = {
    SEAM_BRIDGE_ID: "fixture-host",
    AGY_ENABLED: "true",
    AGY_RUNTIME_ROOT: path.dirname(homeStage),
    AGY_SHA256: DIGEST,
    AGY_CLI_PATH: source,
    AGY_VERSION: "1.1.27",
    AGY_DEFAULT_MODEL: "gemini-3.1-pro-high",
    GROK_CLI_PATH: "/usr/local/bin/grok",
    ...overrides,
  };
  fs.writeFileSync(
    envFile,
    `${Object.entries(before).map(([k, v]) => `${k}=${v}`).join("\n")}\n`
  );

  const runtimeParent = path.join(root, "opt", "seam", "agy-runtime");
  return {
    root, source, envFile, runtimeParent,
    pins: () => {
      const { index } = parseEnvFile(fs.readFileSync(envFile, "utf8"));
      return Object.fromEntries(AGY_PINS.map((k) => [k, index.get(k)?.value ?? null]));
    },
  };
}

/** A plan that does not shell out to a real `agy --version`. */
function plan(fixture: ReturnType<typeof host>, extra: Record<string, unknown> = {}) {
  return planAgyStaging({
    source: fixture.source,
    envFile: fixture.envFile,
    runtimeParent: fixture.runtimeParent,
    version: "1.1.27",
    ...extra,
  });
}

/** The real provenance check, on darwin, where the ancestor walk runs. */
/** chown is the one step an unprivileged test cannot perform. */
const noChown = { chownSync: () => {} };

/**
 * The REAL provenance check, run on darwin where the ancestor walk lives.
 *
 * Used for the REFUSAL direction only. Its positive direction is not reachable
 * from a test: satisfying the walk needs every component up to `/` to be
 * non-writable, and an unprivileged process cannot make `/tmp` anything other
 * than world-writable. #332 hit the same wall. What a test CAN prove is that a
 * writable ancestor is refused and that the refusal changes nothing, which is
 * the direction that protects the four laptops.
 */
const darwinVerify = async (args: { executable: string; runtimeRoot: string; sha256: string }) => {
  forcePlatform("darwin");
  try {
    return verifyAgyManagedRuntimeArtifact(args.executable, args.runtimeRoot, args.sha256);
  } finally {
    forcePlatform(realPlatform);
  }
};

/**
 * The same real check on linux semantics, where the walk does not run, with the
 * staged tree made non-writable first. This exercises every OTHER gate for
 * real — canonical path, content-addressed layout, executable bit, digest —
 * and is the closest a rootless test gets to the success path.
 */
const stagedVerify = async (args: { executable: string; runtimeRoot: string; sha256: string }) => {
  for (const dir of [path.dirname(args.executable), args.runtimeRoot]) fs.chmodSync(dir, 0o555);
  forcePlatform("linux");
  try {
    return verifyAgyManagedRuntimeArtifact(args.executable, args.runtimeRoot, args.sha256);
  } finally {
    forcePlatform(realPlatform);
  }
};

describe("#342 what actually satisfies the runtime check", () => {
  it("distinguishes 'not writable today' from 'cannot be made writable'", () => {
    // #342's prose says root-owned mode 0555. The check in the adapter is
    // `accessSync(W_OK)`, so a SERVICE-USER-owned 0555 directory passes it too
    // — and its owner can chmod it straight back. That is the `macbook-air`
    // state, and the reason this script gates on ownership instead of mode.
    const fixture = host();
    const mine = path.join(fixture.root, "mine");
    fs.mkdirSync(mine, { mode: 0o555 });
    const entry = inspectComponent(mine);
    expect(entry.passesRuntimeCheck).toBe(true);
    expect(entry.durable).toBe(false);
    expect(entry.rootOwned).toBe(false);
  });

  it("accepts the reference layout's 0755 directories", () => {
    // The working server layout is root:root 0755 for every directory, not
    // 0555. Requiring 0555 would reject the one configuration known to work.
    expect(MANAGED_DIR_MODE).toBe(0o755);
    expect(MANAGED_FILE_MODE).toBe(0o555);
    for (const dir of ["/", "/opt"]) {
      if (!fs.existsSync(dir)) continue;
      const entry = inspectComponent(dir);
      if (entry.rootOwned) expect(entry.passesRuntimeCheck).toBe(true);
    }
  });
});

describe("#342 a failed gate leaves the host exactly as it was", () => {
  it("refuses a writable ancestor without touching the pins", () => {
    // Every Mac stages under $HOME today, so this is the state the script will
    // actually meet on first run.
    const fixture = host();
    const before = fs.readFileSync(fixture.envFile, "utf8");
    // A hand-made `/opt/seam` without sudo: owned by the service user.
    fs.mkdirSync(fixture.runtimeParent, { recursive: true, mode: 0o755 });
    const staged = plan(fixture);
    expect(staged.unsafe.map((e) => e.path)).toContain(fixture.runtimeParent);

    expect(() => assertAncestryIsRootOwned(staged)).toThrow(/must be root-owned/);
    // THE assertion: the refusal named the component and changed nothing.
    expect(fs.readFileSync(fixture.envFile, "utf8")).toBe(before);
    expect(fixture.pins().AGY_CLI_PATH).toBe(fixture.source);
    expect(fs.existsSync(path.join(fixture.runtimeParent, DIGEST))).toBe(false);
  });

  it("names every offending component, not just the first", () => {
    // The remedy is a per-directory chown; an operator should not have to
    // bisect their own filesystem to find them.
    const fixture = host();
    fs.mkdirSync(fixture.runtimeParent, { recursive: true, mode: 0o755 });
    let message = "";
    try {
      assertAncestryIsRootOwned(plan(fixture));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(fixture.runtimeParent);
    expect(message).toContain("chown root");
  });

  it("rolls back to the exact prior bytes when verification fails after the copy", async () => {
    // The load-bearing regression. A failed run must be a no-op, not a partial
    // migration — and specifically must never leave the pins naming a tree that
    // did not verify.
    const fixture = host();
    const before = fs.readFileSync(fixture.envFile, "utf8");
    const staged = plan(fixture);

    await expect(applyAgyStaging(staged, {
      io: noChown,
      verify: async () => { throw new Error("ancestor /Users/someone is writable"); },
    })).rejects.toThrow(/writable/);

    expect(fs.readFileSync(fixture.envFile, "utf8")).toBe(before);
    expect(fixture.pins().AGY_CLI_PATH).toBe(fixture.source);
    // Nothing this run created survives...
    expect(fs.existsSync(staged.executable)).toBe(false);
    expect(fs.existsSync(fixture.runtimeParent)).toBe(false);
    // ...and the existing $HOME staging is untouched, so agy still serves.
    expect(fs.existsSync(fixture.source)).toBe(true);
    expect(fs.readFileSync(fixture.source)).toEqual(BODY);
  });

  it("restores the pins when the post-restart confirmation fails", async () => {
    // The only window where the host is genuinely in a bad state: pins moved,
    // bridge not confirming. Rollback has to put the bytes back AND restart
    // again, or the run ends with a laptop serving nothing.
    const fixture = host();
    const before = fs.readFileSync(fixture.envFile, "utf8");
    const staged = plan(fixture);
    let restartedAfterRollback = 0;

    await expect(applyAgyStaging(staged, {
      io: noChown,
      verify: stagedVerify,
      // Bridge comes back without the markers — e.g. the adapter refused.
      restart: async () => ({ provenanceMode: "descriptor", agyVersion: 4, executable: "managed-artifact" }),
      restartAfterRollback: async () => { restartedAfterRollback++; },
    })).rejects.toThrow(/did not confirm/);

    expect(fs.readFileSync(fixture.envFile, "utf8")).toBe(before);
    expect(restartedAfterRollback).toBe(1);
    expect(fs.existsSync(staged.executable)).toBe(false);
  });

  it("refuses a digest that changed between reading and staging", async () => {
    // The re-verify after the copy is a different claim from the digest taken
    // from the source: one proves what we read, the other what landed.
    const fixture = host();
    const before = fs.readFileSync(fixture.envFile, "utf8");
    const staged = plan(fixture);
    let copies = 0;

    await expect(applyAgyStaging(staged, {
      verify: darwinVerify,
      io: {
        ...noChown,
        copyFileSync: (_from: string, to: string) => {
          copies++;
          fs.writeFileSync(to, Buffer.from("substituted after the digest was taken"));
        },
      },
    })).rejects.toThrow(/does not match the source/);

    expect(copies).toBe(1);
    expect(fs.readFileSync(fixture.envFile, "utf8")).toBe(before);
    expect(fs.existsSync(staged.executable)).toBe(false);
  });

  it("has not written the pins yet at the moment verification runs", async () => {
    // The ordering IS the safety property, and rollback hides it: reordering
    // the pin write before the verify leaves the same end state, so only an
    // observation made DURING the run can tell them apart. It matters because
    // rollback does not run if the machine dies in that window — pins pointing
    // at an unverified tree is the one genuinely bad state this can create.
    const fixture = host();
    const before = fs.readFileSync(fixture.envFile, "utf8");
    let pinsAtVerifyTime = "";

    await expect(applyAgyStaging(plan(fixture), {
      io: noChown,
      verify: async () => {
        pinsAtVerifyTime = fs.readFileSync(fixture.envFile, "utf8");
        throw new Error("ancestor is writable");
      },
    })).rejects.toThrow(/writable/);

    expect(pinsAtVerifyTime).toBe(before);
  });

  it("refuses a service-user-owned 0555 ancestor, which the runtime check accepts", () => {
    // The macbook-air hole, and the reason the gate is ownership rather than
    // the runtime check. 0555 owned by the service user passes
    // `accessSync(W_OK)` — the owner is simply one `chmod` away from
    // undoing it, and staging into it would advertise provenance on a tree the
    // host can swap back.
    const fixture = host();
    fs.mkdirSync(fixture.runtimeParent, { recursive: true });
    fs.chmodSync(fixture.runtimeParent, 0o555);
    try {
      const staged = plan(fixture);
      const entry = staged.ancestors.find((e) => e.path === fixture.runtimeParent)!;
      expect(entry.passesRuntimeCheck).toBe(true);  // the bridge would accept it
      expect(entry.rootOwned).toBe(false);          // but it is not durable
      expect(() => assertAncestryIsRootOwned(staged)).toThrow(/must be root-owned/);
      expect(fixture.pins().AGY_CLI_PATH).toBe(fixture.source);
    } finally {
      fs.chmodSync(fixture.runtimeParent, 0o755);
    }
  });

  it("refuses rather than guessing when there is no default model to carry", () => {
    const fixture = host({ AGY_DEFAULT_MODEL: "" });
    fs.writeFileSync(
      fixture.envFile,
      fs.readFileSync(fixture.envFile, "utf8").replace(/^AGY_DEFAULT_MODEL=.*$/m, "")
    );
    expect(() => plan(fixture)).toThrow(/pass --default-model explicitly/);
  });
});

describe("#342 a successful migration", () => {
  it("computes the digest from the file it stages and moves all five pins", async () => {
    const fixture = host();
    const staged = plan(fixture);
    expect(staged.sha256).toBe(DIGEST);
    expect(staged.runtimeRoot).toBe(fixture.runtimeParent);
    expect(staged.releaseDir).toBe(path.join(fixture.runtimeParent, DIGEST));

    // Real verification, minus the root-ownership step a test cannot perform.
    await applyAgyStaging(staged, { verify: stagedVerify, io: noChown });

    const after = fixture.pins();
    expect(after.AGY_RUNTIME_ROOT).toBe(staged.runtimeRoot);
    expect(after.AGY_SHA256).toBe(DIGEST);
    expect(after.AGY_CLI_PATH).toBe(staged.executable);
    expect(after.AGY_VERSION).toBe("1.1.27");
    expect(after.AGY_DEFAULT_MODEL).toBe("gemini-3.1-pro-high");

    // The staged binary is the same bytes, and the real check accepted it.
    expect(fs.readFileSync(staged.executable)).toEqual(BODY);
    expect(fs.statSync(staged.executable).mode & 0o777).toBe(MANAGED_FILE_MODE);
  });

  it("edits only the agy pins and leaves the rest of the file alone", () => {
    const text = "SEAM_BRIDGE_ID=x\nAGY_SHA256=old\nGROK_CLI_PATH=/g\n";
    const out = renderEnvFile(text, { AGY_SHA256: "new", AGY_VERSION: "1.2.3" });
    expect(out).toContain("SEAM_BRIDGE_ID=x");
    expect(out).toContain("GROK_CLI_PATH=/g");
    expect(out).toContain("AGY_SHA256=new");
    expect(out).toContain("AGY_VERSION=1.2.3");
    expect(out).not.toContain("AGY_SHA256=old");
  });
});

describe("#342 there is no way to force it", () => {
  it("exposes no bypass, force or skip-verification flag", async () => {
    // Raised and rejected in #332: a host advertising provenance-verified agy
    // while enforcement is off is a FALSE CLAIM, which ranks below refusing.
    // Asserted structurally because the pressure to add one arrives exactly
    // when four laptops are down and somebody wants them back.
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "scripts", "stage-agy-runtime.mjs"),
      "utf8"
    );
    for (const flag of ["--force", "--bypass", "--skip-verify", "--no-verify", "--insecure"]) {
      expect(source).not.toContain(`"${flag}"`);
    }
    // And the default is a dry run: applying is the thing that needs saying.
    expect(source).toMatch(/const opts = \{ apply: false \}/);
  });
});
