/**
 * #281 — legacy-to-managed baseline enrollment.
 *
 * Every remote bridge is an unmanaged checkout, and ACTIVATE correctly refuses
 * from that state because it cannot prove a version-bound rollback. Enrollment
 * is the missing entrance: it records, from live state, everything a restore
 * would need, and preserves the one artifact the rollout mechanism would later
 * replace — so the baseline is a target that can actually be put back, not a
 * stamp that satisfies a check.
 *
 * These run the real remote program against a temporary filesystem with a real
 * live process and a fake PM2 module, exactly as the activation suite does. No
 * remote host is contacted, and nothing here signals or restarts a bridge.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commandRunner, parseKeyValues, renderRemoteScript } from "../scripts/lib/bridge-rollout.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const H = (v: string) => v.repeat(64);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fixtures: Fixture[] = [];
type Fixture = Awaited<ReturnType<typeof makeFixture>>;

/** A bridge entrypoint that survives SIGUSR2 the way the real one drains. */
const BRIDGE_SOURCE = (capable: boolean) =>
  `process.on('SIGUSR2',()=>{});setInterval(()=>{},1000);\n` +
  `// deployed bridge fixture ${capable ? "with" : "without"} catalog RPCs\n`;
const COMMAND_BUS_SOURCE = (capable: boolean) =>
  `export const PROTOCOL_VERSION = 1;\n` +
  (capable ? `const methods = ["describeModelCatalog", "fetchModelCatalog"];\n` : `const methods = [];\n`);
const RPC_SOURCE = `export function isAllowedRpcMethod(){return true}\nexport function dispatchAdapter(){}\n`;

/**
 * A legacy, unmanaged checkout: a real process running an entrypoint that is a
 * plain file in the checkout, with git metadata as its only revision evidence.
 */
async function makeFixture(options: { capable?: boolean; withGit?: boolean } = {}) {
  const capable = options.capable ?? false;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-enroll-"));
  const checkout = path.join(root, "checkout");
  const releaseRoot = path.join(root, "rollouts");
  const entry = path.join(checkout, "packages/bridge/dist/index.js");
  const pidFile = path.join(root, "bridge.pid");
  const pm2File = path.join(root, "pm2.json");
  const pm2Module = path.join(root, "pm2.cjs");
  const runtime = path.join(root, "runtime");
  const node = path.join(runtime, "node");
  const checkoutSha = "c".repeat(39) + "7";

  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.mkdir(path.join(checkout, "packages/adapters/dist"), { recursive: true });
  await fs.mkdir(runtime);
  await fs.link(process.execPath, node);
  await fs.writeFile(path.join(runtime, "npm"), "#!/bin/sh\necho 10.9.0\n", { mode: 0o755 });
  await fs.writeFile(entry, BRIDGE_SOURCE(capable));
  await fs.writeFile(path.join(checkout, "packages/bridge/package.json"), JSON.stringify({ name: "@seam/bridge", version: "0.1.0" }));
  await fs.writeFile(path.join(checkout, "packages/adapters/dist/command-bus.js"), COMMAND_BUS_SOURCE(capable));
  await fs.writeFile(path.join(checkout, "packages/bridge/dist/rpc.js"), RPC_SOURCE);
  // Files the entrypoint's graph reaches that are NOT among the four recorded
  // capability files — the gap the whole-tree baseline exists to close.
  await fs.writeFile(path.join(checkout, "packages/bridge/dist/inventory.js"), "export const inventory = [];\n");
  await fs.writeFile(path.join(checkout, "packages/bridge/dist/release-receipt.js"), "export function receipt(){}\n");
  // `ws` is a symlink OUT of every declared scope, the way a workspace or
  // store-backed install links. The bridge dynamically imports it, so its bytes
  // are runtime content no matter where they live.
  await fs.mkdir(path.join(root, "external-ws"), { recursive: true });
  await fs.writeFile(path.join(root, "external-ws/index.js"), "module.exports = {};\n");
  await fs.mkdir(path.join(checkout, "node_modules"), { recursive: true });
  await fs.symlink(path.join(root, "external-ws"), path.join(checkout, "node_modules/ws"));
  // A `.bin` shim pointing at the stable entrypoint: real checkouts have these,
  // and following it would make the digest depend on activation state.
  await fs.mkdir(path.join(checkout, "node_modules/.bin"), { recursive: true });
  await fs.symlink(entry, path.join(checkout, "node_modules/.bin/seam-bridge"));
  await fs.writeFile(path.join(checkout, "package.json"), JSON.stringify({ name: "seam-acp", version: "0.1.0" }));
  if (options.withGit ?? true) {
    await fs.mkdir(path.join(checkout, ".git"));
    await fs.writeFile(path.join(checkout, ".git/HEAD"), `${checkoutSha}\n`);
  }
  await fs.writeFile(
    pm2Module,
    `const fs=require('fs'),p=${JSON.stringify(pm2File)};module.exports={connect(cb){setImmediate(()=>cb(null))},describe(_n,cb){const j=JSON.parse(fs.readFileSync(p,'utf8'));setImmediate(()=>cb(null,[{pid:j.pid,pm2_env:{name:j.name,pm_cwd:j.cwd,pm_exec_path:j.entry,exec_interpreter:j.node,args:['connect','--server','wss://controller.invalid','--token','fixture-token','--id','fixture']}}]))},disconnect(){}}`
  );
  const child = spawn(node, [entry], { cwd: checkout, detached: true, stdio: "ignore" });
  child.unref();
  await fs.writeFile(pidFile, String(child.pid));
  await fs.writeFile(pm2File, JSON.stringify({ pid: child.pid, name: "fixture-app", cwd: checkout, entry, node }));

  const shell = await renderRemoteScript(path.join(repo, "scripts/bridge-rollout-remote.sh"), path.join(repo, "scripts/bridge-rollout-remote.mjs"));
  const base = ["fixture", "fixture-app", "grok", String(process.getuid!()), checkout, entry, pidFile, node, pm2Module, "-", "no", releaseRoot];
  const run = (action: string[], timeoutMs = 30_000) =>
    commandRunner({ file: "/bin/sh", args: ["-s", "--", node, ...base, ...action], input: shell, timeoutMs });

  const value = { root, checkout, releaseRoot, entry, pidFile, pm2File, run, pid: child.pid!, checkoutSha, capable };
  fixtures.push(value);
  return value;
}

/** Mirror the bounds in scripts/bridge-rollout-remote.mjs. */
const MAX_BASELINE_ENTRIES = 120_000;
const MAX_BASELINE_BYTES = 1024 * 1024 * 1024;

const baselineDir = (f: Fixture) => path.join(f.releaseRoot, "baselines");
const enroll = async (f: Fixture, id = H("1"), operation = H("2"), timeoutMs?: number) =>
  f.run(["enroll", id, operation], timeoutMs);

/**
 * Create many filesystem entries without serializing 120k awaits. The ceiling
 * tests need real inodes — the point is that the traversal charges them — so
 * this bounds wall time rather than the entry count.
 */
async function createMany(count: number, make: (index: number) => Promise<unknown>): Promise<void> {
  const batch = 512;
  for (let start = 0; start < count; start += batch) {
    await Promise.all(Array.from({ length: Math.min(batch, count - start) }, (_, offset) => make(start + offset)));
  }
}

afterEach(async () => {
  while (fixtures.length) {
    const fixture = fixtures.pop()!;
    try { process.kill(fixture.pid, "SIGKILL"); } catch {}
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

describe.sequential("#281 legacy baseline enrollment", () => {
  it("records a restorable baseline without signalling or changing the artifact", async () => {
    const f = await makeFixture();
    const before = await fs.readFile(f.entry);
    const result = await enroll(f);
    const report = parseKeyValues(result.stdout);

    expect(report.enrollment).toBe("recorded");
    expect(report.enrollment_id).toBe(H("1"));
    expect(report.baseline_source_sha).toBe(f.checkoutSha);
    expect(report.baseline_entrypoint_sha256).toBe(sha256(before));
    // media-server's shape: managed now, but honestly still not receipt-capable.
    expect(report.baseline_receipt_capable).toBe("no");
    expect(report.process_signaled).toBe("no");
    expect(report.artifact_changed).toBe("no");
    expect(report.live_pid).toBe(String(f.pid));

    // Nothing about the running deployment moved.
    expect(await fs.readFile(f.entry)).toEqual(before);
    expect(await fs.realpath(f.entry)).toBe(f.entry);
    expect(() => process.kill(f.pid, 0)).not.toThrow();

    const record = JSON.parse(await fs.readFile(path.join(baselineDir(f), `${H("1")}.baseline.json`), "utf8"));
    // The record is what a restore needs: revision, checksums, entrypoint,
    // process-manager identity, runtime.
    expect(record.baseline.checkoutSourceSha).toBe(f.checkoutSha);
    expect(record.baseline.entrypointSha256).toBe(sha256(before));
    expect(record.baseline.files.map((file: { path: string }) => file.path)).toEqual([
      "packages/bridge/dist/index.js",
      "packages/bridge/package.json",
      "packages/adapters/dist/command-bus.js",
      "packages/bridge/dist/rpc.js",
    ]);
    expect(record.baseline.processManager).toMatchObject({ manager: "pm2", app: "fixture-app", cwd: f.checkout, execPath: f.entry });
    expect(record.baseline.runtime.platform).toBe(`${process.platform}-${process.arch}`);
    expect(record.baselineDigest).toBe(sha256(Buffer.from(JSON.stringify(record.baseline), "utf8")));
    // And the one artifact a later activation would replace is preserved byte
    // for byte, so the baseline can be put back rather than merely described.
    expect(await fs.readFile(path.join(baselineDir(f), H("1"), "entrypoint/index.js"))).toEqual(before);

    const preflight = parseKeyValues((await f.run(["preflight"])).stdout);
    expect(preflight.enrolled).toBe("yes");
    expect(preflight.baseline_digest).toBe(record.baselineDigest);
    expect(preflight.baseline_receipt_capable).toBe("no");
    expect(preflight.remote_mutation).toBe("no");
  }, 60_000);

  it("is idempotent: re-running an unchanged host mutates nothing", async () => {
    const f = await makeFixture();
    const first = parseKeyValues((await enroll(f)).stdout);
    const recordPath = path.join(baselineDir(f), `${H("1")}.baseline.json`);
    const pointerPath = path.join(baselineDir(f), "current.json");
    const preservedPath = path.join(baselineDir(f), H("1"), "entrypoint/index.js");
    const stamp = (await fs.stat(recordPath)).mtimeMs;
    const recordBytes = await fs.readFile(recordPath, "utf8");
    const pointerBytes = await fs.readFile(pointerPath, "utf8");
    const preservedBytes = await fs.readFile(preservedPath);
    const baselineEntries = (await fs.readdir(baselineDir(f))).sort();
    const entryBytes = await fs.readFile(f.entry);

    const second = parseKeyValues((await enroll(f, H("3"), H("4"))).stdout);
    expect(second.enrollment).toBe("unchanged");
    // The ORIGINAL enrollment id is reported back; a re-run does not mint a
    // second baseline that would compete with it as a restore target.
    expect(second.enrollment_id).toBe(H("1"));
    expect(second.baseline_digest).toBe(first.baseline_digest);
    expect(second.process_signaled).toBe("no");

    // What idempotent actually means here, asserted rather than assumed: every
    // durable artifact is byte-identical and no second baseline appears. A
    // rerun is NOT a no-op at the syscall level — it takes and releases the
    // target lock and re-applies 0700 to the metadata directories — so the
    // claim is about durable state, and the lock is proven released below.
    expect(await fs.readFile(recordPath, "utf8")).toBe(recordBytes);
    expect((await fs.stat(recordPath)).mtimeMs).toBe(stamp);
    expect(await fs.readFile(pointerPath, "utf8")).toBe(pointerBytes);
    expect(await fs.readFile(preservedPath)).toEqual(preservedBytes);
    expect((await fs.readdir(baselineDir(f))).sort()).toEqual(baselineEntries);
    await expect(fs.stat(path.join(f.releaseRoot, "locks/fixture"))).rejects.toThrow();
    expect(await fs.readFile(f.entry)).toEqual(entryBytes);
  }, 60_000);

  it("refuses to re-enroll a host whose deployed bytes changed since the baseline", async () => {
    const f = await makeFixture();
    await enroll(f);
    // Someone ran `git pull` in place — precisely the unsafe workaround the
    // rollback boundary exists to catch.
    await fs.writeFile(f.entry, `${BRIDGE_SOURCE(false)}// drifted\n`);

    await expect(enroll(f, H("3"), H("4"))).rejects.toThrow(/enrollment_baseline_drift/);
    // The original evidence survives the refusal.
    const record = JSON.parse(await fs.readFile(path.join(baselineDir(f), `${H("1")}.baseline.json`), "utf8"));
    expect(record.enrollmentId).toBe(H("1"));
    const preflight = parseKeyValues((await f.run(["preflight"])).stdout);
    expect(preflight.enrolled).toBe("drifted");
  }, 60_000);

  it("fails closed when the baseline cannot be captured well enough to restore", async () => {
    // No git metadata: the revision half of the baseline is unknowable, so there
    // is no honest record to write.
    const f = await makeFixture({ withGit: false });
    await expect(enroll(f)).rejects.toThrow(/checkout_source_identity_unavailable/);
    await expect(fs.stat(path.join(baselineDir(f), "current.json"))).rejects.toThrow();
    await expect(fs.stat(path.join(baselineDir(f), `${H("1")}.baseline.json`))).rejects.toThrow();

    // Same refusal shape when a file whose bytes decide behaviour is unreadable.
    const g = await makeFixture();
    await fs.rm(path.join(g.checkout, "packages/adapters/dist/command-bus.js"));
    await expect(enroll(g)).rejects.toThrow(/deployed_protocol_invalid/);
    await expect(fs.stat(path.join(baselineDir(g), "current.json"))).rejects.toThrow();
  }, 60_000);

  it("refuses a partially enrolled host instead of trusting the pointer alone", async () => {
    const f = await makeFixture();
    await enroll(f);
    await fs.rm(path.join(baselineDir(f), `${H("1")}.baseline.json`));

    await expect(f.run(["preflight"])).rejects.toThrow(/enrollment_record_missing/);
    await expect(enroll(f, H("3"), H("4"))).rejects.toThrow(/enrollment_record_missing/);
  }, 60_000);

  it("refuses when the preserved artifact no longer matches its record", async () => {
    const f = await makeFixture();
    await enroll(f);
    await fs.writeFile(path.join(baselineDir(f), H("1"), "entrypoint/index.js"), "tampered\n");

    await expect(f.run(["restore-baseline", H("1"), H("5")])).rejects.toThrow(/baseline_entrypoint_copy_mismatch/);
    await expect(f.run(["preflight"])).rejects.toThrow(/baseline_entrypoint_copy_mismatch/);
  }, 60_000);

  it("refuses to enroll a host that is already managed", async () => {
    const f = await makeFixture();
    const managed = path.join(f.releaseRoot, "releases", `${"a".repeat(40)}-${H("b")}`, "packages/bridge/dist/index.js");
    await fs.mkdir(path.dirname(managed), { recursive: true });
    await fs.writeFile(managed, BRIDGE_SOURCE(true));
    await fs.rm(f.entry);
    await fs.symlink(managed, f.entry);
    await expect(enroll(f)).rejects.toThrow(/enroll_requires_legacy_checkout/);
  }, 60_000);
});

describe.sequential("#281 restoring the recorded baseline", () => {
  it("puts the exact pre-enrollment artifact back and withdraws the enrollment", async () => {
    const f = await makeFixture();
    const original = await fs.readFile(f.entry);
    const originalMode = (await fs.stat(f.entry)).mode & 0o7777;
    await enroll(f);

    // Stand in for what a later activation does to the entrypoint: replace it
    // with a pointer into a managed release tree.
    const other = path.join(f.releaseRoot, "releases", `${"a".repeat(40)}-${H("b")}`, "packages/bridge/dist/index.js");
    await fs.mkdir(path.dirname(other), { recursive: true });
    await fs.writeFile(other, BRIDGE_SOURCE(true));
    await fs.rm(f.entry);
    await fs.symlink(other, f.entry);

    const restored = parseKeyValues((await f.run(["restore-baseline", H("1"), H("5")])).stdout);
    expect(restored.baseline).toBe("restored");
    expect(restored.entrypoint_sha256).toBe(sha256(original));
    expect(restored.process_signaled).toBe("no");

    // Byte-for-byte, at the same path, with the same mode, and no longer a link.
    expect(await fs.readFile(f.entry)).toEqual(original);
    expect(await fs.realpath(f.entry)).toBe(f.entry);
    expect((await fs.stat(f.entry)).mode & 0o7777).toBe(originalMode);
    expect(() => process.kill(f.pid, 0)).not.toThrow();

    // Unenrolled, but not amnesic: the immutable record stays for audit.
    const preflight = parseKeyValues((await f.run(["preflight"])).stdout);
    expect(preflight.enrolled).toBe("no");
    expect(preflight.enrollment_id).toBe("none");
    await expect(fs.stat(path.join(baselineDir(f), `${H("1")}.baseline.json`))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(baselineDir(f), `${H("1")}.restored.json`))).resolves.toBeTruthy();
  }, 60_000);

  it("refuses when a DORMANT checkout dependency drifted during managed operation", async () => {
    // The QA counterexample. The preserved entrypoint is still byte-exact, so
    // an entrypoint-only check reports success — and the next start then runs
    // that entrypoint against a drifted dependency: a combination that never
    // existed. The baseline covers the whole runtime tree precisely so this is
    // a refusal, not a "restore".
    const f = await makeFixture();
    await enroll(f);
    const managed = path.join(f.releaseRoot, "releases", `${"a".repeat(40)}-${H("b")}`, "packages/bridge/dist/index.js");
    await fs.mkdir(path.dirname(managed), { recursive: true });
    await fs.writeFile(managed, BRIDGE_SOURCE(true));
    await fs.rm(f.entry);
    await fs.symlink(managed, f.entry);
    const pointerBefore = await fs.readFile(path.join(baselineDir(f), "current.json"), "utf8");

    const dependency = path.join(f.checkout, "packages/adapters/dist/command-bus.js");
    await fs.writeFile(dependency, `${COMMAND_BUS_SOURCE(false)}// drifted while dormant\n`);

    await expect(f.run(["restore-baseline", H("1"), H("5")])).rejects.toThrow(/baseline_runtime_file_mismatch|baseline_runtime_tree_mismatch/);
    // Nothing was touched: the managed symlink and the enrollment pointer are
    // exactly as they were, so the operator can still act on a known state.
    expect(await fs.realpath(f.entry)).toBe(managed);
    expect((await fs.lstat(f.entry)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(baselineDir(f), "current.json"), "utf8")).toBe(pointerBefore);
  }, 60_000);

  it("refuses when a dormant node_modules file drifted, not just a recorded one", async () => {
    // The recorded capability files are only four; the runtime tree is what
    // makes an unlisted transitive dependency count too.
    const f = await makeFixture();
    await enroll(f);
    await fs.writeFile(path.join(f.root, "external-ws/index.js"), "// drifted transitive dependency\n");
    await expect(f.run(["restore-baseline", H("1"), H("5")])).rejects.toThrow(/baseline_runtime_tree_mismatch/);
    const preflight = parseKeyValues((await f.run(["preflight"])).stdout);
    expect(preflight.enrolled).toBe("drifted");
  }, 60_000);

  it("refuses when bytes behind an ESCAPING symlink drift during managed operation", async () => {
    // QA round 2. The link text never changes, so recording `l <path> <text>`
    // reported success while the restored entrypoint would import bytes the
    // baseline never represented — the same absent-runtime-file failure the
    // whole-tree design exists to eliminate, relocated to the scope boundary.
    const f = await makeFixture();
    await enroll(f);
    const managed = path.join(f.releaseRoot, "releases", `${"a".repeat(40)}-${H("b")}`, "packages/bridge/dist/index.js");
    await fs.mkdir(path.dirname(managed), { recursive: true });
    await fs.writeFile(managed, BRIDGE_SOURCE(true));
    await fs.rm(f.entry);
    await fs.symlink(managed, f.entry);
    const pointerBefore = await fs.readFile(path.join(baselineDir(f), "current.json"), "utf8");
    const linkTextBefore = await fs.readlink(path.join(f.checkout, "node_modules/ws"));

    await fs.writeFile(path.join(f.root, "external-ws/index.js"), "module.exports = { HOSTILE: true };\n");

    await expect(f.run(["restore-baseline", H("1"), H("5")])).rejects.toThrow(/baseline_runtime_tree_mismatch/);
    expect(await fs.readlink(path.join(f.checkout, "node_modules/ws"))).toBe(linkTextBefore);
    expect(await fs.realpath(f.entry)).toBe(managed);
    expect((await fs.lstat(f.entry)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(baselineDir(f), "current.json"), "utf8")).toBe(pointerBefore);
  }, 60_000);

  it("records escaping link targets as external roots rather than hiding them", async () => {
    const f = await makeFixture();
    await enroll(f);
    const record = JSON.parse(await fs.readFile(path.join(baselineDir(f), `${H("1")}.baseline.json`), "utf8"));
    // Inclusion is explicit: a reader can see what came from outside scope.
    expect(record.baseline.runtimeExternalRoots).toContain(await fs.realpath(path.join(f.root, "external-ws")));
    expect(record.baseline.runtimeLinkCount).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("does not let a .bin shim make the digest depend on activation state", async () => {
    // The shim resolves to the stable entrypoint, which becomes a release
    // symlink during managed operation. Following it would change the digest on
    // activation alone and make every restore refuse.
    const f = await makeFixture();
    await enroll(f);
    const managed = path.join(f.releaseRoot, "releases", `${"a".repeat(40)}-${H("b")}`, "packages/bridge/dist/index.js");
    await fs.mkdir(path.dirname(managed), { recursive: true });
    await fs.writeFile(managed, `${BRIDGE_SOURCE(true)}// a DIFFERENT release\n`);
    await fs.rm(f.entry);
    await fs.symlink(managed, f.entry);

    const restored = parseKeyValues((await f.run(["restore-baseline", H("1"), H("5")])).stdout);
    expect(restored.baseline).toBe("restored");
  }, 60_000);

  it("refuses a runtime-scope symlink that cannot be resolved at all", async () => {
    const f = await makeFixture();
    await fs.rm(path.join(f.root, "external-ws"), { recursive: true, force: true });
    await expect(enroll(f)).rejects.toThrow(/baseline_runtime_link_unresolvable/);
    await expect(fs.stat(path.join(baselineDir(f), "current.json"))).rejects.toThrow();
  }, 60_000);

  it("refuses a special file in runtime scope instead of recording a reference", async () => {
    const f = await makeFixture();
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [path.join(f.checkout, "node_modules/a-fifo")]);
    await expect(enroll(f)).rejects.toThrow(/baseline_runtime_special_file/);
    await expect(fs.stat(path.join(baselineDir(f), "current.json"))).rejects.toThrow();
  }, 60_000);

  it("terminates on a symlink cycle instead of walking forever", async () => {
    const f = await makeFixture();
    await fs.symlink(path.join(f.checkout, "node_modules"), path.join(f.checkout, "node_modules/self"));
    const report = parseKeyValues((await enroll(f)).stdout);
    expect(report.enrollment).toBe("recorded");
  }, 60_000);

  it("hashes hardlinked content rather than treating it as a reference", async () => {
    const f = await makeFixture();
    await fs.link(path.join(f.root, "external-ws/index.js"), path.join(f.checkout, "node_modules/hardlinked.js"));
    await enroll(f);
    // A hardlink is indistinguishable from a regular file, so its bytes are in
    // the digest: changing them through EITHER name is caught.
    await fs.writeFile(path.join(f.checkout, "node_modules/hardlinked.js"), "// drifted through the hardlink\n");
    await expect(f.run(["restore-baseline", H("1"), H("5")])).rejects.toThrow(/baseline_runtime_tree_mismatch/);
  }, 60_000);

  it("charges symlinks and references against the ceiling, not just regular files", async () => {
    // QA round 3. The ceiling was enforced only for regular files, so a
    // symlink-only fan-out walked past the advertised 120,000 limit: 120,001
    // links at one target cost four file charges and enrolled successfully.
    const f = await makeFixture();
    const fan = path.join(f.checkout, "node_modules/fan");
    await fs.mkdir(fan, { recursive: true });
    await createMany(MAX_BASELINE_ENTRIES + 1, (index) => fs.symlink(f.entry, path.join(fan, `l${index}`)));

    // Generous subprocess budget: this walks 120k real inodes, and the suite
    // runs alongside others. A timeout here would be a load artefact, not a
    // refusal, and the assertion below distinguishes them.
    await expect(enroll(f, H("1"), H("2"), 300_000)).rejects.toThrow(/baseline_runtime_tree_too_large/);
    // Fails closed: nothing recorded, nothing published.
    await expect(fs.stat(path.join(baselineDir(f), `${H("1")}.baseline.json`))).rejects.toThrow();
    await expect(fs.stat(path.join(baselineDir(f), "current.json"))).rejects.toThrow();
  }, 600_000);

  it("charges empty files and directories, which carry no bytes at all", async () => {
    // The byte bound cannot see zero-byte work, so the entry ceiling is what
    // bounds it. Directories nest rather than fan out, so empty files make the
    // same point with far fewer inodes.
    const f = await makeFixture();
    // This is also the wide-directory case: 120,001 entries in one directory,
    // which is what the bounded enumeration has to stop part-way through.
    const empties = path.join(f.checkout, "node_modules/empties");
    await fs.mkdir(empties, { recursive: true });
    await createMany(MAX_BASELINE_ENTRIES + 1, (index) => fs.writeFile(path.join(empties, `e${index}`), ""));

    await expect(enroll(f, H("1"), H("2"), 300_000)).rejects.toThrow(/baseline_runtime_tree_too_large/);
    // Both absences, matching the symlink ceiling test. Earlier this asserted
    // only the pointer, which made a report of "both tests assert both" wrong.
    await expect(fs.stat(path.join(baselineDir(f), `${H("1")}.baseline.json`))).rejects.toThrow();
    await expect(fs.stat(path.join(baselineDir(f), "current.json"))).rejects.toThrow();
  }, 600_000);

  it("refuses an over-limit file BEFORE opening it, not after reading it", async () => {
    // The ceiling must be reachable without materializing content. This file is
    // sparse (0 blocks on disk) and its contents are unreadable, so the two
    // orderings are distinguishable by error code alone and neither costs disk
    // nor memory: charging first refuses on size; reading first hits EACCES and
    // reports an unexpected failure instead. A real multi-GiB file would
    // discriminate the same way by exhausting memory, which is precisely what
    // must not happen in CI.
    const f = await makeFixture();
    const huge = path.join(f.checkout, "node_modules/huge.bin");
    await fs.writeFile(huge, "");
    await fs.truncate(huge, MAX_BASELINE_BYTES + 1);
    expect((await fs.stat(huge)).blocks).toBe(0);
    await fs.chmod(huge, 0o000);

    await expect(enroll(f)).rejects.toThrow(/baseline_runtime_tree_too_large/);
    await expect(fs.stat(path.join(baselineDir(f), `${H("1")}.baseline.json`))).rejects.toThrow();
    await expect(fs.stat(path.join(baselineDir(f), "current.json"))).rejects.toThrow();
  }, 60_000);

  it("records an absent declared-scope root as absent rather than ignoring it", async () => {
    // "Not built" and "missing" are the same observation to the traversal, and
    // both must be recorded: a scope root that later appears is drift.
    const f = await makeFixture();
    await fs.rm(path.join(f.checkout, "package-lock.json"), { force: true });
    const report = parseKeyValues((await enroll(f)).stdout);
    expect(report.enrollment).toBe("recorded");

    await fs.writeFile(path.join(f.checkout, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
    await expect(f.run(["restore-baseline", H("1"), H("5")])).rejects.toThrow(/baseline_runtime_tree_mismatch/);
  }, 60_000);

  it("refuses when the recorded checkout revision moved", async () => {
    const f = await makeFixture();
    await enroll(f);
    await fs.writeFile(path.join(f.checkout, ".git/HEAD"), `${"d".repeat(39)}9\n`);
    await expect(f.run(["restore-baseline", H("1"), H("5")])).rejects.toThrow(/baseline_source_sha_mismatch/);
    await expect(fs.stat(path.join(baselineDir(f), "current.json"))).resolves.toBeTruthy();
  }, 60_000);

  it("refuses a restore that does not name the exact recorded enrollment", async () => {
    const f = await makeFixture();
    await enroll(f);
    await expect(f.run(["restore-baseline", H("9"), H("5")])).rejects.toThrow(/enrollment_id_mismatch/);
    await expect(fs.stat(path.join(baselineDir(f), "current.json"))).resolves.toBeTruthy();
  }, 60_000);

  it("refuses a restore on a host with no recorded baseline", async () => {
    const f = await makeFixture();
    await expect(f.run(["restore-baseline", H("1"), H("5")])).rejects.toThrow(/managed_directory_missing|enrollment_not_recorded/);
  }, 60_000);
});

describe.sequential("#281 activation stays refused for every legacy host", () => {
  it("keeps the original refusal when nothing has been enrolled", async () => {
    const f = await makeFixture();
    await f.run(["prepare-upload", H("f")]);
    await expect(
      f.run(["activate", "a".repeat(40), H("b"), H("c"), H("d"), "10", H("e")])
    ).rejects.toThrow(/legacy_previous_release_not_receipt_capable/);
  }, 60_000);

  it("names the real situation once a baseline exists, and still refuses", async () => {
    const f = await makeFixture();
    await enroll(f);
    // Enrollment is not permission: a rollback onto bytes that cannot emit the
    // two-RPC receipt still cannot be proven, so activation refuses.
    await expect(
      f.run(["activate", "a".repeat(40), H("b"), H("c"), H("d"), "10", H("e")])
    ).rejects.toThrow(/enrolled_baseline_not_receipt_capable/);

    const drifted = await makeFixture();
    await enroll(drifted);
    await fs.writeFile(drifted.entry, `${BRIDGE_SOURCE(false)}// drifted\n`);
    await expect(
      drifted.run(["activate", "a".repeat(40), H("b"), H("c"), H("d"), "10", H("e")])
    ).rejects.toThrow(/enrolled_baseline_state_drift/);
  }, 60_000);

  it("refuses even a receipt-capable baseline until activation-from-baseline is reviewed", async () => {
    const f = await makeFixture({ capable: true });
    const report = parseKeyValues((await enroll(f)).stdout);
    expect(report.baseline_receipt_capable).toBe("yes");
    await expect(
      f.run(["activate", "a".repeat(40), H("b"), H("c"), H("d"), "10", H("e")])
    ).rejects.toThrow(/enrolled_baseline_activation_not_enabled/);
  }, 60_000);
});
