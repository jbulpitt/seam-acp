#!/usr/bin/env node
// Sanitized R7 fixture: two OS processes delay the same atomic rename so the
// test proves the store's cross-process ownership rather than its module queue.
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const [file, sessionId] = process.argv.slice(2);
if (!file || !sessionId) process.exit(2);

const rename = fs.rename.bind(fs);
fs.rename = async (...args) => {
  await delay(150);
  return rename(...args);
};

// This fixture exercises independent OS-process ownership of the store. It is
// intentionally source-backed: package build output is not part of that
// contract, and requiring it made a fresh-worktree setup error look like a
// timing failure (#547). The parent supplies the repository's `tsx` loader.
const { AgySessionStore } = await import(
  "../../packages/adapters/src/agy-session-store.ts"
);
const store = new AgySessionStore(file);
await store.put(sessionId, {
  maxStepIndex: -1,
  cwd: "/sanitized/workspace",
  modelId: "fixture-native-model",
});
