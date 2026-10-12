import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Config } from "../../config.js";
import { normalizeLocation, parseAgentAtLocation } from "../../core/location.js";
import { normalizeStoredEffort } from "../../core/runtime-transition.js";
import type { ConfigApplyPlan } from "../../core/config-apply-plan.js";
import type { ModelCatalogService } from "../../core/model-catalog/service.js";
import type { SessionRouter } from "../../core/session-router.js";
import type { SessionStore } from "../../core/session-store.js";
import type { ConfigMutationService, MutationActor } from "../../core/config-mutation.js";
import type { SessionRecord } from "../../core/types.js";
import type { GoogleChatSpaceCreationReceipt, GoogleChatSpaceSelection, InboundCommandResult } from "../../core/inbound-admission/types.js";
import type { ChannelRef } from "../chat-adapter.js";
import { googleErrorStatus, type GoogleApi, type GoogleRequest } from "./api.js";
import { parseGoogleChatNewArgs } from "./commands.js";
import type { GoogleChatSpaceEvents } from "./space-events.js";
import type { SpaceWriteQueue } from "./write-queue.js";

type OrgConfig = Pick<Config, "DEFAULT_AGENT" | "REPOS_ROOT" | "GOOGLE_CHAT_DEFAULT_AGENT"
  | "GOOGLE_CHAT_DEFAULT_LOCATION" | "GOOGLE_CHAT_DEFAULT_MODEL" | "GOOGLE_CHAT_DEFAULT_EFFORT" | "GOOGLE_CHAT_DEFAULT_CWD">;
type Space = NonNullable<GoogleChatSpaceCreationReceipt["space"]>;
const root = "https://chat.googleapis.com/v1";
const platform = "google-chat";

/** The one deployment/customer default, independent of person or origin. */
export function resolveGoogleChatOrgDefaults(config: OrgConfig): GoogleChatSpaceSelection {
  const parsed = parseAgentAtLocation(config.GOOGLE_CHAT_DEFAULT_AGENT ?? config.DEFAULT_AGENT);
  return { agentId: parsed.agentId,
    location: parsed.explicit ? parsed.location : normalizeLocation(config.GOOGLE_CHAT_DEFAULT_LOCATION),
    model: config.GOOGLE_CHAT_DEFAULT_MODEL ?? "default", effort: config.GOOGLE_CHAT_DEFAULT_EFFORT ?? "auto",
    repo: config.GOOGLE_CHAT_DEFAULT_CWD ?? config.REPOS_ROOT };
}

/** Use the catalog and host repo operation already used by core configuration. */
export async function prepareGoogleChatSpaceSelection(selection: GoogleChatSpaceSelection, deps: {
  router: Pick<SessionRouter, "getProfile"> & Partial<Pick<SessionRouter, "unregisteredAgentMessage">>;
  modelCatalog: Pick<ModelCatalogService, "resolve">;
  configPlan: Pick<ConfigApplyPlan, "prepareRepoChange">;
  defaultCwd: string;
}): Promise<GoogleChatSpaceSelection> {
  if (!deps.router.getProfile(selection.agentId, selection.location)) {
    const fallback = `Unknown agent \`${selection.agentId}\`.`;
    throw new Error(deps.router.unregisteredAgentMessage?.(selection.agentId, fallback) ?? fallback);
  }
  const selected = deps.modelCatalog.resolve({ agentId: selection.agentId, location: selection.location },
    { model: selection.model, effort: normalizeStoredEffort(selection.effort) });
  const repo = await deps.configPlan.prepareRepoChange(selection.location, selection.repo);
  if (!repo.ok) throw new Error(repo.error);
  return { ...selection, model: selected.normalized.model, effort: selected.normalized.effort || "auto",
    repo: repo.cwd ?? deps.defaultCwd };
}

/** Persist the snapshot on the Space root without starting or replacing ACP. */
export function bindGoogleChatSessionSpace(channel: ChannelRef, snapshot: GoogleChatSpaceSelection, deps: {
  store: Pick<SessionStore, "getByChannel">;
  router: Pick<SessionRouter, "ensureSessionRecord" | "bindRecordLocation">;
  mutation: Pick<ConfigMutationService, "applyThreadOverlay">;
}, actor: MutationActor): SessionRecord {
  const prior = deps.store.getByChannel(platform, channel.id);
  if (prior) return prior;
  const applied = deps.mutation.applyThreadOverlay({ threadId: channel.id, platform,
    changes: { agent: snapshot.agentId, location: snapshot.location, model: snapshot.model,
      effort: snapshot.effort, cwd: snapshot.repo }, actor });
  if (!applied.ok) throw new Error(applied.error);
  const record = deps.router.ensureSessionRecord({ platform, channelRef: channel.id, cwd: snapshot.repo });
  deps.router.bindRecordLocation(record);
  return record;
}

export interface GoogleChatSpaceLaunch {
  messageId: string;
  origin: ChannelRef;
  requester: { id: string; name: string };
  args: string;
}

export interface GoogleChatSessionSpaceResult {
  channel: ChannelRef;
  space: Space;
  snapshot: GoogleChatSpaceSelection;
  sessionRecordId: string;
}

/** Setup primitive; the adapter's ingress switch is wired separately. */
export class GoogleChatSessionSpaces {
  private readonly pending = new Map<string, Promise<GoogleChatSessionSpaceResult>>();

  constructor(private readonly opts: {
    config: OrgConfig;
    customer?: string;
    api: GoogleApi;
    store: Pick<SessionStore, "admitInbound" | "getInbound" | "claimInbound"
      | "saveInboundCommandProgress" | "completeInboundCommand" | "googleChatSpaces">;
    writes: Pick<SpaceWriteQueue, "enqueue">;
    spaceEvents: Pick<GoogleChatSpaceEvents, "register">;
    prepare: (snapshot: GoogleChatSpaceSelection) => Promise<GoogleChatSpaceSelection>;
    bind: (channel: ChannelRef, snapshot: GoogleChatSpaceSelection, actor: MutationActor) => SessionRecord | Promise<SessionRecord>;
    logger: Logger;
  }) {}

  create(input: GoogleChatSpaceLaunch): Promise<GoogleChatSessionSpaceResult> {
    const prior = this.pending.get(input.messageId);
    if (prior) return prior;
    const run = this.setup(input);
    this.pending.set(input.messageId, run);
    const clear = () => { if (this.pending.get(input.messageId) === run) this.pending.delete(input.messageId); };
    void run.then(clear, clear);
    return run;
  }

  private async setup(input: GoogleChatSpaceLaunch): Promise<GoogleChatSessionSpaceResult> {
    const { store } = this.opts;
    let row = store.getInbound(input.messageId);
    if (!row) {
      const { name, overrides } = parseGoogleChatNewArgs(input.args);
      const snapshot = resolveGoogleChatOrgDefaults(this.opts.config);
      if (overrides.agent !== undefined) {
        const parsed = parseAgentAtLocation(overrides.agent);
        snapshot.agentId = parsed.agentId;
        if (parsed.explicit) snapshot.location = parsed.location;
      }
      if (overrides.model !== undefined) snapshot.model = overrides.model;
      if (overrides.effort !== undefined) snapshot.effort = overrides.effort;
      if (overrides.repo !== undefined) snapshot.repo = overrides.repo;
      const receipt: InboundCommandResult = { replies: [], spaceCreation: {
        requestId: randomUUID(), customer: this.opts.customer ?? "customers/my_customer",
        displayName: [...name].slice(0, 128).join(""), requester: { ...input.requester }, snapshot,
      } };
      const now = new Date().toISOString();
      store.admitInbound({ messageId: input.messageId, platform, channelRef: input.origin.id,
        parentRef: input.origin.parentId, sessionRecordId: `${platform}:${input.origin.id}`,
        authorId: input.requester.id.replace(/^users\//, ""), authorName: input.requester.name,
        text: `/new ${input.args}`.trim(), createdUtc: now, preemptive: false, commandResult: receipt });
      row = store.getInbound(input.messageId);
    }
    const receipt = row?.commandResult;
    const setup = receipt?.spaceCreation;
    if (!setup) throw new Error(`Google Chat Space command ${input.messageId} has no creation receipt`);
    if (row!.state === "completed" && setup.space && setup.sessionRecordId) return this.result(setup);
    if (row!.state === "pending") store.claimInbound(input.messageId, 0, new Date().toISOString());
    const checkpoint = () => {
      if (!store.saveInboundCommandProgress(input.messageId, receipt!, new Date().toISOString())) {
        throw new Error(`Google Chat Space command ${input.messageId} no longer owns its setup receipt`);
      }
    };
    const write = <T>(scope: "spaces" | "memberships", request: GoogleRequest) =>
      this.opts.writes.enqueue(setup.space!.name, () => this.opts.api.request<T>(scope, request));

    try {
      if (!setup.prepared) {
        setup.snapshot = await this.opts.prepare(setup.snapshot);
        setup.prepared = true; checkpoint();
      }
      if (!setup.space) {
        const space = await this.opts.api.request<Space>("spaces", { method: "POST", url: `${root}/spaces`,
          params: { requestId: setup.requestId }, data: { spaceType: "SPACE", displayName: setup.displayName, customer: setup.customer } });
        setup.space = space; checkpoint();
      }
      // A requestId replay can return only the assigned name, without spaceUri.
      if (!setup.space.spaceUri) {
        setup.space = { ...setup.space, ...await this.opts.api.request<Space>("spaces",
          { method: "GET", url: `${root}/${setup.space.name}` }) };
        checkpoint();
      }
      const space = setup.space;
      const prior = store.googleChatSpaces.get(space.name);
      store.googleChatSpaces.put({ ...prior, space: { ...prior?.space, ...space, name: space.name } });
      if (!setup.membershipName) {
        const requester = setup.requester.id.startsWith("users/") ? setup.requester.id : `users/${setup.requester.id}`;
        let membership: { name: string };
        try {
          membership = await write<{ name: string }>("memberships", { method: "POST", url: `${root}/${space.name}/members`,
            data: { member: { name: requester, type: "HUMAN" } } });
        } catch (err) {
          if (googleErrorStatus(err) !== 409) throw err;
          membership = await this.opts.api.request("memberships", { method: "GET",
            url: `${root}/${space.name}/members/${encodeURIComponent(requester.slice("users/".length))}` });
        }
        setup.membershipName = membership.name; checkpoint();
      }
      if (!setup.managerPromoted) {
        await write("memberships", { method: "PATCH", url: `${root}/${setup.membershipName}`,
          params: { updateMask: "role" }, data: { role: "ROLE_MANAGER" } });
        setup.managerPromoted = true; checkpoint();
      }
      if (!setup.appsLocked) {
        await write("spaces", { method: "PATCH", url: `${root}/${space.name}`,
          params: { updateMask: "permissionSettings.manageApps" },
          data: { permissionSettings: { manageApps: { managersAllowed: true, membersAllowed: false } } } });
        setup.appsLocked = true; checkpoint();
      }
      if (!setup.subscribed) {
        await this.opts.spaceEvents.register(space);
        setup.subscribed = true; checkpoint();
      }
      if (!setup.sessionRecordId) {
        const channel = { platform, id: space.name.slice("spaces/".length) };
        const record = await this.opts.bind(channel, setup.snapshot, setup.requester);
        setup.sessionRecordId = record.id; checkpoint();
      }
      if (!store.completeInboundCommand(input.messageId, receipt!, new Date().toISOString())) {
        throw new Error(`Google Chat Space command ${input.messageId} did not complete its setup receipt`);
      }
      return this.result(setup);
    } catch (err) {
      this.opts.logger.error({ err, messageId: input.messageId, space: setup.space?.name }, "Google Chat session Space setup failed");
      throw err;
    }
  }

  private result(receipt: GoogleChatSpaceCreationReceipt): GoogleChatSessionSpaceResult {
    return { channel: { platform, id: receipt.space!.name.slice("spaces/".length) }, space: receipt.space!,
      snapshot: receipt.snapshot, sessionRecordId: receipt.sessionRecordId! };
  }
}
