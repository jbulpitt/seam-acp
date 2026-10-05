import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { agentChoiceOutput, agentChoiceRefusal } from "../packages/core/src/core/choice/turn-origin.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const choice = { title: "May I reserve staging?", options: [{ label: "Yes", kind: "prompt", payload: "reserve staging" }] };
const fence = "```seam-choice\n" + JSON.stringify(choice) + "\n```";

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-agent-choices-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  const now = new Date().toISOString();
  const record = { id: "discord:worker", platform: "discord", channelRef: "worker", parentRef: null,
    agentId: "codex", acpSessionId: "acp", repoPath: "/repo", configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  const adapter = {
    sendChoiceCard: vi.fn(async (channel, _card) => ({ channel, id: "card" })),
    sendMessage: vi.fn(async (channel, _text, _delivery?: unknown) => ({ channel, id: "text" })),
  };
  const orch = new Orchestrator({ logger: pino({ level: "silent" }) as any, store,
    config: { DATA_DIR: dir, REPOS_ROOT: "/repo", SEAM_PARTICIPANT_USER_IDS: [], SEAM_CONFIG_ADMIN_USER_IDS: [] } as any,
    router: {} as any, adapter: adapter as any, renderer: {} as any });
  const spec = (kind: DispatchSpec["kind"], over: Partial<DispatchSpec> = {}): DispatchSpec => ({
    id: "attempt", target: "worker", session: "live", kind, originThreadRef: "caller", returnTo: "delivery-thread",
    prompt: "do the work", createdUtc: now, ...over,
  });
  const start = (dispatch: DispatchSpec) => {
    store.turnAttempts.registerOwner("boot");
    const attempt = store.turnAttempts.claim(dispatch, "identity", "boot");
    store.turnAttempts.bind(attempt, "acp");
    (orch as any).activeLiveDispatch.set("worker", dispatch.id);
    return attempt;
  };
  return { orch, store, record, adapter, spec, start };
}

describe("choice availability follows the requesting turn", () => {
  it.each(["handoff", "forward", "report_back"] as const)("%s returns the real caller in the MCP error and publishes nothing", async kind => {
    const h = setup();
    h.start(h.spec(kind));
    const server = new SeamMcpServer({ logger: pino({ level: "silent" }) as any,
      resolveSession: () => h.record, enqueueDispatch: async () => {}, createChoice: (record, spec) => h.orch.createChoice(record, spec) });
    await server.start();
    cleanups.push(() => server.stop());
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", "x-seam-session": "token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_choice", arguments: choice } }) });
    const body = await response.json() as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("thread caller (an agent)");
    expect(body.result.content[0].text).toContain("put the question in your result");
    expect(body.result.content[0].text).not.toContain("thread delivery-thread");
    expect(h.adapter.sendChoiceCard).not.toHaveBeenCalled();
  });

  it.each(["wake", "scheduled", "watch", "parked", "choice", undefined] as const)("%s preserves card publication", async kind => {
    const h = setup();
    if (kind) h.start(h.spec(kind));
    else (h.orch as any).currentAuthorIds.set("worker", "user");
    expect((await h.orch.createChoice(h.record, choice)).ok).toBe(true);
    expect(h.adapter.sendChoiceCard).toHaveBeenCalledOnce();
  });

  it("an isolated handoff's token resolves its own frozen origin, without restricting the user's concurrent turn", async () => {
    const h = setup();
    h.start(h.spec("handoff", { session: "isolated" }));
    (h.orch as any).activeLiveDispatch.clear();
    (h.orch as any).currentAuthorIds.set("worker", "user");
    const worker = h.orch.resolveIngestJob("dispatch:attempt")!;
    expect(worker.id).toBe("dispatch:attempt");
    expect(await h.orch.createChoice(worker, choice)).toEqual({ ok: false, error: agentChoiceRefusal(h.spec("handoff")) });
    expect((await h.orch.createChoice(h.record, choice)).ok).toBe(true);
    expect(h.adapter.sendChoiceCard).toHaveBeenCalledOnce();
  });

  it("the next user turn can publish after a handoff completes", async () => {
    const h = setup();
    const attempt = h.start(h.spec("handoff"));
    expect((await h.orch.createChoice(h.record, choice)).ok).toBe(false);
    h.store.turnAttempts.complete(attempt, { id: attempt.id, target: "worker", status: "completed", finishedUtc: new Date().toISOString() });
    (h.orch as any).activeLiveDispatch.clear();
    (h.orch as any).currentAuthorIds.set("worker", "user");
    expect((await h.orch.createChoice(h.record, choice)).ok).toBe(true);
  });

  it("durable recovery renders the question and options rather than publishing or leaking fence JSON", async () => {
    const h = setup();
    await (h.orch as any).sendDeliveryPayload({ platform: "discord", id: "worker" }, { kind: "message", text: fence }, "nonce", h.spec("handoff"));
    expect(h.adapter.sendChoiceCard).not.toHaveBeenCalled();
    const output = h.adapter.sendMessage.mock.calls.map(call => call[1]).join("\n");
    expect(h.adapter.sendMessage.mock.calls[0]?.[2]).toEqual({ nonce: expect.any(String), enforceNonce: true });
    expect(output).toContain("Question for you: May I reserve staging?");
    expect(output).toContain("- Yes");
    expect(output).toContain("thread caller (an agent)");
    expect(output).not.toContain("seam-choice");
    expect(output).not.toContain('"payload"');
  });

  it("report-back capture keeps prose and other fences and converts closed or unclosed choice fences", () => {
    const h = setup();
    const text = "Before\n```js\nconst answer = 42;\n```\n" + fence + "\nAfter";
    const output = agentChoiceOutput(text, h.spec("forward"));
    expect(output).toContain("Before\n```js\nconst answer = 42;\n```");
    expect(output).toContain("Question for you: May I reserve staging?");
    expect(output).toContain("\nAfter");
    expect(output).not.toContain("seam-choice");
    expect(agentChoiceOutput(fence.slice(0, -3), h.spec("forward"))).not.toContain("seam-choice");
    expect(agentChoiceOutput(text, h.spec("wake"))).toBe(text);
  });
});
