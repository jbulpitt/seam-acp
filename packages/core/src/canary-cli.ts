#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
import { StagingCanaryRunner, formatCanaryResult, type CanaryTarget } from "./core/canary.js";
import { TestDriverClient } from "./core/test-driver.js";
import { TesterBot } from "./core/tester-bot.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function targetArg(argv: string[]): CanaryTarget {
  const inline = argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);
  const index = argv.indexOf("--target");
  const value = inline ?? (index >= 0 ? argv[index + 1] : undefined);
  if (value !== "staging") {
    throw new Error("usage: npm run canary -- --target staging [--durability]");
  }
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = targetArg(argv);
  const stagingChannelId = required("SEAM_CANARY_STAGING_CHANNEL_ID");
  const channels = new Set(
    required("SEAM_TEST_BOT_CHANNEL_IDS").split(",").map((value) => value.trim()).filter(Boolean),
  );
  if (!channels.has(stagingChannelId)) {
    throw new Error("SEAM_CANARY_STAGING_CHANNEL_ID must also be in SEAM_TEST_BOT_CHANNEL_IDS");
  }
  const runner = new StagingCanaryRunner({
    testerBot: new TesterBot(required("SEAM_TEST_BOT_TOKEN"), channels),
    testDriver: new TestDriverClient(
      required("SEAM_TEST_DRIVER_URL"),
      required("SEAM_TEST_DRIVER_KEY"),
    ),
    dataDir: path.resolve(process.env.DATA_DIR?.trim() || "data"),
    stagingChannelId,
  });
  const result = await runner.run(target, { durability: argv.includes("--durability") });
  console.log(formatCanaryResult(result));
  if (result.rows.some((row) => row.status === "failed")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
