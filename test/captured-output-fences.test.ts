import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { BUILTIN_PLUGINS } from "../packages/core/src/plugins/builtins.js";
import type { FenceRegistry } from "../packages/core/src/plugins/fence-registry.js";
import { StreamingMessageRenderer } from "../packages/core/src/core/streaming-message-renderer.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });

function setup(style = "messages", fences?: FenceRegistry) {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-output-fences-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  const now = new Date().toISOString();
  store.upsert({ id: "discord:thread", platform: "discord", channelRef: "thread", parentRef: null,
    agentId: "codex", acpSessionId: "acp", repoPath: "/repo", configJson: "{}", createdUtc: now, updatedUtc: now });
  const visible: string[] = [];
  const adapter = {
    sendMessage: vi.fn(async (channel: any, text: string) => { visible.push(text); return { channel, id: "text" }; }),
    sendPanel: vi.fn(async (channel: any, panel: any) => { visible.push(panel.description ?? ""); return { channel, id: "panel" }; }),
    editPanel: vi.fn(async (_ref: any, panel: any) => { visible.push(panel.description ?? ""); }),
    sendChoiceCard: vi.fn(async (channel: any, card: any) => { visible.push(`CHOICE:${card.panel.title}`); return { channel, id: "choice" }; }),
    sendFile: vi.fn(async (channel: any, file: any) => { visible.push(`FILE:${file.filename}`); return { channel, id: "file" }; }),
  };
  const orch = new Orchestrator({ logger: pino({ level: "silent" }) as any, store,
    config: { DATA_DIR: dir, REPOS_ROOT: "/repo", SEAM_DISPATCH_OUTPUT_STYLE: style,
      SEAM_PARTICIPANT_USER_IDS: [], SEAM_CONFIG_ADMIN_USER_IDS: [] } as any,
    router: {} as any, adapter: adapter as any, renderer: {} as any, fences });
  const channel = { platform: "discord", id: "thread" };
  const spec = { id: "dispatch", target: "thread", session: "live", kind: "forward", originThreadRef: "caller", prompt: "work", createdUtc: now };
  return { orch: orch as any, adapter, visible, channel, spec, store };
}

const fence = '```seam-choice\n{"title":"Choose next","options":[{"label":"Continue","kind":"prompt","payload":"continue"}]}\n```';

describe("one math registry across captured and streamed output", () => {
  const tex = "```latex\ne^{i\\pi}+1=0\n```";
  it.each(["dispatch messages", "dispatch card", "scheduled messages", "scheduled card", "stateless", "steer", "message", "messages", "panel"])("renders %s as a PNG rather than source", async path => {
    const plugins = new PluginHost(pino({ level: "silent" }));
    await plugins.loadBuiltins(BUILTIN_PLUGINS);
    const h = setup(path === "dispatch card" ? "card" : "messages", plugins.fences);
    if (path.startsWith("dispatch")) await h.orch.postDispatchOutput(h.channel, h.spec, tex);
    else if (path.startsWith("scheduled")) await h.orch.postScheduledResult(h.channel, "job", tex, path.endsWith("card") ? "card" : "messages");
    else if (path === "stateless") await h.orch.publishStatelessHandoffCard(h.channel, h.spec, undefined, "▶ Handoff", Date.now(), { text: tex });
    else if (path === "steer") await h.orch.postSteerOutput(h.channel, tex);
    else {
      const payload = path === "message" ? { kind: path, text: tex }
        : path === "messages" ? { kind: path, texts: [tex] }
          : { kind: path, panel: { title: "Result", color: 0, fields: [], description: tex } };
      await h.orch.sendDeliveryPayload(h.channel, payload, "nonce");
    }
    expect(h.adapter.sendFile).toHaveBeenCalledOnce();
    expect(h.adapter.sendFile.mock.calls[0]![1]).toMatchObject({ filename: "math-1.png", mimeType: "image/png" });
    expect(h.visible.filter(Boolean)).toEqual(["FILE:math-1.png"]);
    await plugins.dispose();
  });

  it("preserves ordering and the original forced-close notice through the renderer callback", async () => {
    const plugins = new PluginHost(pino({ level: "silent" }));
    await plugins.loadBuiltins(BUILTIN_PLUGINS);
    const h = setup("messages", plugins.fences);
    let counter = 0;
    const stream = new StreamingMessageRenderer(async text => { h.visible.push(text); }, {
      handleFence: async (fence, notice) => { await h.orch.emitClosedFence(h.channel, fence, ++counter, { notice }); return true; },
    });
    stream.feed("Before\n\n```math\nx=1");
    await stream.finalize();
    expect(h.visible).toEqual(["Before", "FILE:math-1.png", "_(fence was not closed by the agent)_"]);
    await plugins.dispose();
  });
});

describe("captured agent output uses live fence handlers", () => {
  it.each(["messages", "card"])("renders a quiet %s forward as a question for its caller in prose order", async style => {
    const h = setup(style);
    await h.orch.postDispatchOutput(h.channel, h.spec, `Before\n\n${fence}\n\nAfter`);
    expect(h.adapter.sendChoiceCard).not.toHaveBeenCalled();
    const output = h.visible.join("");
    expect(output).toMatch(/Before[\s\S]*Question for you: Choose next[\s\S]*After/);
    expect(output).toContain("- Continue");
    expect(output).toContain("thread caller (an agent)");
    expect(h.visible.join("")).not.toContain("seam-choice");
  });

  it.each(["messages", "card"])("processes isolated scheduled %s output", async style => {
    const h = setup();
    await h.orch.postScheduledResult(h.channel, "job", fence, style);
    expect(h.adapter.sendChoiceCard).toHaveBeenCalledOnce();
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    expect(h.adapter.sendPanel).not.toHaveBeenCalled();
  });

  it("processes the quiet stateless handoff card without embedding directive JSON", async () => {
    const h = setup();
    await h.orch.publishStatelessHandoffCard(h.channel, h.spec, undefined, "▶ Handoff", Date.now(), { text: fence });
    expect(h.adapter.sendChoiceCard).not.toHaveBeenCalled();
    expect(h.visible.join("")).toContain("Question for you: Choose next");
    expect(h.visible.join("")).not.toContain("seam-choice");
  });

  it("processes slash-steer completion output", async () => {
    const h = setup();
    await h.orch.postSteerOutput(h.channel, fence);
    expect(h.adapter.sendChoiceCard).toHaveBeenCalledOnce();
    expect(h.visible.join("")).not.toContain("seam-choice");
  });

  it.each(["message", "messages", "panel"])("processes recovery %s payloads, preserving a choice longer than a Discord message", async kind => {
    const h = setup();
    const long = fence.replace('"title":', '"body":"' + "x".repeat(2500) + '","title":');
    const payload = kind === "message" ? { kind, text: long }
      : kind === "messages" ? { kind, texts: [long] }
        : { kind, panel: { title: "Result", color: 0, fields: [], description: long } };
    await h.orch.sendDeliveryPayload(h.channel, payload, "nonce");
    expect(h.adapter.sendChoiceCard).toHaveBeenCalledOnce();
    expect(h.visible.join("")).not.toContain("seam-choice");
  });

  it("uploads a seam-attach from captured completion through the thread's bridge", async () => {
    const h = setup();
    const readAttachmentForSession = vi.fn(async () => ({ bytes: Buffer.from("proof"), filename: "proof.txt", size: 5 }));
    h.orch.setBridgeHub({ sessionBridgeId: () => "remote", readAttachmentForSession });
    h.orch.effectiveCwd = () => "/remote/repo";
    await h.orch.postDispatchOutput(h.channel, h.spec, "```seam-attach\nproof.txt\n```");
    expect(readAttachmentForSession).toHaveBeenCalledWith("discord:thread", "/remote/repo", "proof.txt");
    expect(h.adapter.sendFile).toHaveBeenCalledWith(h.channel,
      expect.objectContaining({ filename: "proof.txt", data: Buffer.from("proof") }));
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["seam-wake", "seam-watch", "seam-result", "latex"])("routes %s through the shared handler", async lang => {
    const h = setup();
    const handle = vi.spyOn(h.orch, "emitClosedFence").mockResolvedValue(undefined);
    await h.orch.postDispatchOutput(h.channel, h.spec, `\`\`\`${lang}\nbody\n\`\`\``);
    expect(handle).toHaveBeenCalledWith(h.channel, expect.objectContaining({ lang, content: "body" }), 1, expect.any(Object));
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
  });
});
