/**
 * #349 acceptance: "normal refreshes are unaffected — measure one and state
 * the margin", as #345 did with 103 entries in 89ms.
 *
 * The abort wiring adds one listener registration and one racer to a path that
 * already spawns a process and does two round trips. This measures a healthy
 * cold-path refresh end to end against the poller's real deadline so the claim
 * is a number rather than an assurance.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import {
  AgentQuotaPoller,
  createAgentQuotaSources,
} from "../packages/core/src/core/quota/quota-poller.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { AgentProfile } from "@seam/adapters";

const silent = pino({ level: "silent" }) as unknown as Logger;
const fakeGrok = fileURLToPath(new URL("./fixtures/grok/fake-acp.mjs", import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function stageHealthyGrok(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-349-margin-"));
  dirs.push(dir);
  const cliPath = path.join(dir, "grok");
  fs.writeFileSync(
    cliPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGrok)} "$@"\n`,
    { mode: 0o755 }
  );
  return cliPath;
}

describe("#349 a healthy Grok refresh is unaffected by the abort wiring", () => {
  it("finishes the cold-path round trip well inside the per-source deadline", async () => {
    const profile = { id: "grok", displayName: "Grok" } as AgentProfile;
    const [source] = createAgentQuotaSources([profile], { grokCliPath: stageHealthyGrok() });
    const poller = new AgentQuotaPoller({
      logger: silent,
      registry: new QuotaRegistry(),
      sources: [source!],
      // #344's production per-source deadline, unchanged by this fix.
      sourceTimeoutMs: 30_000,
      staleRetentionMs: 0,
    });

    const startedAt = Date.now();
    const result = await poller.refreshAll(true);
    const elapsedMs = Date.now() - startedAt;

    // It settles by FINISHING its round trips, not by hitting the deadline —
    // that distinction is the whole point. The fixture answers `initialize`
    // and refuses `_x.ai/billing`, which exercises spawn, initialize, one RPC
    // and teardown: the same machinery a real refresh runs, without inventing
    // a billing payload whose wire shape has not been observed here.
    expect(result.sources[0]?.agentId).toBe("grok");
    expect(result.sources[0]?.outcome).not.toBe("timed_out");
    expect(result.sources[0]?.error).not.toMatch(/timed out/);

    // The margin, stated. The abort wiring adds one listener and one racer; if
    // it cost anything measurable, a full cold-path round trip would not still
    // leave the 30s deadline essentially unspent.
    expect(elapsedMs).toBeLessThan(3_000);
    // eslint-disable-next-line no-console
    console.log(`[#349] grok cold-path round trip: ${elapsedMs}ms of a 30000ms deadline`);
  }, 40_000);
});
