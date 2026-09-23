import { SessiondClient } from "../../packages/bridge/src/sessiond-client.js";
import { SupervisedSlots } from "../../packages/bridge/src/supervised-slots.js";

const [socketPath, adapterChildPath, phase, rawCursor, armRecovery] = process.argv.slice(2);
if (!socketPath || !adapterChildPath || !phase) throw new Error("missing fixture arguments");

function report(value: Record<string, unknown>): void {
  process.send?.(value);
}

const client = await SessiondClient.connect(socketPath);
let completed = false;
const slots = new SupervisedSlots({
  client,
  copilotCmd: "/unused/copilot",
  localCwd: process.cwd(),
  adapterChildPath,
  onStderr: () => undefined,
  onFrame: (frame) => {
    if (phase === "first" && frame.type === "data" && frame.data === "before\n") {
      report({ type: "first", seq: frame.seq, data: frame.data });
      client.close();
      setImmediate(() => process.exit(0));
    }
    if (phase === "second" && frame.type === "data" && frame.data === "after\n" && !completed) {
      completed = true;
      report({ type: "live", seq: frame.seq, data: frame.data });
      void slots.kill(frame.slot).finally(() => {
        client.close();
        setImmediate(() => process.exit(0));
      });
    }
  },
});

if (phase === "first") {
  await slots.rebind();
  slots.configure(7, { agentId: "fixture" });
  if (armRecovery === "arm") {
    const armed = await slots.armRecovery(7, {
      submissionId: "submission-574",
      acpSessionId: "session-574",
      continuation: "continue",
    });
    report({ type: "armed", armed });
  }
  await slots.writeInput(7, "begin\n");
} else {
  const listed = await slots.rebind();
  const accepted = await slots.writeInput(7, "must-not-reach-child\n");
  const replay = await slots.replay(7, Number(rawCursor));
  report({
    type: "rebound",
    alive: listed.health.find((entry) => entry.slot === 7)?.alive,
    accepted,
    frames: replay.result.frames,
    gap: replay.result.gap,
  });
  replay.activate();
  if (phase === "dead") {
    client.close();
    setImmediate(() => process.exit(0));
  }
}
