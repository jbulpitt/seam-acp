import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { makeMux } from "../../packages/adapters/src/mux.ts";

class Bridge extends EventEmitter {
  readyState = 1;
  send(raw) {
    const command = JSON.parse(raw);
    assert.equal(command.action, "replayOutput");
    setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({
      type: "cmd_reply", cmdId: command.cmdId, error: "replayOutput: slot does not exist",
    }))));
  }
  ping() {}
}

const bridge = new Bridge();
const mux = makeMux({ id: "retained-host" });
mux.attach(bridge);
const child = mux.adopt(42, { allowAppTraffic: true });
const errors = [];
if (process.argv[2] === "owned") child.on("error", error => errors.push(error.message));
else assert.equal(child.listenerCount("error"), 0);
await new Promise(resolve => setTimeout(resolve, 100));
assert.equal(mux.isBound(42), true);
child.detach();
console.log(JSON.stringify({ survived: true, errors }));
