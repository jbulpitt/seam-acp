import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";

function spec(id: string): DispatchSpec {
  return { id, target: "thread-a", prompt: id, session: "live", kind: "handoff",
    correlationId: id, createdUtc: "2026-09-24T12:00:00.000Z" };
}

const binding = {
  version: 1 as const,
  location: "remote-one",
  slot: 1790250000000,
  submissionId: "submission-1",
  acpSessionId: "acp-1",
  delegatedUtc: "2026-09-24T12:00:00.000Z",
};

const dirs: string[] = [];
const stores: SessionStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function delegated() {
  const dir = await mkdtemp(path.join(tmpdir(), "seam-631-"));
  dirs.push(dir);
  const store = new SessionStore(path.join(dir, "t.db"));
  stores.push(store);
  const attempts = store.turnAttempts;
  attempts.admit(spec("turn"));
  const claimed = attempts.claim(spec("turn"), "identity", "boot-1");
  attempts.bind(claimed, "acp-1");
  expect(attempts.recordRemoteRecovery(claimed, binding)).toBe(true);
  attempts.startPrompt(claimed);
  return { attempts, claimed };
}

describe("remote recovery release", () => {
  it("releases only the exact bridge-proven pre-write owner", async () => {
    const { attempts, claimed } = await delegated();
    expect(attempts.releaseRemoteRecovery(claimed, { ...binding, submissionId: "different" })).toBe(false);
    expect(attempts.releaseRemoteRecovery(claimed, binding)).toBe(true);
    expect(attempts.get("turn")?.remoteRecovery).toBeUndefined();
  });

  it("hands a suspended turn whose bridge owner is gone back to ordinary continuation (#631)", async () => {
    const { attempts, claimed } = await delegated();
    attempts.suspend(claimed.id, "boot-1");
    const suspended = attempts.get("turn")!;
    expect(attempts.releaseLostRemoteRecovery(suspended, { ...binding, slot: 1 })).toBe(false);
    expect(attempts.releaseLostRemoteRecovery(suspended, binding)).toBe(true);
    expect(attempts.get("turn")).toMatchObject({ state: "suspended", promptStarted: true, acpSessionId: "acp-1" });
    expect(attempts.get("turn")?.remoteRecovery).toBeUndefined();
  });
});
