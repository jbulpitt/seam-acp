import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { ApplicationCommandOptionType } from "discord.js";
import type { Plugin, PluginContext } from "../types.js";
import type { SessionBrowserFacade } from "../../core/session-browser.js";
import { createBrowser, routeView, type BrowserState } from "./view.js";

const navigation = new Set(["prev", "next", "close", "summary_back", "delete_cancel", "repair_cancel", "migrate_cancel"]);
export function browserAccess(customId: string): "read-only" | "mutating" {
  const action = customId.split(":")[1];
  return navigation.has(action!) || action === "import_cwd_modal" ? "read-only" : "mutating";
}

export function sessionBrowserPlugin(ports: SessionBrowserFacade): Plugin {
  let context: PluginContext;
  let file: string;
  const states = new Map<string, BrowserState>();
  const controllers = new Map<string, ReturnType<typeof createBrowser>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const expiryWork = new Set<Promise<void>>();
  let stopped = true;

  const persist = () => {
    for (const [id, state] of states) {
      if (!state.closed || Object.keys(state.imports).length) continue;
      states.delete(id); controllers.delete(id);
      clearTimeout(timers.get(id)); timers.delete(id);
    }
    fs.writeFileSync(file, JSON.stringify([...states.values()]));
    if (!stopped) for (const state of states.values()) arm(state);
  };
  const controller = (state: BrowserState) => {
    let browser = controllers.get(state.id);
    if (!browser) {
      browser = createBrowser(ports, ports.resume(state.context), state,
        ports.reply(state.target, state.owner, state.channelId), persist, context.logger);
      controllers.set(state.id, browser);
    }
    return browser;
  };
  const arm = (state: BrowserState) => {
    clearTimeout(timers.get(state.id));
    const deadlines = Object.values(state.imports).map(pending => pending.expires);
    if (!state.closed) deadlines.push(state.expires);
    if (!deadlines.length) return;
    const deadline = Math.min(...deadlines);
    const timer = setTimeout(() => {
      timers.delete(state.id);
      const work = ports.track((async () => {
        const now = Date.now();
        for (const [id, pending] of Object.entries(state.imports)) if (pending.expires <= now) delete state.imports[id];
        if (!state.closed && state.expires <= now) await controller(state).expire();
        persist();
      })());
      expiryWork.add(work);
      void work.catch(err => context.logger.warn({ err }, "session browser expiry failed"))
        .finally(() => expiryWork.delete(work));
    }, Math.max(0, deadline - Date.now()));
    timer.unref(); timers.set(state.id, timer);
  };
  const stop = () => { stopped = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); };

  return {
    id: "session-browser", apiVersion: 1, builtin: true, internal: true,
    activate: ctx => {
      context = ctx; file = ctx.storage!.path("browsers.json");
      if (fs.existsSync(file)) for (const state of JSON.parse(fs.readFileSync(file, "utf8")) as BrowserState[]) states.set(state.id, state);
    },
    dispose: stop,
    contributions: {
      slash: [{
        command: "seam", group: { name: "info", description: "Bot & account info" },
        acknowledgement: "ephemeral", leaf: { type: ApplicationCommandOptionType.Subcommand, name: "sessions", description: "List recent sessions" },
        access: { kind: "read-only" }, authorization: "user", help: "`/seam info sessions` — browse & manage backend sessions.",
        handle: async invocation => {
          const opened = await ports.open(invocation);
          if (!opened) return;
          const { actions, reply } = opened;
          let sessions;
          try { sessions = await actions.list(); }
          catch (err) { await reply.editReply({ content: `Failed to list sessions: ${(err as Error).message}` }); return; }
          const active = sessions.findIndex(session => session.sessionId === actions.info.acpSessionId);
          const state: BrowserState = {
            id: randomUUID(), owner: invocation.actor.id, channelId: invocation.threadId,
            expires: Date.now() + 600_000, closed: false, context: actions.snapshot(), target: "",
            sessions, currentIndex: Math.max(0, active), imports: {},
          };
          await ports.collectParked(reply, actions.info.id);
          states.set(state.id, state);
          const browser = createBrowser(ports, actions, state, reply, persist, context.logger);
          controllers.set(state.id, browser);
          await browser.render();
          state.expires = Date.now() + 600_000;
          persist();
        },
      }],
      components: [{
        namespace: "sessions:", types: ["button", "select", "modal"], lifetime: "persistent",
        access: browserAccess, authorization: "user",
        acknowledgement: evt => evt.kind === "button" && evt.customId.startsWith("sessions:import_to_cwd:") ? "modal" : "update",
        handle: async event => {
          const split = event.customId.lastIndexOf(":");
          const state = states.get(event.customId.slice(split + 1));
          if (!state || state.owner !== event.userId) return;
          const customId = event.customId.slice(0, split);
          const pending = event.kind === "modal" ? state.imports[customId.split(":")[2]!] : undefined;
          if (event.kind === "modal" && (!pending || pending.expires <= Date.now())) return;
          const browser = controller(state);
          if (event.kind !== "modal" && (state.closed || state.expires <= Date.now())) {
             await browser.expire(); return;
          }
          const click = ports.click({ ...event, customId });
          try {
            await browser.handle({ ...click, editReply: async view => {
              browser.checkpoint(); await click.editReply(routeView(view, state.id)); browser.checkpoint();
            } });
          } finally { browser.checkpoint(); }
        },
      }],
      jobs: [{ name: "browser-expiry", phase: "after-admission", intervalMs: 600_000,
        start: () => { stopped = false; for (const state of states.values()) arm(state); },
        stop, drain: async () => { await Promise.allSettled([...expiryWork]); } }],
    },
  };
}
