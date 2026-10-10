import type { Logger } from "pino";
import { setTimeout as delay } from "node:timers/promises";
import type { GoogleApi } from "./api.js";
import { isSharedSpace, type GoogleChatSpace, type GoogleChatSpaceLifecycle } from "./spaces.js";
import { nextGoogleChatSubscriptionRenewalTime, type GoogleChatSpaceSubscription, type GoogleChatSpaceSubscriptions } from "./space-subscriptions.js";
import type { GoogleChatSpaceStore, StoredGoogleChatSpace } from "./space-store.js";

type Subscriptions = Pick<GoogleChatSpaceSubscriptions, "create" | "renew" | "delete" | "list">;
const root = "https://chat.googleapis.com/v1";
const initialRetryMs = 1000, maxRetryMs = 30_000;

/** Reconcile durable memberships independently of pulling, then renew from Google's expiry. */
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
    const signal = this.controller.signal;
    let retryMs = initialRetryMs;
    while (!signal.aborted) {
      try { await this.reconcile(signal); return; }
      catch (err) {
        if (signal.aborted) return;
        this.opts.logger.error({ err, retryMs }, "Google Chat Workspace reconciliation failed");
        try { await delay(retryMs, undefined, { signal }); } catch { return; }
        retryMs = Math.min(maxRetryMs, retryMs * 2);
      }
    }
  }

  private async reconcile(signal: AbortSignal): Promise<void> {
    const client = this.opts.subscriptions;
    const remote = await client.list(undefined, signal);
    signal.throwIfAborted();
    const members = new Map<string, GoogleChatSpace & { name: string }>();
    let pageToken: string | undefined;
    do {
      const page = await this.opts.api.request<{ spaces?: Array<GoogleChatSpace & { name: string }>; nextPageToken?: string }>("chat", {
        method: "GET", url: `${root}/spaces`, params: { ...(pageToken ? { pageToken } : {}) }, signal });
      signal.throwIfAborted();
      for (const space of page.spaces ?? []) if (this.allowed(space)) members.set(space.name, space);
      pageToken = page.nextPageToken;
    } while (pageToken);

    // A crash between the API effect and SQLite commit is repaired by list().
    const ours = remote.filter(sub => sub.notificationEndpoint.pubsubTopic === this.opts.pubsubTopic);
    for (const sub of ours) {
      const name = sub.targetResource.replace(/^\/\/chat.googleapis.com\//, "");
      if (!members.has(name)) await client.delete(sub.name, signal);
      signal.throwIfAborted();
    }
    for (const state of this.opts.store.list()) if (!members.has(state.space.name)) this.opts.store.delete(state.space.name);
    for (const [name, space] of members) {
      signal.throwIfAborted();
      const subscription = ours.find(sub => sub.targetResource === `//chat.googleapis.com/${name}`);
      this.opts.store.put({ ...this.opts.store.get(name), space, subscription });
      await this.serial(name, () => this.ensure(space, signal));
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

  private async ensure(space: GoogleChatSpace & { name: string }, signal = this.controller.signal): Promise<void> {
    signal.throwIfAborted();
    const client = this.opts.subscriptions;
    const prior = this.opts.store.get(space.name);
    const state: StoredGoogleChatSpace = { ...prior, space: { ...prior?.space, ...space } };
    if (state.subscription && Date.parse(state.subscription.expireTime) <= Date.now()) state.subscription = undefined;
    this.opts.store.put(state);
    if (!state.subscription) {
      const existing = await client.list(space.name, signal);
      signal.throwIfAborted();
      state.subscription = existing.find(sub => sub.notificationEndpoint.pubsubTopic === this.opts.pubsubTopic
        && Date.parse(sub.expireTime) > Date.now())
        ?? await client.create(space.name, { signal });
    }
    signal.throwIfAborted();
    this.saveAndArm(state, state.subscription);
  }

  private saveAndArm(state: StoredGoogleChatSpace, subscription: GoogleChatSpaceSubscription): void {
    this.opts.store.put({ ...state, appUser: this.opts.store.get(state.space.name)?.appUser ?? state.appUser, subscription });
    if (this.controller.signal.aborted) return;
    const renewAt = nextGoogleChatSubscriptionRenewalTime(subscription, this.opts.renewalLeadMs ?? 5 * 60_000);
    this.arm(state.space.name, renewAt);
    this.opts.logger.info({ space: state.space.name, subscription: subscription.name, expireTime: subscription.expireTime,
      renewAt: new Date(renewAt).toISOString() }, "Google Chat Workspace subscription renewal armed");
  }

  private arm(space: string, runAt: number, retryMs = initialRetryMs): void {
    this.disarm(space);
    if (this.controller.signal.aborted) return;
    const timer = setTimeout(() => {
      this.timers.delete(space);
      void this.serial(space, async () => {
        const current = this.opts.store.get(space);
        if (!current) return;
        if (!current.subscription || Date.parse(current.subscription.expireTime) <= Date.now()) {
          await this.ensure(current.space);
          return;
        }
        const renewed = await this.opts.subscriptions.renew(current.subscription.name, "0s", this.controller.signal);
        this.saveAndArm(current, renewed);
        this.opts.logger.info({ space, subscription: renewed.name, expireTime: renewed.expireTime },
          "Google Chat Workspace subscription renewed");
      }).catch(err => {
        if (this.controller.signal.aborted) return;
        const current = this.opts.store.get(space);
        const now = Date.now(), expiry = current?.subscription ? Date.parse(current.subscription.expireTime) : undefined;
        const retryAt = expiry !== undefined && expiry > now ? Math.min(now + retryMs, expiry) : now + retryMs;
        this.opts.logger.error({ err, space, subscription: current?.subscription?.name, retryAt: new Date(retryAt).toISOString() },
          "Google Chat Workspace subscription renewal failed");
        if (current) this.arm(space, retryAt, Math.min(maxRetryMs, retryMs * 2));
      });
    }, Math.max(0, runAt - Date.now()));
    timer.unref();
    this.timers.set(space, timer);
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
