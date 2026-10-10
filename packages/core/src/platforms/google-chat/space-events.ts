import type { Logger } from "pino";
import type { GoogleApi } from "./api.js";
import { isSharedSpace, type GoogleChatSpace, type GoogleChatSpaceLifecycle } from "./spaces.js";
import { nextGoogleChatSubscriptionRenewalTime, type GoogleChatSpaceSubscription, type GoogleChatSpaceSubscriptions } from "./space-subscriptions.js";
import type { GoogleChatSpaceStore, StoredGoogleChatSpace } from "./space-store.js";

type Subscriptions = Pick<GoogleChatSpaceSubscriptions, "create" | "renew" | "delete" | "list">;
const root = "https://chat.googleapis.com/v1";

/** Reconcile durable memberships before pulling, then renew from Google's expiry. */
export class GoogleChatSpaceEvents {
  private controller = new AbortController();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly opts: {
    api: GoogleApi;
    pubsubTopic: string;
    subscriptions: Subscriptions;
    store: GoogleChatSpaceStore;
    allowedSpaceIds?: ReadonlySet<string>;
    logger: Logger;
    renewalLeadMs?: number;
  }) {}

  space(name: string): GoogleChatSpace | undefined { return this.opts.store.get(name)?.space; }
  appUser(name: string): string | undefined { return this.opts.store.get(name)?.appUser; }

  recordAppUser(space: string, appUser: string): void {
    const state = this.opts.store.get(space);
    if (state) this.opts.store.put({ ...state, appUser });
  }

  private allowed(space: GoogleChatSpace): boolean {
    const ids = this.opts.allowedSpaceIds;
    return isSharedSpace(space) && !!space.name && (!ids?.size || ids.has(space.name) || ids.has(space.name.slice("spaces/".length)));
  }

  async start(): Promise<void> {
    if (this.controller.signal.aborted) this.controller = new AbortController();
    const client = this.opts.subscriptions;
    const remote = await client.list(undefined, this.controller.signal);
    const members = new Map<string, GoogleChatSpace & { name: string }>();
    let pageToken: string | undefined;
    do {
      const page = await this.opts.api.request<{ spaces?: Array<GoogleChatSpace & { name: string }>; nextPageToken?: string }>("chat", {
        method: "GET", url: `${root}/spaces`, params: { ...(pageToken ? { pageToken } : {}) }, signal: this.controller.signal });
      for (const space of page.spaces ?? []) if (this.allowed(space)) members.set(space.name, space);
      pageToken = page.nextPageToken;
    } while (pageToken);

    // A crash between the API effect and SQLite commit is repaired by list().
    const ours = remote.filter(sub => sub.notificationEndpoint.pubsubTopic === this.opts.pubsubTopic);
    for (const sub of ours) {
      const name = sub.targetResource.replace(/^\/\/chat.googleapis.com\//, "");
      if (!members.has(name)) await client.delete(sub.name, this.controller.signal);
    }
    for (const state of this.opts.store.list()) if (!members.has(state.space.name)) this.opts.store.delete(state.space.name);
    for (const [name, space] of members) {
      const subscription = ours.find(sub => sub.targetResource === `//chat.googleapis.com/${name}`);
      this.opts.store.put({ ...this.opts.store.get(name), space, subscription });
      await this.serial(name, () => this.ensure(space));
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.pending.values());
  }

  async handle(event: GoogleChatSpaceLifecycle): Promise<void> {
    const name = event.space.name;
    if (event.type === "ADDED_TO_SPACE" && !this.allowed(event.space)) return;
    await this.serial(name, async () => {
      if (event.type === "ADDED_TO_SPACE") await this.ensure(event.space);
      else {
        this.disarm(name);
        const client = this.opts.subscriptions;
        // Covers a create that reached Google but not the local commit.
        const subscriptions = await client.list(name, this.controller.signal);
        for (const sub of subscriptions) if (sub.notificationEndpoint.pubsubTopic === this.opts.pubsubTopic) {
          await client.delete(sub.name, this.controller.signal);
        }
        this.opts.store.delete(name);
      }
    });
  }

  private async ensure(space: GoogleChatSpace & { name: string }): Promise<void> {
    const client = this.opts.subscriptions;
    const prior = this.opts.store.get(space.name);
    const state: StoredGoogleChatSpace = { ...prior, space: { ...prior?.space, ...space } };
    this.opts.store.put(state);
    if (!state.subscription) {
      const existing = await client.list(space.name, this.controller.signal);
      state.subscription = existing.find(sub => sub.notificationEndpoint.pubsubTopic === this.opts.pubsubTopic)
        ?? await client.create(space.name, { signal: this.controller.signal });
    }
    this.saveAndArm(state, state.subscription);
  }

  private saveAndArm(state: StoredGoogleChatSpace, subscription: GoogleChatSpaceSubscription): void {
    this.opts.store.put({ ...state, appUser: this.opts.store.get(state.space.name)?.appUser ?? state.appUser, subscription });
    this.disarm(state.space.name);
    if (this.controller.signal.aborted) return;
    const renewAt = nextGoogleChatSubscriptionRenewalTime(subscription, this.opts.renewalLeadMs ?? 5 * 60_000);
    const timer = setTimeout(() => {
      this.timers.delete(state.space.name);
      void this.serial(state.space.name, async () => {
        const current = this.opts.store.get(state.space.name);
        if (!current?.subscription) return;
        const renewed = await this.opts.subscriptions.renew(current.subscription.name, "0s", this.controller.signal);
        this.saveAndArm(current, renewed);
        this.opts.logger.info({ space: state.space.name, subscription: renewed.name, expireTime: renewed.expireTime },
          "Google Chat Workspace subscription renewed");
      }).catch(err => {
        if (!this.controller.signal.aborted) this.opts.logger.error({ err, space: state.space.name, subscription: subscription.name },
          "Google Chat Workspace subscription renewal failed");
      });
    }, Math.max(0, renewAt - Date.now()));
    timer.unref();
    this.timers.set(state.space.name, timer);
    this.opts.logger.info({ space: state.space.name, subscription: subscription.name, expireTime: subscription.expireTime,
      renewAt: new Date(renewAt).toISOString() }, "Google Chat Workspace subscription renewal armed");
  }

  private disarm(space: string): void {
    clearTimeout(this.timers.get(space)); this.timers.delete(space);
  }

  private serial(space: string, work: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(space) ?? Promise.resolve();
    const next = previous.then(async () => { this.controller.signal.throwIfAborted(); await work(); },
      async () => { this.controller.signal.throwIfAborted(); await work(); });
    this.pending.set(space, next);
    const clear = () => { if (this.pending.get(space) === next) this.pending.delete(space); };
    void next.then(clear, clear);
    return next;
  }
}
