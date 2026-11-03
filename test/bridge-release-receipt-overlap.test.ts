import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createReleaseReceiptWriter, readRunningReleaseSha } from "../packages/bridge/src/release-receipt.js";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const sourceSha = "a".repeat(40);
const original = { readdir: fs.readdir, rename: fs.rename, writeFile: fs.writeFile };
const roots: string[] = [];
let root: string;
let releaseRoot: string;
let serial = 0;
let helper: {
  validateRelease(release: string, sha: string, checksum: string, stageId: string): Promise<{ treeDigest: string }>;
  treeDigest(release: string, options: { exclude: Set<string> }): Promise<string>;
  mutableReleaseFiles: Set<string>;
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-overlap-"));
  roots.push(root);
  releaseRoot = path.join(root, "rollouts");
  const source = await fs.readFile(path.resolve("scripts/bridge-rollout-remote.mjs"), "utf8");
  const dispatcher = '\ntry {\n  if (mode === "preflight") await preflight();';
  expect(source.split(dispatcher)).toHaveLength(2);
  const adapter = path.join(root, "validator.mjs");
  // Keep every helper body unchanged; omit only its CLI action dispatcher.
  await fs.writeFile(adapter, source.slice(0, source.indexOf(dispatcher)) +
    "\nexport { validateRelease, treeDigest, mutableReleaseFiles };\n", { flag: "wx" });
  const argv = process.argv;
  const checkout = path.join(root, "checkout");
  try {
    process.argv = [argv[0], adapter, "fixture", "fixture-app", "fixture", String(process.getuid!()),
      checkout, path.join(checkout, "packages/bridge/dist/index.js"), process.execPath,
      path.join(root, "unused-pm2"), "-", releaseRoot, "pm2", "-", "source-test"];
    helper = await import(/* @vite-ignore */ pathToFileURL(adapter).href);
  } finally { process.argv = argv; }
});

afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  vi.restoreAllMocks();
  for (const directory of roots) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const checksum = (++serial).toString(16).padStart(64, "0");
  const release = path.join(releaseRoot, "releases", `${sourceSha}-${checksum}`);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "receipt-fixture", type: "module" }),
    "package-lock.json": JSON.stringify({ packages: {} }),
    "packages/adapters/package.json": JSON.stringify({ name: "@seam/adapters", dependencies: {} }),
    "packages/bridge/package.json": JSON.stringify({ name: "@seam/bridge", dependencies: {} }),
    "packages/core/package.json": JSON.stringify({ name: "@seam/core" }),
    "packages/adapters/dist/index.js": "export {};\n",
    "packages/bridge/dist/index.js": "export {};\n",
  };
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(release, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: "wx" });
  }
  await fs.mkdir(path.join(release, "node_modules"));
  await fs.writeFile(path.join(release, "bridge-release.json"), JSON.stringify({ formatVersion: 2, sourceSha,
    files: Object.entries(files).map(([name, bytes]) => ({ path: name, size: Buffer.byteLength(bytes), sha256: hash(bytes) })) }));
  const receipt = path.join(release, "release-receipt.json");
  const activation = path.join(release, "activation-envelope.json");
  const stage = { formatVersion: 2, bridgeId: "fixture", sourceSha, artifactChecksum: checksum,
    verificationAgent: "fixture", stageId: "c".repeat(64), treeDigest: "0".repeat(64), stagedAt: new Date().toISOString() };
  const envelope = { formatVersion: 2, activationId: "d".repeat(64), bridgeId: "fixture", sourceSha,
    artifactChecksum: checksum, verificationAgent: "fixture", stageId: stage.stageId,
    oldPid: process.pid === 41 ? 42 : 41, startedAt: new Date(Date.now() - 1_000).toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  await fs.writeFile(receipt, JSON.stringify(stage));
  await fs.writeFile(activation, JSON.stringify(envelope));
  stage.treeDigest = await helper.treeDigest(release, { exclude: helper.mutableReleaseFiles });
  await fs.writeFile(receipt, JSON.stringify(stage));
  const makeWriter = (destination = receipt) => createReleaseReceiptWriter({ bridgeId: "fixture",
    instanceId: "fixture-instance", protocolVersion: 1, adapterRefusals: [],
    activationEnvelopePath: activation, receiptPath: destination });
  const writer = await makeWriter();
  expect(writer).not.toBeNull();
  return { release, checksum, receipt, activation, stage, envelope, writer: writer!, makeWriter };
}

function holdRenames(destinations: string[]) {
  const ready = destinations.map(() => deferred());
  const release = deferred();
  const temporary = new Map<string, string>();
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    const index = destinations.indexOf(String(to));
    if (index >= 0) {
      temporary.set(String(to), String(from));
      expect((await fs.lstat(from)).isFile()).toBe(true);
      ready[index].resolve();
      await release.promise;
    }
    return original.rename(from, to);
  });
  return { ready, release, temporary };
}

describe.sequential("receipt publication alongside immutable releases", () => {
  it("keeps completed stage/ready schema, canonical readers and immutable bytes", async () => {
    const f = await fixture();
    expect(await readRunningReleaseSha(f.receipt)).toBe(sourceSha);
    expect((await helper.validateRelease(f.release, sourceSha, f.checksum, f.stage.stageId)).treeDigest).toBe(f.stage.treeDigest);
    await f.writer.recordHelloAccepted();
    await f.writer.recordCatalogRpc("describeModelCatalog", "fixture");
    await f.writer.recordCatalogRpc("fetchModelCatalog", "fixture");
    const ack = { activationId: f.envelope.activationId, bridgeId: "fixture", instanceId: "fixture-instance",
      pid: process.pid, sourceSha, artifactChecksum: f.checksum };
    await f.writer.recordControllerVerification(ack);
    const saved = JSON.parse(await fs.readFile(f.receipt, "utf8"));
    expect(saved).toMatchObject({ ...f.stage, ...f.envelope, pid: process.pid,
      instanceId: "fixture-instance", protocolVersion: 1, controllerAck: ack, adapterRefusals: [] });
    expect(saved.helloAcceptedAt).toBeTruthy();
    expect(saved.catalogRpcs.fixture.describeModelCatalogAt).toBeTruthy();
    expect(saved.catalogRpcs.fixture.fetchModelCatalogAt).toBeTruthy();
    expect(saved.completedAt).toBe(saved.controllerVerifiedAt);
    await fs.rm(f.activation);
    expect(await readRunningReleaseSha(f.receipt)).toBe(sourceSha);
    expect((await helper.validateRelease(f.release, sourceSha, f.checksum, f.stage.stageId)).treeDigest).toBe(f.stage.treeDigest);
  });

  for (const boundary of ["before-layout", "after-layout", "after-top"] as const) {
    it(`validates during an actual receipt write ${boundary}`, async () => {
      const f = await fixture();
      const gate = holdRenames([f.receipt]);
      const rootNames = (await original.readdir(f.release)).sort();
      let writing: Promise<void> | undefined;
      let rootDirentCalls = 0;
      const visited: string[] = [];
      function start() {
        expect(writing).toBeUndefined();
        writing = f.writer.recordCatalogRpc("describeModelCatalog", "fixture");
        void writing.catch(gate.ready[0].reject);
        return gate.ready[0].promise;
      }
      vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
        const entries = await Reflect.apply(original.readdir, fs, args);
        if (String(args[0]) === f.release) {
          const options = args[1] as { withFileTypes?: boolean } | undefined;
          const phase = options?.withFileTypes ? (++rootDirentCalls === 1 ? "layout" : "digest") : "top";
          visited.push(phase);
          if ((boundary === "after-layout" && phase === "layout") ||
              (boundary === "after-top" && phase === "top")) await start();
        }
        return entries;
      }) as typeof fs.readdir);
      try {
        if (boundary === "before-layout") await start();
        await expect(helper.validateRelease(f.release, sourceSha, f.checksum, f.stage.stageId))
          .resolves.toMatchObject({ treeDigest: f.stage.treeDigest });
        expect(visited).toEqual(["layout", "top", "digest"]);
        expect(writing).toBeDefined();
        const temporary = gate.temporary.get(f.receipt)!;
        expect(path.dirname(temporary)).toBe(path.dirname(f.release));
        expect((await original.readdir(f.release)).sort()).toEqual(rootNames);
        expect(JSON.parse(await fs.readFile(f.receipt, "utf8"))).toEqual(f.stage);
      } finally {
        gate.release.resolve();
        if (writing) await writing;
      }
      expect(JSON.parse(await fs.readFile(f.receipt, "utf8"))).toMatchObject({ pid: process.pid,
        catalogRpcs: { fixture: { describeModelCatalogAt: expect.any(String) } } });
      expect(await helper.treeDigest(f.release, { exclude: helper.mutableReleaseFiles })).toBe(f.stage.treeDigest);
      expect((await original.readdir(f.release)).sort()).toEqual(rootNames);
    });
  }

  it("publishes two release namespaces concurrently under the same PID", async () => {
    const a = await fixture(); const b = await fixture();
    const gate = holdRenames([a.receipt, b.receipt]);
    const writes = [a, b].map((f, index) => {
      const writing = f.writer.recordHelloAccepted();
      void writing.catch(gate.ready[index].reject);
      return writing;
    });
    try {
      await Promise.all(gate.ready.map(r => r.promise));
      const temporaries = [...gate.temporary.values()];
      expect(new Set(temporaries).size).toBe(2);
      for (const file of temporaries) expect((await fs.lstat(file)).isFile()).toBe(true);
      for (const f of [a, b]) await helper.validateRelease(f.release, sourceSha, f.checksum, f.stage.stageId);
    } finally { gate.release.resolve(); await Promise.all(writes); }
    for (const f of [a, b]) expect(JSON.parse(await fs.readFile(f.receipt, "utf8")).pid).toBe(process.pid);
  });

  it("preserves a relative custom destination and distinct receipt names", async () => {
    const f = await fixture();
    const names = ["custom-ready.json", "other-ready.json"];
    const destinations = names.map(name => path.relative(process.cwd(), path.join(f.release, name)));
    for (const destination of destinations) await fs.writeFile(destination, JSON.stringify(f.stage));
    const writers = await Promise.all(destinations.map(destination => f.makeWriter(destination)));
    const gate = holdRenames(destinations);
    const writes = writers.map((writer, index) => {
      expect(writer).not.toBeNull();
      const writing = writer!.recordHelloAccepted();
      void writing.catch(gate.ready[index].reject);
      return writing;
    });
    try {
      await Promise.all(gate.ready.map(r => r.promise));
      expect(new Set(gate.temporary.values()).size).toBe(2);
      for (const destination of destinations) expect(JSON.parse(await fs.readFile(destination, "utf8"))).toEqual(f.stage);
    } finally { gate.release.resolve(); await Promise.all(writes); }
    for (const destination of destinations) {
      expect(await readRunningReleaseSha(destination)).toBe(sourceSha);
      expect(JSON.parse(await fs.readFile(destination, "utf8"))).toMatchObject({ pid: process.pid, instanceId: "fixture-instance" });
    }
    expect(JSON.parse(await fs.readFile(f.receipt, "utf8"))).toEqual(f.stage);
  });

  it("passes through the original real wx collision without overwriting either receipt", async () => {
    const f = await fixture(); const second = await f.makeWriter();
    expect(second).not.toBeNull();
    const gate = holdRenames([f.receipt]);
    const first = f.writer.recordHelloAccepted();
    void first.catch(gate.ready[0].reject);
    let nativeError: unknown;
    vi.spyOn(fs, "writeFile").mockImplementation((async (...args: Parameters<typeof fs.writeFile>) => {
      try { return await Reflect.apply(original.writeFile, fs, args); }
      catch (error) { nativeError = error; throw error; }
    }) as typeof fs.writeFile);
    try {
      await gate.ready[0].promise;
      const error = await second!.recordCatalogRpc("fetchModelCatalog", "fixture").then(
        () => { throw new Error("Expected actual wx collision"); }, error => error);
      expect(error).toBe(nativeError);
      expect(error).toHaveProperty("code", "EEXIST");
      expect(JSON.parse(await fs.readFile(f.receipt, "utf8"))).toEqual(f.stage);
    } finally { gate.release.resolve(); await first; }
    expect(JSON.parse(await fs.readFile(f.receipt, "utf8")).catalogRpcs).toEqual({});
  });

  it("passes through a real rename error without replacing it or writing in place", async () => {
    const f = await fixture();
    await fs.rm(f.receipt); await fs.mkdir(f.receipt);
    let nativeError: unknown;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      try { return await original.rename(from, to); }
      catch (error) { nativeError = error; throw error; }
    });
    const error = await f.writer.recordHelloAccepted().then(
      () => { throw new Error("Expected actual file-over-directory rename failure"); }, error => error);
    expect(error).toBe(nativeError);
    expect(error).toHaveProperty("syscall", "rename");
    expect((await fs.lstat(f.receipt)).isDirectory()).toBe(true);
  });
});
