import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import { pino } from "pino";
import { buildChannelPresetMaps, type Config } from "../packages/core/src/config.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { GoogleDriveUploader } from "../packages/core/src/core/files/google-drive-upload.js";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { multiplexChatAdapters } from "../packages/core/src/platforms/google-chat/multiplex.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import type { ChannelRef } from "../packages/core/src/platforms/chat-adapter.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeHub, localBridgeWiring } from "./local-bridge-fixture.js";

const remote = "remote-949", remoteCwd = "/remote/projects/chat-repo", model = "synthetic-model";
const channel = { platform: "google-chat", id: "dm.thread", parentId: "dm" };
const logger = pino({ level: "silent" }) as any;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function event(text = "Tiny task", commandId?: number, thread = "thread") {
  return { type: "MESSAGE", space: { name: "spaces/dm", spaceType: "DIRECT_MESSAGE" },
    user: { name: "users/42", displayName: "Tester" }, message: {
      name: `spaces/dm/messages/${thread}-${commandId ?? "message"}`, text, argumentText: text, threadReply: true,
      thread: { name: `spaces/dm/threads/${thread}` }, ...(commandId ? { slashCommand: { commandId } } : {}),
    } };
}

/** Real Chat admission, SQL, presets, router and ACP; only Google/bridge transport is synthetic. */
function setup(presets: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-chat-remote-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "presets.json");
  writeFileSync(file, JSON.stringify({ ...presets, bridges: { [remote]: { tokenHash: "a".repeat(64) } } }));
  const maps = buildChannelPresetMaps(file);
  const store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  const prompts: string[] = [], launches: any[] = [], sessions: any[] = [];
  const bindings = new Map<string, string>();
  let sequence = 0, final = "CHAT949_FINAL";
  const spawn = (launch: any) => {
    launches.push(launch);
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, { stdin, stdout, stderr, pid: undefined, killed: false, exitCode: null,
      kill() { this.killed = true; emitter.emit("exit", null, "SIGTERM"); return true; } });
    const configOptions = [{ id: "model", name: "Model", type: "select" as const, currentValue: model,
      options: [{ value: model, name: model }] }];
    agent({ name: "chat-remote-fixture" })
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
      .onRequest(methods.agent.session.new, ({ params }) => { sessions.push(params); return { sessionId: `chat-acp-${++sequence}`, configOptions }; })
      .onRequest(methods.agent.session.load, ({ params }) => ({ sessionId: params.sessionId, configOptions }))
      .onRequest(methods.agent.session.setConfigOption, () => ({ configOptions }))
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        prompts.push(params.prompt.map(part => part.type === "text" ? part.text : "").join("\n"));
        await client.notify(methods.client.session.update, { sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: final } } });
        return { stopReason: "end_turn" };
      })
      .onNotification(methods.agent.session.cancel, () => {})
      .connect(ndJsonStream(Writable.toWeb(stdout), Readable.toWeb(stdin)));
    return child as any;
  };
  const profile = { id: "codex", displayName: "Codex fixture", defaultModel: model,
    spawn: vi.fn(() => { throw new Error("must use the bound bridge"); }),
    sessionManager: { deleteSession: async () => {}, getTranscript: async () => "" } } as unknown as AgentProfile;
  const modelCatalog = fixtureModelCatalog([profile]);
  const wiring = localBridgeWiring(spawn);
  wiring.bindSessionLocation = (id, location) => { bindings.set(id, location); };
  const router = new SessionRouter({ logger, store, profiles: [profile], modelCatalog, ...maps,
    defaultAgentId: profile.id, defaultModel: model, defaultCwd: dir,
    executionBridge: wiring as any, seamMcp: wiring });
  cleanups.push(() => router.disposeAll());
  const request = vi.fn(async (_scope: string, req: any): Promise<any> => req.responseType === "arraybuffer"
    ? Buffer.from("CHAT949_INCOMING_BYTES") : ({ name: `spaces/dm/messages/app-${++sequence}`,
      thread: req.data?.thread ?? { name: "spaces/dm/threads/new" } }));
  const driveRequest = vi.fn(async (req: any): Promise<any> => req.method === "POST"
    ? { data: {}, headers: new Headers({ location: "https://drive.example/upload" }) }
    : { data: { id: "remote-file", webViewLink: "https://drive.example/remote-file" }, headers: new Headers() });
  const drive = new GoogleDriveUploader({ credentialsFile: "/not-read.json", folderId: "shared-drive",
    sharing: { kind: "members-only" } }, { request: driveRequest });
  const chat = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set(["users/42"]), defaultCwd: remoteCwd, defaultLocation: remote,
    logger, writeIntervalMs: 0, driveUploader: drive } as any);
  const discord = { platform: "discord", onMessage() {}, sendMessage: vi.fn() } as any;
  const adapter = multiplexChatAdapters([discord, chat]);
  const config = { ...maps, DATA_DIR: dir, REPOS_ROOT: dir, CHANNEL_PRESETS_FILE: file,
    DEFAULT_AGENT: profile.id, DEFAULT_MODEL: model, TURN_TIMEOUT_SECONDS: 15, SEAM_TURN_RESUME_ENABLED: true,
    SEAM_CONFIG_ADMIN_USER_IDS: new Set(), SEAM_PARTICIPANT_USER_IDS: new Set(),
    REPO_EMOJIS: new Map(), ATTACH_ALLOW_ANY_PATH: false } as unknown as Config;
  const orch = new Orchestrator({ logger, store, router, adapter, config, modelCatalog, renderer: discordRenderer });
  const hub = localBridgeHub([profile], dir, wiring) as any;
  let ready = true;
  const readyListeners = new Set<(location: string) => void>();
  hub.isBridgeReady = (location: string) => ready && ["local", remote].includes(location);
  hub.onBridgeReady = vi.fn((callback: (location: string) => void) => { readyListeners.add(callback); return () => readyListeners.delete(callback); });
  hub.writeAttachment = vi.fn(async (_location: string, _cwd: string, filename: string, _bytes: Uint8Array) => ({ path: `${remoteCwd}/.attachments/${filename}` }));
  hub.sessionBridgeId = (id: string) => bindings.get(id);
  hub.readAttachmentForSession = vi.fn(async () => ({ bytes: Buffer.from("CHAT949_REMOTE_OUTPUT"), filename: "out.bin", size: 21 }));
  orch.setBridgeHub(hub);
  chat.setCommandDeps({ store, router, mutation: orch.getConfigMutation(), runtimeTransition: orch.getRuntimeTransition(),
    cancelChannel: (ch: ChannelRef) => orch.cancelChannel(ch) } as any);
  let work: Promise<void> = Promise.resolve();
  chat.onMessage(msg => { work = (orch as any).handleIncomingMessage(msg); return work; });
  const deliver = async (raw = event()) => { await chat.receiveEvent(raw); await work; };
  const setReady = (value: boolean) => { ready = value; if (value) for (const callback of readyListeners) callback(remote); };
  return { dir, file, maps, store, router, orch, chat, request, driveRequest, hub, prompts, launches, sessions, bindings,
    deliver, settled: () => work, setReady, output: (text: string) => { final = text; },
    record: () => store.getByChannel(channel.platform, channel.id)! };
}

describe("Google Chat sessions use the existing host binding", () => {
  it("binds the first ordinary message's location and repo before ACP acquisition", async () => {
    const h = setup();
    await h.deliver();
    expect(h.bindings.get(h.record().id)).toBe(remote);
    expect(h.router.describeConfig(h.record()).cwd.value).toBe(remoteCwd);
    expect(h.sessions).toEqual([expect.objectContaining({ cwd: remoteCwd })]);
    expect(h.prompts).toHaveLength(1);
    expect(h.record().repoPath).toBeNull();
    expect(JSON.parse(readFileSync(h.file, "utf8")).threads["google-chat:dm.thread"])
      .toMatchObject({ location: remote, cwd: { value: remoteCwd } });
  });

  it("/new applies the same defaults before its first model choice and leaves the old session alone", async () => {
    const h = setup();
    const old = h.router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id, parentRef: "dm", cwd: h.dir });
    const before = h.store.get(old.id);
    await h.chat.receiveEvent(event("/new New task", 1));
    const created = h.store.getByChannel("google-chat", "dm.new")!;
    expect(h.router.describeConfig(created)).toMatchObject({ location: { value: remote }, cwd: { value: remoteCwd } });
    expect(h.store.get(old.id)).toEqual(before);
    expect(h.launches).toEqual([]);
  });

  it("preserves an existing session's selection instead of reapplying deployment defaults", async () => {
    const h = setup({ threads: { "google-chat:dm.thread": { cwd: { value: "/chosen/repo" } } } });
    const existing = h.router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id, parentRef: "dm", cwd: h.dir });
    const before = readFileSync(h.file, "utf8");
    await h.deliver();
    expect(h.router.describeConfig(h.store.get(existing.id)!)).toMatchObject({ location: { value: "local" }, cwd: { value: "/chosen/repo" } });
    expect(readFileSync(h.file, "utf8")).toBe(before);
  });

  it("does not overwrite a preconfigured new thread's location or cwd", async () => {
    const h = setup({ threads: { "google-chat:dm.thread": { location: remote, cwd: { value: "/chosen/repo" } } } });
    await h.deliver();
    expect(h.router.describeConfig(h.record())).toMatchObject({ location: { value: remote }, cwd: { value: "/chosen/repo" } });
  });

  it("/agent codex@remote uses the shared transition and persists a reloadable host binding", async () => {
    const h = setup();
    h.router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id, parentRef: "dm", cwd: h.dir });
    await h.chat.receiveEvent(event(`/agent codex@${remote}`, 3));
    expect(h.router.describeConfig(h.record()).location.value).toBe(remote);
    expect(h.bindings.get(h.record().id)).toBe(remote);
    expect(JSON.parse(readFileSync(h.file, "utf8")).threads["google-chat:dm.thread"].location).toBe(remote);
    await h.chat.receiveEvent(event(`/model ${model}`, 4));
    expect(h.router.describeConfig(h.record())).toMatchObject({ agent: { value: "codex" }, model: { value: model }, location: { value: remote } });
  });

  it("admits an offline-host message, waits without parking/submitting, then completes once", async () => {
    const h = setup({ threads: { "google-chat:dm.thread": { location: remote } } });
    h.setReady(false);
    try {
      await h.chat.receiveEvent(event());
      const inbound = h.store.listInboundNonterminal();
      expect(inbound).toHaveLength(1);
      await vi.waitFor(() => expect(h.hub.onBridgeReady).toHaveBeenCalledOnce());
      expect(h.prompts).toEqual([]);
      expect(h.launches).toEqual([]);
      expect(h.request.mock.calls.some(([, req]) => JSON.stringify(req.data).includes("Reconnecting to session"))).toBe(true);
    } finally {
      h.setReady(true);
      await h.settled();
    }
    expect(h.prompts).toHaveLength(1);
    expect(h.store.turnAttempts.list("completed")).toHaveLength(1);
  });

  it("reports an unknown location immediately with its real bridge cause", async () => {
    const h = setup({ threads: { "google-chat:dm.thread": { location: "missing-949" } } });
    await h.deliver();
    expect(h.prompts).toEqual([]);
    expect(h.hub.onBridgeReady).not.toHaveBeenCalled();
    expect(h.request.mock.calls.some(([, req]) => JSON.stringify(req.data).includes('Unknown bridge location'))).toBe(true);
    expect(h.store.turnAttempts.list("completed")[0]?.outcome?.error).toContain('Unknown bridge location "missing-949"');
  });

  it("downloads Chat attachment bytes on the controller and stages a binary on the bound remote host", async () => {
    const h = setup({ threads: { "google-chat:dm.thread": { location: remote, cwd: { value: remoteCwd } } } });
    const raw = { ...event(), message: { ...event().message, attachment: [{ contentName: "in.bin", contentType: "application/octet-stream",
      attachmentDataRef: { resourceName: "spaces/dm/messages/M/attachments/A" } }] } };
    await h.deliver(raw);
    expect(h.request).toHaveBeenCalledWith("chat", expect.objectContaining({ method: "GET", responseType: "arraybuffer" }));
    expect(h.hub.writeAttachment).toHaveBeenCalledExactlyOnceWith(remote, remoteCwd,
      expect.stringMatching(/^[0-9a-f]{8}-in\.bin$/), Buffer.from("CHAT949_INCOMING_BYTES"));
    expect(h.prompts[0]).toContain(`${remoteCwd}/.attachments/${h.hub.writeAttachment.mock.calls[0][2]}`);
  });

  it("ferries a remote seam-attach through the controller's Drive uploader to the same Chat thread", async () => {
    const h = setup({ threads: { "google-chat:dm.thread": { location: remote, cwd: { value: remoteCwd } } } });
    h.output("```seam-attach\nout.bin\n```");
    await h.deliver();
    expect(h.hub.readAttachmentForSession).toHaveBeenCalledExactlyOnceWith(h.record().id, remoteCwd, "out.bin");
    expect(h.driveRequest.mock.calls.find(([req]) => req.method === "PUT")?.[0].data).toEqual(Buffer.from("CHAT949_REMOTE_OUTPUT"));
    expect(h.request.mock.calls.some(([, req]) => req.data?.text?.includes("https://drive.example/remote-file")
      && req.data.thread?.name === "spaces/dm/threads/thread")).toBe(true);
  });
});
