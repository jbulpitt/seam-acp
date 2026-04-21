import type {
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import path from "node:path";
import type { Logger } from "../../lib/logger.js";
import type { Config } from "../../config.js";
import type { Renderer } from "../renderer.js";
import type {
  ChatAdapter,
  ChannelRef,
  IncomingMessage,
  MessageRef,
} from "../chat-adapter.js";
import type { SessionStore } from "../../core/session-store.js";
import { SessionRouter } from "../../core/session-router.js";
import { TurnStatus, renderStatusPanel } from "../../core/status-panel.js";
import { resolveRepoPath } from "../../core/path-utils.js";
import { defaultSessionConfig } from "../../core/types.js";

const STATUS_EDIT_DEBOUNCE_MS = 1000;
const PLATFORM = "discord";

/**
 * Glues the Discord adapter, the SessionRouter, and the agent runtimes
 * together. Handles incoming thread messages and `/seam` slash commands.
 */
export class Orchestrator {
  private readonly logger: Logger;
  private readonly config: Config;
  private readonly adapter: ChatAdapter;
  private readonly router: SessionRouter;
  private readonly store: SessionStore;
  private readonly renderer: Renderer;

  constructor(opts: {
    logger: Logger;
    config: Config;
    adapter: ChatAdapter;
    router: SessionRouter;
    store: SessionStore;
    renderer: Renderer;
  }) {
    this.logger = opts.logger.child({ comp: "orchestrator" });
    this.config = opts.config;
    this.adapter = opts.adapter;
    this.router = opts.router;
    this.store = opts.store;
    this.renderer = opts.renderer;
  }

  install(): void {
    this.adapter.onMessage((msg) => this.handleIncomingMessage(msg));
  }

  // --- message turn ---

  private async handleIncomingMessage(msg: IncomingMessage): Promise<void> {
    const channel = msg.channel;
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });

    const cfg = this.store.readConfig(record);
    const repoDisplay = this.repoDisplay(record.repoPath);
    const status = new TurnStatus({
      model: cfg.model ?? this.config.DEFAULT_MODEL,
      repoDisplay,
    });

    const statusMsg = await this.adapter.sendMessage(
      channel,
      renderStatusPanel(this.renderer, status.toInput(), Date.now())
    );

    let lastEdit = 0;
    let lastRendered = "";
    const refresh = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastEdit < STATUS_EDIT_DEBOUNCE_MS) return;
      const text = renderStatusPanel(this.renderer, status.toInput(), now);
      if (text === lastRendered) return;
      lastRendered = text;
      lastEdit = now;
      try {
        await this.adapter.editMessage(statusMsg, text);
      } catch (err) {
        this.logger.warn({ err }, "status edit failed");
      }
    };

    // Heartbeat: tick the elapsed counter every second.
    const heartbeat = setInterval(() => {
      void refresh();
    }, 1000);

    let textBuffer = "";
    let flushTimer: NodeJS.Timeout | undefined;
    const flushChunks = async () => {
      if (!textBuffer) return;
      const chunks = this.renderer.chunk(textBuffer);
      textBuffer = "";
      for (const chunk of chunks) {
        await this.adapter.sendMessage(channel, chunk);
      }
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushChunks();
      }, 250);
    };

    try {
      const runtime = await this.router.getOrStartRuntime(record);
      runtime.onEvent(async (event) => {
        switch (event.kind) {
          case "agent-text":
            textBuffer += event.text;
            scheduleFlush();
            return;
          case "tool-start":
            status.setAction(`Tool: ${event.title ?? event.kindLabel ?? "…"}`);
            await refresh();
            return;
          case "tool-update":
            if (event.status === "completed" || event.status === "failed") {
              status.setAction("Working…");
            } else if (event.title) {
              status.setAction(`Tool: ${event.title}`);
            }
            await refresh();
            return;
          case "model-changed":
            status.setModel(event.modelId);
            await refresh();
            return;
          case "agent-thought":
          case "config-options":
          case "error":
            return;
        }
      });

      status.setAction("Thinking…");
      await refresh(true);

      const turnPromise = runtime.prompt(msg.text);
      const timeoutMs = this.config.TURN_TIMEOUT_SECONDS * 1000;
      const result = await raceWithTimeout(turnPromise, timeoutMs);

      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      await flushChunks();

      if (result === "timeout") {
        await runtime.cancel();
        status.setState("Timed out");
        status.setAction(`Exceeded ${this.config.TURN_TIMEOUT_SECONDS}s`);
      } else if (result.cancelled) {
        status.setState("Failed");
        status.setAction("Cancelled");
      } else {
        status.setState("Done");
        status.setAction(result.stopReason);
      }
    } catch (err) {
      this.logger.error({ err }, "turn failed");
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      await flushChunks();
      status.setState("Failed");
      const m = err instanceof Error ? err.message : String(err);
      status.setAction(this.renderer.trimShort(m, 120));
    } finally {
      clearInterval(heartbeat);
      await refresh(true);
    }
  }

  // --- slash commands ---

  async handleSlashInteraction(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const sub = interaction.options.getSubcommand(true);
    switch (sub) {
      case "new":
        return this.cmdNew(interaction);
      case "repo":
        return this.cmdRepo(interaction);
      case "model":
        return this.cmdModel(interaction);
      case "mode":
        return this.cmdMode(interaction);
      case "effort":
        return this.cmdEffort(interaction);
      case "abort":
        return this.cmdAbort(interaction);
      case "config":
        return this.cmdConfig(interaction);
      case "sessions":
        return this.cmdSessions(interaction);
      case "help":
        return this.cmdHelp(interaction);
      default:
        await interaction.reply({
          content: `Unknown subcommand: ${sub}`,
          ephemeral: true,
        });
    }
  }

  private async cmdNew(i: ChatInputCommandInteraction): Promise<void> {
    if (!this.adapter.createThread) {
      await i.reply({
        content: "This platform does not support creating threads.",
        ephemeral: true,
      });
      return;
    }
    const name = i.options.getString("name") ?? "seam";
    if (!i.channelId) {
      await i.reply({ content: "No channel.", ephemeral: true });
      return;
    }
    await i.deferReply({ ephemeral: true });
    const parent: ChannelRef = { platform: PLATFORM, id: i.channelId };
    const thread = await this.adapter.createThread(parent, name);
    await i.editReply(`Created thread <#${thread.id}>. Send a message there.`);
  }

  private async cmdRepo(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: "Use `/seam repo` from inside a thread.",
        ephemeral: true,
      });
      return;
    }
    const requested = i.options.getString("path", true);
    let resolved: string;
    try {
      resolved = resolveRepoPath(requested, this.config.REPOS_ROOT);
    } catch (err) {
      await i.reply({
        content: `Invalid path: ${(err as Error).message}`,
        ephemeral: true,
      });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    this.store.upsert({
      ...record,
      repoPath: resolved,
      updatedUtc: new Date().toISOString(),
    });
    // Force a fresh runtime against the new cwd.
    await this.router.invalidate(record.id);
    await i.reply({
      content: `Repo set to \`${this.repoDisplay(resolved)}\`. Next message starts a fresh session.`,
      ephemeral: true,
    });
  }

  private async cmdModel(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({ content: "Use inside a thread.", ephemeral: true });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const id = i.options.getString("id");
    if (!id) {
      const cfg = this.store.readConfig(record);
      await i.reply({
        content: `Current model: \`${cfg.model ?? this.config.DEFAULT_MODEL}\``,
        ephemeral: true,
      });
      return;
    }
    const cfg = this.store.readConfig(record);
    cfg.model = id;
    this.persistConfig(record, cfg);
    if (this.router.hasRuntime(record.id)) {
      try {
        const rt = await this.router.getOrStartRuntime(record);
        await rt.setModel(id);
        await i.reply({
          content: `Model set to \`${id}\` (live).`,
          ephemeral: true,
        });
        return;
      } catch (err) {
        this.logger.warn({ err }, "live model set failed; will apply next turn");
      }
    }
    await i.reply({
      content: `Model will be \`${id}\` on the next turn.`,
      ephemeral: true,
    });
  }

  private async cmdMode(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", ephemeral: true });
      return;
    }
    const id = i.options.getString("id", true);
    const cfg = this.store.readConfig(record);
    cfg.mode = id;
    this.persistConfig(record, cfg);
    if (this.router.hasRuntime(record.id)) {
      try {
        const rt = await this.router.getOrStartRuntime(record);
        await rt.setMode(id);
      } catch (err) {
        this.logger.warn({ err }, "live mode set failed");
      }
    }
    await i.reply({ content: `Mode set to \`${id}\`.`, ephemeral: true });
  }

  private async cmdEffort(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", ephemeral: true });
      return;
    }
    const level = i.options.getString("level", true);
    const cfg = this.store.readConfig(record);
    cfg.reasoningEffort = level;
    this.persistConfig(record, cfg);
    if (this.router.hasRuntime(record.id)) {
      try {
        const rt = await this.router.getOrStartRuntime(record);
        await rt.setConfigOption("reasoning_effort", level);
      } catch (err) {
        await i.reply({
          content: `Effort saved but agent rejected live update: ${(err as Error).message}`,
          ephemeral: true,
        });
        return;
      }
    }
    await i.reply({
      content: `Reasoning effort set to \`${level}\`.`,
      ephemeral: true,
    });
  }

  private async cmdAbort(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record || !this.router.hasRuntime(record.id)) {
      await i.reply({ content: "No active turn.", ephemeral: true });
      return;
    }
    const rt = await this.router.getOrStartRuntime(record);
    await rt.cancel();
    await i.reply({ content: "Cancelled.", ephemeral: true });
  }

  private async cmdConfig(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", ephemeral: true });
      return;
    }
    const cfg =
      this.store.readConfig(record) ?? defaultSessionConfig(this.config.DEFAULT_MODEL);
    await i.reply({
      content: this.renderer.codeBlock(JSON.stringify(cfg, null, 2), "json"),
      ephemeral: true,
    });
  }

  private async cmdSessions(i: ChatInputCommandInteraction): Promise<void> {
    const list = this.store.list();
    if (list.length === 0) {
      await i.reply({ content: "No sessions yet.", ephemeral: true });
      return;
    }
    const lines = list
      .slice(0, 20)
      .map(
        (r) =>
          `• ${r.platform}:${r.channelRef} → repo \`${this.repoDisplay(r.repoPath)}\` (agent: ${r.agentId})`
      );
    await i.reply({ content: lines.join("\n"), ephemeral: true });
  }

  private async cmdHelp(i: ChatInputCommandInteraction): Promise<void> {
    const lines = [
      "**seam-acp** — control the agent in this thread.",
      "",
      "`/seam new [name]` — create a new agent thread",
      "`/seam repo <path>` — set working repo (under REPOS_ROOT)",
      "`/seam model [id]` — get / set agent model",
      "`/seam mode <id>` — set agent operational mode",
      "`/seam effort <low|medium|high>` — reasoning effort",
      "`/seam abort` — cancel current turn",
      "`/seam config` — show session config JSON",
      "`/seam sessions` — list known sessions",
      "",
      "Free-form messages in a thread are sent to the agent.",
    ];
    await i.reply({ content: lines.join("\n"), ephemeral: true });
  }

  // --- helpers ---

  private channelRefFromInteraction(
    i: ChatInputCommandInteraction
  ): ChannelRef | undefined {
    if (!i.channelId) return undefined;
    const ch = i.channel;
    const parentId =
      ch && "parentId" in ch && typeof ch.parentId === "string"
        ? ch.parentId
        : undefined;
    return {
      platform: PLATFORM,
      id: i.channelId,
      ...(parentId ? { parentId } : {}),
    };
  }

  private recordFromInteraction(
    i: ChatInputCommandInteraction
  ): ReturnType<SessionRouter["ensureSessionRecord"]> | undefined {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) return undefined;
    return this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
  }

  private persistConfig(
    record: ReturnType<SessionRouter["ensureSessionRecord"]>,
    cfg: ReturnType<SessionStore["readConfig"]>
  ): void {
    this.store.upsert({
      ...record,
      configJson: this.store.writeConfig(cfg),
      updatedUtc: new Date().toISOString(),
    });
  }

  private repoDisplay(repoPath: string | null): string {
    if (!repoPath) return "(unset)";
    const root = path.resolve(this.config.REPOS_ROOT);
    const abs = path.resolve(repoPath);
    if (abs === root) return "/";
    if (abs.startsWith(root + path.sep)) {
      return abs.slice(root.length + 1);
    }
    return abs;
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Re-export for convenience.
export type { EmbedBuilder };
