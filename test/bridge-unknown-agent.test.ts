/**
 * #468 — an `agentId` the bridge does not hold silently spawned copilot.
 *
 * `resolveSlotAdapter` returned `undefined` for an unknown id and `spawnAgent`
 * fell through to the copilot legacy branch. The requested agent never ran,
 * nothing failed, and copilot did the work — blast radius 5, silently wrong,
 * across a licensing boundary that dispatch-time pinning enforces correctly.
 *
 * The assertions that matter most here are negative ones: what must NOT come
 * back. A test that only checks the happy path is exactly what let this live.
 */
import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "@seam/adapters";
import {
  resolveSlotAdapter,
  unknownAgentMessage,
  UnknownAgentError,
  type AdapterResolution,
} from "../packages/bridge/src/resolve-adapter.js";

const fake = (id: string) => ({ id }) as unknown as AgentAdapter;

/** The real bridge inventory, per `packages/bridge/src/inventory.ts`. */
const FLEET = new Map<string, AgentAdapter>([
  ["copilot", fake("copilot")],
  ["claude", fake("claude")],
  ["agy", fake("agy")],
  ["codex", fake("codex")],
  ["grok", fake("grok")],
]);

const cfg = (agentId?: string) => (agentId ? ({ agentId } as never) : undefined);
const adapterOf = (r: AdapterResolution) => (r.kind === "adapter" ? r.adapter.id : undefined);

describe("#468 an agent this bridge cannot serve is refused, not substituted", () => {
  it.each(["ollama-cloud", "claude-vertex", "zai"])(
    "refuses %s — in core, never in the bridge inventory",
    (agentId) => {
      const r = resolveSlotAdapter(FLEET, cfg(agentId));
      expect(r.kind).toBe("unknown");
    }
  );

  it("NEVER resolves an unknown id to copilot", () => {
    // The whole bug. Copilot is licensed to FHR, and this path could route
    // arbitrary work onto it without anyone choosing that.
    const r = resolveSlotAdapter(FLEET, cfg("ollama-cloud"));
    expect(adapterOf(r)).not.toBe("copilot");
    expect(r.kind).not.toBe("legacy"); // `legacy` IS the copilot path
  });

  it("refuses a typo rather than quietly running something else", () => {
    expect(resolveSlotAdapter(FLEET, cfg("claude-")).kind).toBe("unknown");
    expect(resolveSlotAdapter(FLEET, cfg("Claude")).kind).toBe("unknown");
  });

  it("names what was asked for and what the host actually holds", () => {
    const r = resolveSlotAdapter(FLEET, cfg("ollama-cloud"));
    if (r.kind !== "unknown") throw new Error("expected a refusal");
    expect(r.agentId).toBe("ollama-cloud");
    // Sorted, so an operator reading two hosts' refusals can compare them.
    expect(r.available).toEqual(["agy", "claude", "codex", "copilot", "grok"]);
  });
});

describe("#468 a lone adapter may not answer for an id it is not", () => {
  const onlyCopilot = new Map<string, AgentAdapter>([["copilot", fake("copilot")]]);
  const onlyAgy = new Map<string, AgentAdapter>([["agy", fake("agy")]]);

  it("does not hand back the single adapter when a DIFFERENT id was stated", () => {
    // `adapters.size === 1` used to win for any id at all, so a one-adapter
    // host answered every request with whatever it happened to have.
    expect(resolveSlotAdapter(onlyAgy, cfg("claude")).kind).toBe("unknown");
  });

  it("does not turn a request for claude into copilot on a copilot-only host", () => {
    const r = resolveSlotAdapter(onlyCopilot, cfg("claude"));
    expect(r.kind).toBe("unknown");
    expect(adapterOf(r)).not.toBe("copilot");
  });

  it("still serves the single adapter when NO id is stated", () => {
    // The convenience is preserved where it is genuinely unambiguous, and an
    // old seam-acp that sends no agentId has to keep working.
    expect(adapterOf(resolveSlotAdapter(onlyAgy, undefined))).toBe("agy");
    expect(adapterOf(resolveSlotAdapter(onlyAgy, cfg(undefined)))).toBe("agy");
  });

  it("serves the single adapter when the stated id matches it", () => {
    expect(adapterOf(resolveSlotAdapter(onlyAgy, cfg("agy")))).toBe("agy");
  });
});

describe("#468 everything that worked before still works", () => {
  it.each(["claude", "agy", "codex", "grok"])("resolves %s to its own adapter", (id) => {
    expect(adapterOf(resolveSlotAdapter(FLEET, cfg(id)))).toBe(id);
  });

  it("resolves an explicit copilot id to the copilot adapter", () => {
    // The caller then routes it to the legacy inline path, as it always has.
    expect(adapterOf(resolveSlotAdapter(FLEET, cfg("copilot")))).toBe("copilot");
  });

  it("falls back to the legacy path when no id is stated and several exist", () => {
    expect(resolveSlotAdapter(FLEET, undefined).kind).toBe("legacy");
  });

  it("falls back to the legacy path on a host holding no adapters at all", () => {
    expect(resolveSlotAdapter(new Map(), undefined).kind).toBe("legacy");
  });

  it("refuses a stated id on a host holding no adapters, rather than guessing", () => {
    const r = resolveSlotAdapter(new Map(), cfg("claude"));
    expect(r.kind).toBe("unknown");
    if (r.kind !== "unknown") throw new Error("unreachable");
    expect(r.available).toEqual([]);
  });
});

describe("#468 the refusal an operator reads", () => {
  it("states the agent, the inventory, and that nothing was substituted", () => {
    const msg = unknownAgentMessage("ollama-cloud", ["agy", "claude"]);
    expect(msg).toContain('"ollama-cloud"');
    expect(msg).toContain("agy, claude");
    expect(msg).toMatch(/refusing/i);
  });

  it("says 'none' rather than an empty gap when the host holds nothing", () => {
    expect(unknownAgentMessage("claude", [])).toContain("none");
  });

  it("carries the id and inventory on the error, not only in prose", () => {
    const err = new UnknownAgentError("zai", ["claude", "codex"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UnknownAgentError");
    expect(err.agentId).toBe("zai");
    expect(err.available).toEqual(["claude", "codex"]);
  });
});
