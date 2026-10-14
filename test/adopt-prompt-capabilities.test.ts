import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSessiondProcessIdentity } from "../packages/bridge/src/sessiond-server.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { savedSessionHost, SAVED_SESSION } from "./helpers/saved-session-recovery.js";
import { prepareSessionExecutables } from "./helpers/saved-session-executables.js";

const agentFixture = fileURLToPath(new URL("./fixtures/prompt-capabilities-agent.mjs", import.meta.url));
let executables: Awaited<ReturnType<typeof prepareSessionExecutables>>;
beforeAll(async () => { executables = await prepareSessionExecutables(); }, 20_000);
afterAll(async () => { await executables?.close(); });
const advertised = { image: true, audio: true, embeddedContext: true };
const attachment = (kind: "image" | "audio" | "resource") => {
  const mime = kind === "image" ? "image/png" : kind === "audio" ? "audio/wav" : "text/plain";
  return { filename: kind === "image" ? "screenshot.png" : kind === "audio" ? "voice.wav" : "notes.txt",
    contentType: mime, size: 4, url: `data:${mime};base64,dGVzdA==` };
};

describe("adopted warm prompt capabilities", () => {
  it("does not treat an initialized capability observation as a routing change", () => {
    const base = { agentId: "codex", location: "fixture", session: "live", cwd: "/repo", model: "default" };
    expect(executionIdentity({ ...base, config: { model: "default",
      acpPromptCapabilities: { sessionId: SAVED_SESSION, capabilities: advertised } } }))
      .toBe(executionIdentity({ ...base, config: { model: "default" } }));
  });
  it.each(["image", "audio", "resource"] as const)("keeps the actual initialized %s capability across controller and bridge replacement", async kind => {
    const h = await savedSessionHost({ ...executables, agentFixture, writerLock: true });
    try {
      await fs.writeFile(path.join(h.root, "prompt-capabilities.json"), JSON.stringify(advertised));
      const previous = h.makeRouter();
      const runtime = await previous.getOrStartRuntime(h.record);
      expect(runtime.getPromptCapabilities()).toEqual(advertised);
      await runtime.prompt("continue warm-up");
      const slot = runtime.getSlot()!;
      const before = (await h.client.listSlots()).health.find(row => row.slot === slot)!;
      const adapter = readSessiondProcessIdentity(before.pid!);
      const nativePid = (await h.requests()).find(row => row.method === "initialize").pid;
      const native = readSessiondProcessIdentity(nativePid);
      await previous.disposeAll();
      await h.restartBridge();
      const reopened = new SessionStore(h.db);
      const record = reopened.get(h.record.id)!;
      reopened.close();
      const replacement = h.makeRouter();
      const adopted = await replacement.getOrStartRuntime(record);
      await adopted.prompt("continue with attachment", [attachment(kind)]);
      const requests = await h.requests();
      const prompt = requests.filter(row => row.method === "session/prompt").at(-1)!;
      expect(prompt.params.prompt).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: kind }),
      ]));
      expect(adopted.getPromptCapabilities()).toEqual(advertised);
      expect(prompt.params.sessionId).toBe(SAVED_SESSION);
      expect(prompt.pid).toBe(nativePid);
      expect(adopted.getSlot()).toBe(slot);
      expect(readSessiondProcessIdentity(before.pid!)).toEqual(adapter);
      expect(readSessiondProcessIdentity(nativePid)).toEqual(native);
      expect(requests.filter(row => row.method === "initialize")).toHaveLength(1);
      expect(requests.filter(row => row.method === "session/load")).toHaveLength(1);
      expect(requests.filter(row => row.method === "session/new")).toEqual([]);
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
      expect(h.commands.filter(frame => frame.type === "rpc" && frame.method === "spawn")).toHaveLength(1);
    } finally { await h.close(); }
  }, 25_000);

  it.each([{}, { image: false, audio: false, embeddedContext: false }, null])("does not invent vision when initialize advertises %j", async caps => {
    const h = await savedSessionHost({ ...executables, agentFixture });
    try {
      await fs.writeFile(path.join(h.root, "prompt-capabilities.json"), JSON.stringify(caps));
      const previous = h.makeRouter();
      const runtime = await previous.getOrStartRuntime(h.record);
      await runtime.prompt("continue warm-up");
      await previous.disposeAll();
      const adopted = await h.makeRouter().getOrStartRuntime(h.store.get(h.record.id)!);
      await adopted.prompt("continue with image", [attachment("image")]);
      expect((await h.requests()).filter(row => row.method === "session/prompt").at(-1)!.params.prompt)
        .toEqual(expect.arrayContaining([expect.objectContaining({ type: "resource_link" })]));
      expect((await h.requests()).filter(row => row.method === "initialize")).toHaveLength(1);
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
    } finally { await h.close(); }
  }, 20_000);

  it.each(["legacy", "different-acp"])("keeps the file fallback when retained capabilities are %s", async shape => {
    const h = await savedSessionHost({ ...executables, agentFixture });
    try {
      await fs.writeFile(path.join(h.root, "prompt-capabilities.json"), JSON.stringify(advertised));
      const previous = h.makeRouter();
      const runtime = await previous.getOrStartRuntime(h.record);
      await runtime.prompt("continue warm-up");
      await previous.disposeAll();
      const live = h.store.get(h.record.id)!;
      const cfg = JSON.parse(live.configJson);
      if (shape === "legacy") delete cfg.acpPromptCapabilities;
      else cfg.acpPromptCapabilities = { sessionId: "another-session", capabilities: advertised };
      h.store.upsert({ ...live, configJson: JSON.stringify(cfg) });
      const adopted = await h.makeRouter().getOrStartRuntime(h.store.get(h.record.id)!);
      await adopted.prompt("continue with legacy image", [attachment("image")]);
      const requests = await h.requests();
      expect(requests.filter(row => row.method === "session/prompt").at(-1)!.params.prompt)
        .toEqual(expect.arrayContaining([expect.objectContaining({ type: "resource_link" })]));
      expect(adopted.getPromptCapabilities()).toBeUndefined();
      expect(requests.filter(row => row.method === "initialize")).toHaveLength(1);
      expect(requests.filter(row => row.method === "session/load")).toHaveLength(1);
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
    } finally { await h.close(); }
  }, 20_000);
});
