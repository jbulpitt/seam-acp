// Runs the real packages/bridge/src/slot-holder.ts from source for tests.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
import { ownTestHolder } from "./test-slot-holders.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
ownTestHolder();
register({ tsconfig: path.join(root, "tsconfig.json") });
await import(path.join(root, "packages/bridge/src/slot-holder.ts"));
