import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  artifactName,
  buildArtifact,
  makeScpCommand,
  makeSshCommand,
  parseArgs,
  resolveTarget,
  rollbackPlan,
  runPreflight,
  validateReadyReceipt,
  validateTargetMap,
  verifyChecksum,
  waitForNewPid,
} from "../scripts/lib/bridge-rollout.mjs";

const root = path.resolve(import.meta.dirname, "..");
const configured = JSON.parse(fs.readFileSync(path.join(root, "ops/bridge/targets.json"), "utf8"));
const targets = validateTargetMap(configured);

describe("bridge rollout target safety (#241)", () => {
  it("uses the operator-owned bridge to SSH/PM2 mapping", () => {
    expect(resolveTarget(targets, "media-server")).toMatchObject({ sshAlias: "media-server", pm2App: "remote-agent-bridge" });
    expect(resolveTarget(targets, "macbook-air")).toMatchObject({ sshAlias: "macbook-air", pm2App: "seam-bridge" });
  });

  it("keeps AGY-only hosts mapped but outside this rollout", () => {
    expect(configured.targets["jennifer-laptop"].sshAlias).toBe("macbook-air-j");
    expect(() => resolveTarget(targets, "jennifer-laptop")).toThrow(/AGY-only/);
  });

  it("rejects unknown targets, app overrides, and shell metacharacters", () => {
    expect(() => resolveTarget(targets, "unknown-host")).toThrow(/unknown bridge target/);
    expect(() => parseArgs(["--target", "media-server", "--app", "anything"])).toThrow(/unknown option/);
    expect(() => resolveTarget(targets, "media-server;touch-pwned")).toThrow(/unsafe/);
    expect(() => validateTargetMap({ schemaVersion: 1, targets: { ok: { sshAlias: "host;id", pm2App: "app", verifyAgent: "grok", rolloutEnabled: true } } })).toThrow(/unsafe SSH alias/);
    expect(() => validateTargetMap({ schemaVersion: 1, targets: { ok: { sshAlias: "host", pm2App: "app$(id)", verifyAgent: "grok", rolloutEnabled: true } } })).toThrow(/unsafe PM2 app/);
  });

  it("constructs SSH and SCP argv without a local shell", () => {
    const target = resolveTarget(targets, "media-server");
    const ssh = makeSshCommand(target, ["preflight", target.pm2App, target.bridgeId, target.verifyAgent], "fixed-script");
    expect(ssh).toEqual({
      file: "ssh",
      args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "media-server", "sh", "-s", "--", "preflight", "remote-agent-bridge", "media-server", "grok"],
      input: "fixed-script",
      mutates: false,
    });
    const name = artifactName("a".repeat(40), "b".repeat(64));
    expect(makeScpCommand(target, "/tmp/release.tgz", name).args).toEqual(["-q", "--", "/tmp/release.tgz", `media-server:.seam/bridge-rollouts/incoming/${name}`]);
  });
});

describe("bridge rollout gating and verification (#241)", () => {
  it("defaults to a one-host dry run and rejects implicit mutation", () => {
    expect(parseArgs(["--target", "media-server"])).toMatchObject({ action: "preflight", apply: false });
    expect(parseArgs(["--target", "media-server", "--stage", "--apply"])).toMatchObject({ action: "stage", apply: true });
    expect(() => parseArgs(["--target", "media-server", "--stage"])).toThrow(/requires --apply/);
    expect(() => parseArgs(["--target", "media-server", "--apply"])).toThrow(/requires --stage/);
    expect(() => parseArgs([])).toThrow(/exactly one host/);
  });

  it("a dry-run preflight executes no mutating fake commands", async () => {
    const target = resolveTarget(targets, "macbook-air");
    const fake = vi.fn(async (command: { mutates: boolean }) => {
      expect(command.mutates).toBe(false);
      return { stdout: "reachable=yes\npm2_app=seam-bridge\npid=123\n", stderr: "" };
    });
    const result = await runPreflight(target, "fixed-script", fake);
    expect(result.report).toMatchObject({ reachable: "yes", pm2_app: "seam-bridge", pid: "123" });
    expect(fake).toHaveBeenCalledOnce();
  });

  it("refuses a checksum mismatch", () => {
    expect(verifyChecksum("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(() => verifyChecksum("a".repeat(64), "b".repeat(64))).toThrow(/checksum mismatch/);
  });

  it("refuses to build from a dirty or uncommitted source tree", async () => {
    const fake = vi.fn(async () => ({ stdout: "?? local-investigation.txt\n", stderr: "" }));
    await expect(buildArtifact("/unused", fake)).rejects.toThrow(/worktree is dirty/);
    expect(fake).toHaveBeenCalledOnce();
  });

  it("polls past the old PID and accepts only a new one", async () => {
    const reads = [41, 41, 0, 57];
    let now = 0;
    const pid = await waitForNewPid(async () => reads.shift() ?? 57, {
      oldPid: 41,
      timeoutMs: 10,
      intervalMs: 1,
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
    });
    expect(pid).toBe(57);
  });

  it("bounds new-PID polling", async () => {
    let now = 0;
    await expect(waitForNewPid(async () => 41, {
      oldPid: 41,
      timeoutMs: 2,
      intervalMs: 1,
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
    })).rejects.toThrow(/timed out/);
  });

  it("requires a fresh hello and both successful catalog RPCs", () => {
    const expected = { sha: "a".repeat(40), checksum: "b".repeat(64), pid: 57, protocolVersion: 1, agentId: "grok" };
    const good = {
      sourceSha: expected.sha,
      artifactChecksum: expected.checksum,
      pid: 57,
      protocolVersion: 1,
      helloAcceptedAt: "2026-09-08T00:00:00.000Z",
      controllerVerifiedAt: "2026-09-08T00:00:03.000Z",
      catalogRpcs: { grok: { describeModelCatalogAt: "2026-09-08T00:00:01.000Z", fetchModelCatalogAt: "2026-09-08T00:00:02.000Z" } },
    };
    expect(validateReadyReceipt(good, expected)).toBe(true);
    expect(() => validateReadyReceipt({ ...good, helloAcceptedAt: undefined }, expected)).toThrow(/handshake/);
    expect(() => validateReadyReceipt({ ...good, catalogRpcs: { grok: { describeModelCatalogAt: "now" } } }, expected)).toThrow(/catalog RPC/);
  });

  it("generates an explicit non-automatic rollback plan", () => {
    expect(rollbackPlan(resolveTarget(targets, "media-server"))).toEqual({
      target: "media-server",
      command: "npm run bridge:rollout -- --target media-server --rollback --apply",
      automatic: false,
    });
  });

  it("contains no immediate PM2 restart fallback or secret-bearing PM2 query", () => {
    const source = ["scripts/bridge-rollout-remote.sh", "scripts/bridge-rollout.mjs", "scripts/lib/bridge-rollout.mjs"]
      .map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
    expect(source).not.toMatch(/pm2\s+(?:restart|reload|jlist|prettylist|env)\b/i);
    expect(source).toContain("kill -USR2");
  });
});
