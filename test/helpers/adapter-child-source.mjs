// Runs the real packages/bridge/src/adapter-child.ts from source, with the
// repo tsconfig's path mapping, so a test drives the production wrapper
// instead of a stand-in script (#610).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
register({ tsconfig: path.join(root, "tsconfig.json") });
await import(path.join(root, "packages/bridge/src/adapter-child.ts"));
