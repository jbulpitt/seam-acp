#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("agy catalog fixture 1.0\n");
} else {
  fs.appendFileSync(process.env.FAKE_AGY_CATALOG_LOG, `${JSON.stringify(args)}\n`);
  if (args.length !== 1 || args[0] !== "models") {
    process.stderr.write("catalog fixture accepts only prompt-free models\n");
    process.exitCode = 2;
  } else {
    const state = JSON.parse(fs.readFileSync(process.env.FAKE_AGY_CATALOG_STATE, "utf8"));
    if (state.fail) {
      process.stderr.write("synthetic models failure\n");
      process.exitCode = 7;
    } else {
      process.stdout.write(state.rows.map(([id, name]) => `${id}\t${name}\n`).join(""));
    }
  }
}
