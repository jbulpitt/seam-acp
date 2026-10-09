import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import { SelfCanaryRunner, formatCanaryResult, publishCanaryCard, type CanaryRunResult, type SelfCanaryInventory } from "../packages/core/src/core/canary.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(bridges: SelfCanaryInventory["bridges"] = [
  { host: "one", ready: true, agents: [
    { id: "first", installed: true, ready: true },
    { id: "second", installed: true, ready: true },
  ] },
  { host: "two", ready: true, agents: [
    { id: "first", installed: true, ready: true },
    { id: "second", installed: true, ready: true },
  ] },
], expectedHosts: string[] = []) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-canary-"));
  directories.push(dataDir);
  const dispatched: string[] = [];
  const runner = new SelfCanaryRunner({
    dataDir,
    inventory: () => ({ bridges, expectedHosts }),
    createThread: async (host, agent) => `${host}-${agent}`,
    threadExists: async () => true,
    nonce: () => "proof640",
    dispatchTurn: async thread => {
      dispatched.push(thread);
      return { output: "proof640", deliveredOutput: "proof640", toolSeen: true, statusCardDone: true };
    },
  });
  return { runner, dataDir, dispatched };
}

describe("production deploy canary", () => {
  it("spends only one real turn per connected host, while manual runs retain the matrix", async () => {
    const { runner, dispatched } = await fixture();
    // This is the new deploy-only invocation; main ignores its second argument.
    const run = runner.run.bind(runner) as (target: "self", options: { onePerHost: boolean }) => Promise<CanaryRunResult>;
    const deployed = await run("self", { onePerHost: true });
    expect(dispatched).toEqual(["one-first", "two-first"]);
    expect(deployed.rows.filter(row => row.status === "passed")).toHaveLength(2);
    dispatched.length = 0;
    await runner.run("self");
    expect(dispatched).toHaveLength(4);
  });

  it("names a registered host missing from the reconnect inventory as unverified", async () => {
    const { runner } = await fixture(undefined, ["one", "two", "missing"]);
    const result = await runner.run("self");
    expect(result.rows).toContainEqual(expect.objectContaining({
      host: "missing", status: "failed", cause: expect.stringContaining("unverified"),
    }));
    expect(formatCanaryResult(result)).toContain("RED");
  });

  it("reports the real preparation failure instead of calling an installed agent disabled", async () => {
    const { runner } = await fixture([{ host: "one", ready: true, agents: [
      { id: "first", installed: true, ready: false, reason: "prepare: provider CLI authentication failed" },
    ] }]);
    const result = await runner.run("self");
    expect(result.rows).toEqual([expect.objectContaining({
      agent: "first", status: "failed", cause: "prepare: provider CLI authentication failed",
    })]);
  });

  it("prints the result card's returned jump link", async () => {
    const { runner, dataDir } = await fixture();
    const result = await publishCanaryCard({
      result: await runner.run("self"), dataDir, channelId: "ops", logger: pino({ level: "silent" }),
      adapter: { sendLayout: async channel => ({ channel, id: "card", jumpUrl: "https://discord.com/channels/guild/ops/card" }) },
    });
    expect(formatCanaryResult(result)).toContain("https://discord.com/channels/guild/ops/card");
  });

  it("does not print GREEN when the result card failed to publish", async () => {
    const { runner, dataDir } = await fixture();
    const result = await publishCanaryCard({
      result: await runner.run("self"), dataDir, channelId: "ops", logger: pino({ level: "silent" }),
      adapter: { sendLayout: async () => { throw new Error("Discord 503: upstream unavailable"); } },
    });
    expect(formatCanaryResult(result)).toContain("RED");
    expect(formatCanaryResult(result)).toContain("Discord 503: upstream unavailable");
  });

  it("redeploy invokes verification instead of returning after writing a sentinel", async () => {
    const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.redeploy).toContain("redeploy-cli");
  });
});
