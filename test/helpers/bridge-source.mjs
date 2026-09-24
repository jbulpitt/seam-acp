// Runs the real packages/bridge/src/index.ts from source with the repo's
// tsconfig path mapping, so a test drives the production entrypoint (#618).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
register({ tsconfig: path.join(root, "tsconfig.json") });
await import(path.join(root, "packages/bridge/src/index.ts"));
