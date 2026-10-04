// Exercise the retained pre-rollout protocol: no reconciliation advertisement.
import { register } from "tsx/esm/api";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
register({ tsconfig: path.join(root, "tsconfig.json") });
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const text = String(chunk).replace(/,"reconcileSupported":true/g, "");
  return write(text, ...args);
};
await import(path.join(root, "packages/bridge/src/adapter-child.ts"));
