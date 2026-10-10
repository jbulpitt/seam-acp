import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeHub, localBridgeWiring } from "./local-bridge-fixture.js";
import { visualConfig } from "./plugin-card-visuals-fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });

describe("Discord thread reconstruction uses one bridge path", () => {
  it.each(["local", "remote-645"])("sends the transcript inline on %s, then seeds the replacement session there", async location => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "seam-thread-compact-"));
    cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
    fs.writeFileSync(path.join(cwd, "compact.md"), "Summarize the entire conversation.");
    const store = new SessionStore(path.join(cwd, "seam.db"));
    cleanups.push(() => store.close());
    const logger = pino({ level: "silent" }) as any;
    const prompts: Array<{ sessionId: string; prompt: Array<{ text?: string }> }> = [];
    const launches: any[] = [];
    let sequence = 0;
    const profile = {
      id: "claude", displayName: "Claude fixture", defaultModel: "fixture-model",
      staticModels: [{ modelId: "fixture-model", name: "Fixture", contextLimit: 200_000 }],
      effort: { mechanism: "meta", levels: ["low"] },
      spawn() { throw new Error("controller profile spawn must never run"); },
      sessionManager: {
        listSessions: async () => [], getTranscript: async () => "",
        cloneSession: async () => {}, deleteSession: async () => {},
      },
    } as unknown as AgentProfile;
    const wiring = localBridgeWiring(params => {
      launches.push(params);
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        killed: false, exitCode: null, signalCode: null,
        kill() { this.killed = true; this.emit("exit", 0, null); this.emit("close", 0, null); return true; },
      });
      const sessionId = `compact-${++sequence}`;
      agent({ name: "thread-compaction-fixture" })
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
        .onRequest(methods.agent.session.new, () => ({ sessionId, configOptions: [{
          id: "model", name: "Model", type: "select" as const, currentValue: "fixture-model",
          options: [{ value: "fixture-model", name: "Fixture" }],
        }] }))
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
          prompts.push(params as any);
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId, update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture summary" },
            },
          });
          return { stopReason: "end_turn" };
        })
        .onNotification(methods.agent.session.cancel, () => {})
        .connect(ndJsonStream(Writable.toWeb(child.stdout) as WritableStream<Uint8Array>, Readable.toWeb(child.stdin) as ReadableStream<Uint8Array>));
      return child as any;
    });
    const threadPresets = new Map([["thread", { location }]]);
    const catalog = fixtureModelCatalog([profile]);
    const router = new SessionRouter({
      store, logger, profiles: [profile], modelCatalog: catalog, defaultAgentId: profile.id,
      defaultModel: profile.defaultModel, defaultCwd: cwd, threadPresets,
      seamMcp: wiring,
    });
    const record = router.ensureSessionRecord({
      platform: "discord", channelRef: "thread", parentRef: "parent", cwd,
    });
    store.upsert({ ...record, acpSessionId: "original-preserved" }, { source: "fixture", cause: "set provider binding for test" });
    const hub = localBridgeHub([profile], cwd, wiring);
    const localGet = hub.get.bind(hub);
    hub.get = () => localGet("local");
    hub.isBridgeReady = id => id === location;
    const orch = new Orchestrator({
      store, router, logger, modelCatalog: catalog, renderer: discordRenderer,
      config: { ...visualConfig, DATA_DIR: cwd, REPOS_ROOT: cwd, TURN_TIMEOUT_SECONDS: 15,
        REPO_EMOJIS: new Map(), channelPresets: new Map(), threadPresets, bridgePresets: new Map() } as any,
      adapter: { fetchThreadMessages: async () => [
        { authorIsBot: false, authorName: "Jesse", text: "retain this human context" },
        { authorIsBot: true, text: "retain this agent context" },
      ] } as any,
    });
    orch.setBridgeHub(hub);
    const result = await (orch as any).compactSessionFromThread({ platform: "discord", id: "thread" }, store.get(record.id));
    expect(result).toEqual({ newSessionId: "compact-2", summary: "fixture summary" });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.prompt.map(part => part.text).join("")).toContain(
      "Conversation Transcript:\nHuman (Jesse): retain this human context\nAgent: retain this agent context");
    expect(prompts[0]!.prompt.map(part => part.text).join("")).not.toMatch(/read.*file|transcript\.txt/i);
    expect(prompts[1]!.prompt.map(part => part.text).join("")).toContain("fixture summary");
    expect(launches).toHaveLength(2);
    expect(launches.every(params => params.agentId === "claude" && params.cwd === cwd)).toBe(true);
    expect(store.get(record.id)?.acpSessionId).toBe("compact-2");
  }, 15_000);
});
