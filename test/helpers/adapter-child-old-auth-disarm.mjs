// Retained pre-rollout children reject disarm even after terminal auth failure.
import { register } from "tsx/esm/api";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
register({ tsconfig: path.join(root, "tsconfig.json") });
const emit = process.stdin.emit.bind(process.stdin);
let buffered = "";
process.stdin.emit = (event, ...args) => {
  if (event !== "data") return emit(event, ...args);
  buffered += args[0].toString();
  let newline;
  while ((newline = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const frame = JSON.parse(line);
    if (frame.type === "disarm_recovery") {
      process.stdout.write(JSON.stringify({ v: 1, type: "control_result", requestId: frame.requestId,
        ok: true, result: { disarmed: false } }) + "\n");
    } else emit("data", Buffer.from(line + "\n"));
  }
  return true;
};
await import(path.join(root, "packages/bridge/src/adapter-child.ts"));
