import { describe, expect, it } from "vitest";
import pino from "pino";
import { TurnActivityRegistry, type TurnActivityEvent } from "../packages/core/src/plugins/turn-activity-registry.js";

const logger = pino({ level: "silent" });
const binding = { agentId: "grok-work", location: "remote", account: "work", sessionId: "thread-session" };
const fact = (type: TurnActivityEvent["type"], turnId = "turn-1"): TurnActivityEvent => ({ type, turnId, timestampMs: 1, binding });

describe("turn-activity observations", () => {
  it("does not wait for observers, keeps per-agent order and freezes its own snapshot", async () => {
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const registry = new TurnActivityRegistry(logger);
    registry.register("quota", [
      { event: "turn-started", handle: async event => {
        events.push(event.type);
        expect(Object.isFrozen(event)).toBe(true); expect(Object.isFrozen(event.binding)).toBe(true);
        expect(event.binding.account).toBe("work");
        await blocked;
      } },
      { event: "turn-completed", handle: async event => { events.push(event.type); } },
    ], { logger, config: undefined });
    const input = fact("turn-started");
    expect(registry.emit(input)).toBeUndefined();
    input.binding = { ...binding, account: "changed" };
    registry.emit(fact("turn-completed"));
    await Promise.resolve(); expect(events).toEqual(["turn-started"]);
    release(); await registry.drain();
    expect(events).toEqual(["turn-started", "turn-completed"]);
  });

  it("a throwing observer cannot lose a sibling's fact or stall another agent", async () => {
    const registry = new TurnActivityRegistry(logger); const events: string[] = [];
    registry.register("broken", [{ event: "turn-completed", handle: () => { throw new Error("broken observer"); } }], { logger, config: undefined });
    registry.register("healthy", [{ event: "turn-completed", handle: event => { events.push(event.turnId); } }], { logger, config: undefined });
    registry.emit(fact("turn-completed"));
    registry.emit({ ...fact("turn-completed", "turn-2"), binding: { ...binding, agentId: "codex" } });
    await registry.drain(); expect(events.sort()).toEqual(["turn-1", "turn-2"]);
    registry.remove("healthy"); registry.emit(fact("turn-completed", "turn-3"));
    await registry.drain(); expect(events).toHaveLength(2);
  });
});
