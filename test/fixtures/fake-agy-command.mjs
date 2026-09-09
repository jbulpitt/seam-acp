#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const command = process.argv.at(-1);
const signalLog = process.env.FAKE_AGY_SIGNAL_LOG;
const writeLog = (line) => {
  if (signalLog) appendFileSync(signalLog, `${line}\n`);
};

if (command === "--version") {
  process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? "agy-test 1.0"}\n`);
  process.exitCode = 0;
} else if (command !== "models") {
  process.exitCode = 2;
} else {
  writeLog(`PID ${process.pid}`);

  if (process.env.FAKE_AGY_MODE === "ignore-sigterm") {
    process.on("SIGTERM", () => writeLog("SIGTERM-IGNORED"));
    writeLog("READY");
    setInterval(() => {}, 1 << 30);
  } else {
    process.stdout.write(process.env.FAKE_AGY_MODELS ?? "model-a Model A\n");
    process.exitCode = 0;
  }
}
