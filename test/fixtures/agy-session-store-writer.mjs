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

const { AgySessionStore } = await import(
  "../../packages/adapters/dist/agy-session-store.js"
);
const store = new AgySessionStore(file);
await store.put(sessionId, {
  maxStepIndex: -1,
  cwd: "/sanitized/workspace",
  modelId: "fixture-native-model",
});
