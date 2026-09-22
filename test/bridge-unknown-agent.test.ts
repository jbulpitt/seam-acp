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
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentAdapter } from "@seam/adapters";
import {
  resolveSlotAdapter,
  unknownAgentMessage,
  unspecifiedAgentMessage,
  UnknownAgentError,
  UnspecifiedAgentError,
  spawnRefusalFrame,
  type AdapterResolution,
} from "../packages/bridge/src/resolve-adapter.js";
import { spawnAgent } from "../packages/bridge/src/spawn-agent.js";

// The legacy copilot branch called `node:child_process.spawn` directly.
// `adapter.spawn` being invoked is not enough: a branch that launches copilot
// and also calls the adapter would still look successful. This count is what
// fails that mutation, and it stops the regression from starting a real CLI.
const childProcessSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => childProcessSpawn(...args) };
});

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
    expect(r.kind).toBe("unknown");
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
    expect(adapterOf(resolveSlotAdapter(FLEET, cfg("copilot")))).toBe("copilot");
  });

  it("refuses when no id is stated and several adapters exist", () => {
    // Several agents and no name used to exec copilot. That is a substitution.
    const r = resolveSlotAdapter(FLEET, undefined);
    expect(r.kind).toBe("unspecified");
    if (r.kind !== "unspecified") throw new Error("expected a refusal");
    expect(r.available).toEqual(["agy", "claude", "codex", "copilot", "grok"]);
  });

  it("refuses when the host holds no adapters and no id was stated", () => {
    const r = resolveSlotAdapter(new Map(), undefined);
    expect(r.kind).toBe("unspecified");
    if (r.kind !== "unspecified") throw new Error("expected a refusal");
    expect(r.available).toEqual([]);
  });

  it("refuses a stated id on a host holding no adapters, rather than guessing", () => {
    const r = resolveSlotAdapter(new Map(), cfg("claude"));
    expect(r.kind).toBe("unknown");
    if (r.kind !== "unknown") throw new Error("unreachable");
    expect(r.available).toEqual([]);
  });
});

describe("#468 spawnAgent itself refuses, and spawns nothing while doing so", () => {
  // Until `spawnAgent` was lifted out of `index.ts`, deleting the throw below
  // left a green suite: the CLI entrypoint `process.exit(1)`s on import, so no
  // test could reach it. That mutation is this story's whole fix, undone.
  const spawning = (id: string) => {
    let calls = 0;
    const adapter = {
      id,
      spawn: () => { calls += 1; return { pid: 1 } as never; },
    } as unknown as AgentAdapter;
    return { adapter, spawned: () => calls };
  };

  it("throws UnknownAgentError for an id this bridge cannot serve", () => {
    const { adapter } = spawning("agy");
    const adapters = new Map([["agy", adapter]]);
    expect(() => spawnAgent(adapters, { agentId: "ollama-cloud" } as never))
      .toThrow(UnknownAgentError);
    expect(childProcessSpawn).not.toHaveBeenCalled();
  });

  it("launches NOTHING when it refuses — not the agent, not copilot", () => {
    // The refusal has to happen before any process starts. Falling through to
    // a copilot launcher is the defect, and it is a licensing boundary.
    const { adapter, spawned } = spawning("agy");
    const adapters = new Map([["agy", adapter]]);
    try {
      spawnAgent(adapters, { agentId: "zai" } as never);
    } catch { /* expected */ }
    expect(spawned()).toBe(0);
    expect(childProcessSpawn).not.toHaveBeenCalled();
  });

  it("names the agent and the inventory in what it throws", () => {
    const { adapter } = spawning("agy");
    expect(() => spawnAgent(new Map([["agy", adapter]]), { agentId: "zai" } as never))
      .toThrow(/"zai".*holds: agy/s);
  });

  it("still spawns a known adapter, passing model, effort, mcp, cwd, and env", () => {
    let got: unknown[] = [];
    const adapter = {
      id: "claude",
      spawn: (...args: unknown[]) => { got = args; return { pid: 2 } as never; },
    } as unknown as AgentAdapter;
    const mcp = [{ name: "seam-mcp" }] as McpServer[];
    const child = spawnAgent(
      new Map([["claude", adapter]]),
      {
        agentId: "claude",
        model: "opus",
        effort: "high",
        mcpServers: mcp,
        cwd: "/remote/repository",
        env: { GH_TOKEN: "slot-credential-token" },
      } as never
    );
    expect(child).toEqual({ pid: 2 });
    expect(got).toEqual([
      "opus",
      "high",
      mcp,
      { cwd: "/remote/repository", env: { GH_TOKEN: "slot-credential-token" } },
    ]);
    expect(childProcessSpawn).not.toHaveBeenCalled();
  });

  it("spawns an explicit copilot id through that adapter, not a second launcher", () => {
    let got: unknown[] = [];
    const adapter = {
      id: "copilot",
      spawn: (...args: unknown[]) => { got = args; return { pid: 4 } as never; },
    } as unknown as AgentAdapter;
    const mcp = [{ name: "seam-mcp" }] as McpServer[];
    const child = spawnAgent(FLEET_WITH(adapter), {
      agentId: "copilot",
      model: "gpt-5.4",
      effort: "high",
      mcpServers: mcp,
      cwd: "/remote/repository",
      env: { GH_TOKEN: "slot-credential-token" },
    } as never);
    expect(child).toEqual({ pid: 4 });
    expect(got).toEqual([
      "gpt-5.4",
      "high",
      mcp,
      { cwd: "/remote/repository", env: { GH_TOKEN: "slot-credential-token" } },
    ]);
    // Restoring `adapter.id !== "copilot"` skips this spawn and execs the CLI.
    expect(childProcessSpawn).not.toHaveBeenCalled();
  });

  it("refuses an unnamed slot on a multi-agent host instead of spawning copilot", () => {
    const { adapter, spawned } = spawning("copilot");
    const adapters = new Map<string, AgentAdapter>([
      ["copilot", adapter],
      ["claude", { id: "claude", spawn: () => { throw new Error("claude spawn"); } } as never],
    ]);
    expect(() => spawnAgent(adapters, undefined)).toThrow(UnspecifiedAgentError);
    expect(spawned()).toBe(0);
    expect(childProcessSpawn).not.toHaveBeenCalled();
  });

  it("refuses an unnamed slot when the host holds nothing, instead of execing copilot", () => {
    expect(() => spawnAgent(new Map(), undefined)).toThrow(UnspecifiedAgentError);
    expect(() => spawnAgent(new Map(), undefined)).toThrow(/holds: none/);
    expect(childProcessSpawn).not.toHaveBeenCalled();
  });

  it("still serves the one adapter when a copilot-only host is not told an id", () => {
    let calls = 0;
    const adapter = {
      id: "copilot",
      spawn: () => { calls += 1; return { pid: 5 } as never; },
    } as unknown as AgentAdapter;
    const child = spawnAgent(new Map([["copilot", adapter]]), undefined);
    expect(child).toEqual({ pid: 5 });
    expect(calls).toBe(1);
    expect(childProcessSpawn).not.toHaveBeenCalled();
  });
});

function FLEET_WITH(copilot: AgentAdapter): Map<string, AgentAdapter> {
  return new Map([
    ["copilot", copilot],
    ["claude", fake("claude")],
    ["agy", fake("agy")],
    ["codex", fake("codex")],
    ["grok", fake("grok")],
  ]);
}

describe("#468 the refusal an operator reads", () => {
  it("states the agent, the inventory, and that nothing was substituted", () => {
    const msg = unknownAgentMessage("ollama-cloud", ["agy", "claude"]);
    expect(msg).toContain('"ollama-cloud"');
    expect(msg).toContain("agy, claude");
    expect(msg).toMatch(/refusing/i);
  });

  it("says 'none' rather than an empty gap when the host holds nothing", () => {
    expect(unknownAgentMessage("claude", [])).toContain("none");
    expect(unspecifiedAgentMessage([])).toContain("none");
    expect(unspecifiedAgentMessage(["copilot", "claude"])).toContain("copilot, claude");
    expect(unspecifiedAgentMessage(["copilot"])).toMatch(/refusing/i);
  });

  it("ends the slot with a non-zero code, so a refusal is not read as success", () => {
    // An old seam-acp reads `code` and nothing else. If this were 0 the slot
    // would look like a clean finish and the turn would appear to have worked.
    const frame = spawnRefusalFrame(new UnknownAgentError("zai", ["claude"]));
    expect(frame.code).toBe(1);
    expect(frame.spawnError).toContain("zai");
  });

  it("still carries a reason when something non-Error is thrown", () => {
    expect(spawnRefusalFrame("boom").spawnError).toBe("boom");
    expect(spawnRefusalFrame(new Error("plain")).spawnError).toBe("plain");
  });

  it("carries the id and inventory on the error, not only in prose", () => {
    const err = new UnknownAgentError("zai", ["claude", "codex"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UnknownAgentError");
    expect(err.agentId).toBe("zai");
    expect(err.available).toEqual(["claude", "codex"]);
  });
});
