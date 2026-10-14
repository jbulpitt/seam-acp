import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile } from "@seam/adapters";
import { PresetsFileSchema, type Config } from "../packages/core/src/config.js";
import type { BridgeHub } from "../packages/core/src/core/bridge-hub.js";
import { createConfigFacades } from "../packages/core/src/core/config-apply-plan.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { GoogleChatSessionSpaces, bindGoogleChatSessionSpace, prepareGoogleChatSpaceSelection } from "../packages/core/src/platforms/google-chat/session-spaces.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const stores: SessionStore[] = [];
const directories: string[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close());
  directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
const remoteRoot = "/Users/jessebulpitt/Projects";
function fixture(reportedRoot: string | null = remoteRoot) {
  const store = new SessionStore(":memory:"); stores.push(store);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-new-space-repo-")); directories.push(dir);
  const presetsFile = path.join(dir, "presets.json"); fs.writeFileSync(presetsFile, '{}');
  const logger = pino({ level: "silent" });
  const profile = { id: "agy", defaultModel: "gemini-3.8-flash-medium",
    staticModels: [{ modelId: "gemini-3.8-flash-medium" }], effort: { mechanism: "none", levels: [] } } as unknown as AgentProfile;
  const modelCatalog = fixtureModelCatalog([profile]);
  const config = { REPOS_ROOT: "/home/ubuntu/Projects", DEFAULT_AGENT: "agy", GOOGLE_CHAT_DEFAULT_CWD: "/home/ubuntu/Projects",
    channelPresets: new Map(), threadPresets: new Map(), bridgePresets: new Map() } as unknown as Config;
  const router = new SessionRouter({ store, logger, profiles: [profile], modelCatalog, defaultAgentId: "agy",
    channelPresets: config.channelPresets, threadPresets: config.threadPresets });
  const mutation = new ConfigMutationService({ store, logger, modelCatalog,
    describeConfig: record => router.describeConfig(record), isAgentAvailable: id => Boolean(router.getProfile(id)),
    presetsFile, tierCEnabled: false, reschedule: () => {}, defaultTimezone: "America/Chicago",
    reloadPresets: () => {
      const doc = PresetsFileSchema.parse(JSON.parse(fs.readFileSync(presetsFile, "utf8")));
      config.threadPresets.clear();
      for (const [key, entry] of Object.entries(doc.threads ?? {})) config.threadPresets.set(key.replace(/^google-chat:/, ""), entry);
      return { ok: true };
    } });
  const listWorkspaces = vi.fn(async () => [{ path: `${remoteRoot}/barclays` }]);
  const hostExec = vi.fn(async () => ({ exitCode: 0, stdout: `${remoteRoot}/barclays\n`, stderr: "" }));
  const bridgeHub = { get: (location: string) => location === "macbook-air" ? { host: reportedRoot === null ? {} : { workspaceRoot: reportedRoot } } : undefined,
    listWorkspaces, hostExec } as unknown as BridgeHub;
  const { plan } = createConfigFacades({ store, router, mutation, config, modelCatalog, logger, bridgeHub,
    identityCommitted: async () => {}, persistConfig: () => {}, repoDisplay: value => value ?? "",
    unregisteredAgentMessage: (_id, fallback) => fallback });
  return { store, router, mutation, config, logger, modelCatalog, plan, bridgeHub, listWorkspaces, hostExec };
}

describe("new Space repo uses the selected host", () => {
  it("keeps Chat /new argument parsing, host validation and durable root binding aligned", async () => {
    const h = fixture();
    const request = vi.fn(async (_scope: string, r: any): Promise<any> => {
      if (r.url.endsWith("/spaces")) return { name: "spaces/barclays", spaceUri: "https://chat.google.com/room/barclays" };
      if (r.method === "POST" && r.url.endsWith("/members")) return { name: "spaces/barclays/members/requester" };
      return {};
    });
    const launcher = new GoogleChatSessionSpaces({ config: h.config, api: { request }, store: h.store, logger: h.logger,
      writes: { enqueue: async (_space, work) => work() }, spaceEvents: { register: vi.fn(async () => {}) },
      prepare: snapshot => prepareGoogleChatSpaceSelection(snapshot, { ...h, configPlan: h.plan, defaultCwd: h.config.REPOS_ROOT }),
      bind: (channel, snapshot, actor) => bindGoogleChatSessionSpace(channel, snapshot, h, actor) });
    const result = await launcher.create({ messageId: "new-barclays", origin: { platform: "google-chat", id: "launcher" },
      requester: { id: "users/requester", name: "Requester" },
      args: `barclays agent=agy@macbook-air model=gemini-3.8-flash-medium effort=default repo=${remoteRoot}/barclays` });
    expect(h.hostExec).toHaveBeenCalledWith("macbook-air", { command: "pwd", cwd: `${remoteRoot}/barclays` });
    const record = h.store.get(result.sessionRecordId)!;
    expect(h.router.describeConfig(record)).toMatchObject({ agent: { value: "agy" }, location: { value: "macbook-air" },
      cwd: { value: `${remoteRoot}/barclays` } });
    expect(record.parentRef).toBeNull();
  });

  it("resolves a relative repo only from the requested remote inventory", async () => {
    const h = fixture();
    expect(await h.plan.resolveRequestedRepoPath("macbook-air", "barclays")).toBe(`${remoteRoot}/barclays`);
    expect(h.listWorkspaces).toHaveBeenCalledWith("macbook-air");
  });

  it.each(["barclays", `${remoteRoot}/barclays`])("does not substitute controller root when hello omitted it: %s", async requested => {
    const h = fixture(null);
    const result = await h.plan.prepareRepoChange("macbook-air", requested);
    expect(result).toEqual({ ok: false, error: "Host `macbook-air` did not report a workspace root." });
    expect(h.hostExec).not.toHaveBeenCalled();
    expect(h.listWorkspaces).not.toHaveBeenCalled();
  });

  it("preserves the existing controller-local fallback", async () => {
    const h = fixture();
    expect(await h.plan.resolveRequestedRepoPath("local", "new-repo")).toBe("/home/ubuntu/Projects/new-repo");
  });

  it.each(["discord", "google-chat"] as const)("reports the disconnected bridge for a pinned %s repo change", async platform => {
    const h = fixture();
    const channel = { platform, id: "existing-session" };
    h.config.threadPresets.set(channel.id, { location: "macbook-air" });
    const record = h.router.ensureSessionRecord({ platform, channelRef: channel.id, cwd: `${remoteRoot}/barclays` });
    expect(h.router.describeConfig(record).location.value).toBe("macbook-air");
    vi.spyOn(h.bridgeHub, "get").mockReturnValue(undefined);
    const before = h.store.get(record.id);
    const result = await h.plan.applyRepoChange(channel, record, `${remoteRoot}/other`, { id: "operator", name: "Operator" });
    expect(result).toEqual({ ok: false, error: 'bridge "macbook-air" is not connected' });
    expect(h.store.get(record.id)).toEqual(before);
    expect(h.hostExec).not.toHaveBeenCalled();
    expect(h.listWorkspaces).not.toHaveBeenCalled();
  });
});
