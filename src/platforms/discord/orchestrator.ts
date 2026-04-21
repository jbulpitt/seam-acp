import fs from "node:fs";
import path from "node:path";
import { MessageFlags, type ChatInputCommandInteraction, type EmbedBuilder } from "discord.js";
import type { Logger } from "../../lib/logger.js";
import type { Config } from "../../config.js";
import type { Renderer } from "../renderer.js";
import type {
  ChatAdapter,
  ChannelRef,
  IncomingMessage,
  MessageRef,
  ReactionEvent,
} from "../chat-adapter.js";
import type { SessionStore } from "../../core/session-store.js";
import { SessionRouter } from "../../core/session-router.js";
import { TurnStatus, renderStatusPanel } from "../../core/status-panel.js";
import { isWithinRoot, resolveRepoPath } from "../../core/path-utils.js";
import { splitForFlush, hasOpenFence } from "../../core/stream-flush.js";
import { detectFileBlocks } from "../../agents/code-block-detector.js";
import {
  defaultSessionConfig,
  type SessionConfigState,
} from "../../core/types.js";
import type { DiscordAdapter } from "./adapter.js";

const STATUS_EDIT_DEBOUNCE_MS = 2500;
const STATUS_HEARTBEAT_MS = 5000;
const PLATFORM = "discord";

const REPO_PICK_EMOJIS = [
  "1️⃣",
  "2️⃣",
  "3️⃣",
  "4️⃣",
  "5️⃣",
  "6️⃣",
  "7️⃣",
  "8️⃣",
  "9️⃣",
  "🔟",
] as const;

interface RepoPickerState {
  channel: ChannelRef;
  repoPaths: string[];
  createdAt: number;
}

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

  /** message-id → picker state (only owner can react). */
  private readonly repoPickers = new Map<string, RepoPickerState>();

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
    this.adapter.onReaction?.((event) => this.handleReaction(event));
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

    // Heartbeat: tick the elapsed counter periodically. Edits to the same
    // message are heavily rate-limited by Discord (~5/5s per message), and
    // those rate-limit waits also queue behind regular sends — so we keep
    // this conservative.
    const heartbeat = setInterval(() => {
      void refresh();
    }, STATUS_HEARTBEAT_MS);

    let textBuffer = "";
    let textSent = false;
    /**
     * Full assistant text accumulated this turn (before chunk-flushing).
     * Used after streaming ends to detect file-shaped fenced code blocks
     * and upload them as Discord attachments.
     */
    let fullTurnText = "";
    // Per-turn timing for diagnosing slow turns. Set when we send the
    // prompt; first-chunk + total recorded as info logs.
    let turnStartedAt = 0;
    let firstChunkAt: number | undefined;
    // Streaming policy: only flush mid-turn when we have a *substantial*
    // amount of buffered text AND a clean paragraph boundary exists.
    // Otherwise wait for end-of-turn — Discord rate-limits us hard if we
    // send one tiny message per paragraph (e.g. each verse of "99 bottles"
    // would be its own message).
    const HARD_MAX = 1800;
    const SOFT_MIN = 800;
    const drainBuffer = async (force: boolean) => {
      while (textBuffer) {
        const split = splitForFlush(textBuffer, {
          maxLen: HARD_MAX,
          softMin: SOFT_MIN,
          force,
        });
        if (!split) return;
        textBuffer = split.keep;
        if (split.send) {
          await this.adapter.sendMessage(channel, split.send);
          textSent = true;
        }
        if (!force) return;
      }
    };
    const flushChunks = async () => {
      await drainBuffer(true);
    };
    /**
     * Idle-flush timer: if text has been buffered for IDLE_FLUSH_MS
     * with no new chunks arriving, force-flush whatever's there. This
     * keeps UX responsive when the agent emits a slow trickle that
     * never crosses HARD_MAX or hits a clean paragraph boundary
     * (e.g. a short poem).
     */
    const IDLE_FLUSH_MS = 4000;
    // Hard ceiling: even inside an open fence, force-flush if the buffer
    // grows past this. Defends against runaway model loops (e.g. Copilot
    // spamming the language tag) without losing legitimate long fences.
    const FENCE_BUFFER_CEILING = 16000;
    let idleTimer: NodeJS.Timeout | undefined;
    const cancelFlushTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const armIdleFlush = () => {
      cancelFlushTimer();
      if (!textBuffer) return;
      // If we're mid-fence, hold off — splitting a fenced block across
      // messages renders badly. Turn-end flush will still post it.
      if (
        hasOpenFence(textBuffer) &&
        textBuffer.length < FENCE_BUFFER_CEILING
      ) {
        return;
      }
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (textBuffer) void drainBuffer(true);
      }, IDLE_FLUSH_MS);
    };
    const maybeFlush = () => {
      if (textBuffer.length >= HARD_MAX) {
        void drainBuffer(true);
        return;
      }
      void drainBuffer(false);
    };

    const RETRY_MARKER = "— 🔁 retried — output above may repeat —";
    const RETRY_REGEX = /response was interrupted.*retrying/i;
    let currentMessageId: string | undefined;
    let postedRetryNotice = false;
    // Runaway-loop detector: some agent models get stuck repeating the
    // same chunk — Copilot spams short language tags (e.g. "markdown"),
    // Gemini sometimes loops a full sentence. Cancel the turn once the
    // exact same trimmed chunk repeats. Threshold is lower for long
    // chunks (a repeated full sentence is much more obviously broken
    // than a repeated short token).
    const LOOP_THRESHOLD_SHORT = 12; // for chunks <= 40 chars
    const LOOP_THRESHOLD_LONG = 4; // for longer chunks
    const LOOP_SHORT_MAX = 40;
    let loopChunk: string | null = null;
    let loopCount = 0;
    let loopAborted = false;
    const noteRetry = async () => {
      if (postedRetryNotice) return;
      postedRetryNotice = true;
      // Flush whatever we already buffered from the failed attempt first.
      await flushChunks();
      try {
        await this.adapter.sendMessage(channel, RETRY_MARKER);
      } catch (err) {
        this.logger.warn({ err }, "retry notice send failed");
      }
    };

    try {
      const runtime = await this.router.getOrStartRuntime(record);
      runtime.onEvent(async (event) => {
        switch (event.kind) {
          case "agent-text": {
            // Detect Copilot CLI retry: either the agent emits a "Retrying"
            // sentinel, or the messageId rolls over mid-turn.
            const isRetrySentinel = RETRY_REGEX.test(event.text);
            const isNewMessage =
              event.messageId !== undefined &&
              currentMessageId !== undefined &&
              event.messageId !== currentMessageId;
            if (isRetrySentinel || isNewMessage) {
              await noteRetry();
              postedRetryNotice = false; // allow future retries to notify again
            }
            if (event.messageId) currentMessageId = event.messageId;
            // Runaway-loop check (cheap; runs before buffering).
            if (!loopAborted) {
              const trimmed = event.text.trim();
              if (trimmed) {
                if (trimmed === loopChunk) {
                  loopCount += 1;
                } else {
                  loopChunk = trimmed;
                  loopCount = 1;
                }
              } else {
                // pure-whitespace chunks don't reset the run (a trickle
                // of newlines between repeats is still a loop) but
                // don't count toward it either.
              }
              const threshold =
                loopChunk && loopChunk.length <= LOOP_SHORT_MAX
                  ? LOOP_THRESHOLD_SHORT
                  : LOOP_THRESHOLD_LONG;
              if (loopChunk && loopCount >= threshold) {
                loopAborted = true;
                this.logger.warn(
                  {
                    session: record.id,
                    chunkLen: loopChunk.length,
                    chunkPreview: loopChunk.slice(0, 80),
                    repeats: loopCount,
                  },
                  "runaway chunk loop detected; cancelling turn"
                );
                try {
                  await runtime.cancel();
                } catch (err) {
                  this.logger.warn({ err }, "cancel after loop failed");
                }
                try {
                  await flushChunks();
                  const preview =
                    loopChunk.length > 80
                      ? `${loopChunk.slice(0, 77)}...`
                      : loopChunk;
                  await this.adapter.sendMessage(
                    channel,
                    `⚠️ Agent got stuck repeating the same output (\`${preview}\`) — turn cancelled. Try rephrasing.`
                  );
                  textSent = true;
                } catch (err) {
                  this.logger.warn({ err }, "loop notice send failed");
                }
                return;
              }
            }
            textBuffer += event.text;
            fullTurnText += event.text;
            maybeFlush();
            armIdleFlush();
            // Track time-to-first-chunk so we can tell whether the
            // agent or the orchestrator is responsible for slow turns.
            if (firstChunkAt === undefined) {
              firstChunkAt = Date.now();
              this.logger.info(
                {
                  ttftMs: firstChunkAt - turnStartedAt,
                  session: record.id,
                },
                "agent first text chunk"
              );
            }
            return;
          }
          case "tool-start": {
            const label = event.title ?? event.kindLabel ?? "…";
            status.setAction(`Tool: ${label}`);
            status.pushActivity(label);
            await refresh();
            return;
          }
          case "tool-update":
            if (event.status === "completed" || event.status === "failed") {
              status.setAction("Working…");
            } else if (event.title) {
              status.setAction(`Tool: ${event.title}`);
              status.pushActivity(event.title);
            }
            await refresh();
            return;
          case "model-changed":
            status.setModel(event.modelId);
            await refresh();
            return;
          case "agent-file": {
            // Flush pending text first so the file shows up after the
            // assistant's narration in the thread.
            await flushChunks();
            try {
              await this.sendAgentFile(channel, event);
              textSent = true;
            } catch (err) {
              this.logger.warn(
                { err, filename: event.filename },
                "sendFile failed; falling back to text notice"
              );
              await this.adapter.sendMessage(
                channel,
                `_Agent produced a file (\`${event.filename}\`) but it couldn't be uploaded._`
              );
            }
            return;
          }
          case "agent-thought":
          case "config-options":
          case "error":
            return;
        }
      });

      status.setAction("Thinking…");
      await refresh(true);

      const turnPromise = runtime.prompt(msg.text, msg.attachments);
      turnStartedAt = Date.now();
      const timeoutMs = this.config.TURN_TIMEOUT_SECONDS * 1000;
      const result = await raceWithTimeout(turnPromise, timeoutMs);

      cancelFlushTimer();
      await flushChunks();
      this.logger.info(
        {
          session: record.id,
          totalMs: Date.now() - turnStartedAt,
          ttftMs:
            firstChunkAt !== undefined ? firstChunkAt - turnStartedAt : null,
          chars: fullTurnText.length,
        },
        "turn timing"
      );
      // After all text has been flushed, scan it for file-shaped fenced
      // code blocks (markdown docs, JSON configs, scripts, etc.) and
      // upload each as a Discord attachment.
      await this.uploadDetectedCodeBlocks(channel, fullTurnText);

      if (
        result !== "timeout" &&
        result.rejectedAttachments &&
        result.rejectedAttachments.length > 0
      ) {
        const lines = result.rejectedAttachments
          .map((r) => `• \`${r.filename}\` — ${r.reason}`)
          .join("\n");
        await this.adapter.sendMessage(
          channel,
          `_Some attachments were not sent to the agent:_\n${lines}`
        );
      }

      if (!textSent && result !== "timeout" && !(result as { cancelled?: boolean }).cancelled) {
        // Turn completed but the agent produced no visible text (e.g. tools ran
        // but emitted no assistant message). Make it visible so the user isn't
        // left wondering if their message was received.
        await this.adapter.sendMessage(channel, "_Agent completed with no text response._");
      }

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
      cancelFlushTimer();
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
      case "reset":
        return this.cmdReset(interaction);
      case "tools":
        return this.cmdTools(interaction);
      case "config":
        return this.cmdConfig(interaction);
      case "config-set":
        return this.cmdConfigSet(interaction);
      case "sessions":
        return this.cmdSessions(interaction);
      case "repos":
        return this.cmdRepos(interaction);
      case "init":
        return this.cmdInit(interaction);
      case "approve":
        return this.cmdApprove(interaction);
      case "agent":
        return this.cmdAgent(interaction);
      case "avatar":
        return this.cmdAvatar(interaction);
      case "help":
        return this.cmdHelp(interaction);
      default:
        await interaction.reply({
          content: `Unknown subcommand: ${sub}`,
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  private async cmdNew(i: ChatInputCommandInteraction): Promise<void> {
    if (!this.adapter.createThread) {
      await i.reply({
        content: "This platform does not support creating threads.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const name = i.options.getString("name") ?? "seam";
    if (!i.channelId) {
      await i.reply({ content: "No channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const parent: ChannelRef = { platform: PLATFORM, id: i.channelId };
    const thread = await this.adapter.createThread(parent, name);
    await i.editReply(`Created thread <#${thread.id}>. Send a message there.`);
  }

  private async cmdRepo(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: "Use `/seam repo` from inside a thread.",
        flags: MessageFlags.Ephemeral,
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
        flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdModel(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
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
      const current = cfg.model ?? this.config.DEFAULT_MODEL;
      let availableLine = "";
      if (this.router.hasRuntime(record.id)) {
        try {
          const rt = await this.router.getOrStartRuntime(record);
          const info = rt.getSessionInfo();
          const models = info?.availableModels ?? [];
          if (models.length > 0) {
            availableLine =
              "\nAvailable: " +
              models
                .map((m) => `\`${m.modelId}\`${m.name ? ` (${m.name})` : ""}`)
                .join(", ");
          }
        } catch (err) {
          this.logger.warn({ err }, "could not enumerate available models");
        }
      } else {
        availableLine =
          "\n_(send a message in this thread first to populate the available-models list from the agent.)_";
      }
      await i.reply({
        content: `Current model: \`${current}\`${availableLine}`,
        flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
        });
        return;
      } catch (err) {
        this.logger.warn({ err }, "live model set failed; will apply next turn");
      }
    }
    await i.reply({
      content: `Model will be \`${id}\` on the next turn.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdMode(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
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
    await i.reply({ content: `Mode set to \`${id}\`.`, flags: MessageFlags.Ephemeral });
  }

  private async cmdEffort(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
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
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    await i.reply({
      content: `Reasoning effort set to \`${level}\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdAbort(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record || !this.router.hasRuntime(record.id)) {
      await i.reply({ content: "No active turn.", flags: MessageFlags.Ephemeral });
      return;
    }
    const rt = await this.router.getOrStartRuntime(record);
    await rt.cancel();
    await i.reply({ content: "Cancelled.", flags: MessageFlags.Ephemeral });
  }

  private async cmdReset(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({
        content: "Use inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Stop the live runtime (if any) so any in-flight turn is killed.
    await this.router.invalidate(record.id);
    // Clear the persisted ACP session id so the next message creates a
    // fresh session (which picks up any new MCP servers / config).
    this.store.upsert({
      ...record,
      acpSessionId: "",
      updatedUtc: new Date().toISOString(),
    });
    await i.reply({
      content:
        "Session reset. Your next message will start a fresh ACP session (history is gone, but config is kept).",
      flags: MessageFlags.Ephemeral,
    });
  }

  /**
   * `/seam agent` — show or change the agent bound to this thread.
   *
   * Changing agents mid-thread is destructive: the old agent's
   * conversation history can't be replayed against a different CLI, so
   * we invalidate the live runtime and clear the stored ACP session id
   * (same as `/seam reset`). The new agent's `defaultModel` is applied
   * to the session config so the first turn uses something sensible.
   */
  private async cmdAgent(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({
        content: "Use inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const id = i.options.getString("id");
    const profiles = this.router.listProfiles();
    const listing = profiles
      .map((p) => `\`${p.id}\` — ${p.displayName}`)
      .join(", ");
    if (!id) {
      await i.reply({
        content: `Current agent: \`${record.agentId}\`\nAvailable: ${listing}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const profile = this.router.getProfile(id);
    if (!profile) {
      await i.reply({
        content: `Unknown agent \`${id}\`. Available: ${listing}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (record.agentId === id) {
      await i.reply({
        content: `Agent is already \`${id}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Kill the live runtime (ends any in-flight turn) and wipe the ACP
    // session id so the next message spawns the new agent fresh.
    await this.router.invalidate(record.id);
    const cfg = this.store.readConfig(record);
    cfg.model = profile.defaultModel;
    this.persistConfig(record, cfg);
    this.store.upsert({
      ...record,
      agentId: id,
      acpSessionId: "",
      updatedUtc: new Date().toISOString(),
    });
    await i.reply({
      content: `Agent switched to \`${id}\` (${profile.displayName}), model \`${profile.defaultModel}\`. Next message will start a fresh session.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdConfig(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const cfg =
      this.store.readConfig(record) ?? defaultSessionConfig(this.config.DEFAULT_MODEL);
    await i.reply({
      content: this.renderer.codeBlock(JSON.stringify(cfg, null, 2), "json"),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdSessions(i: ChatInputCommandInteraction): Promise<void> {
    const list = this.store.list();
    if (list.length === 0) {
      await i.reply({ content: "No sessions yet.", flags: MessageFlags.Ephemeral });
      return;
    }
    const lines = list
      .slice(0, 20)
      .map(
        (r) =>
          `• ${r.platform}:${r.channelRef} → repo \`${this.repoDisplay(r.repoPath)}\` (agent: ${r.agentId})`
      );
    await i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
  }

  private async cmdTools(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const action = i.options.getString("action", true);
    const list = parseCsv(i.options.getString("list") ?? "");
    const cfg = this.store.readConfig(record);
    if (action === "allow") cfg.availableTools = list;
    else if (action === "exclude") cfg.excludedTools = list;
    this.persistConfig(record, cfg);
    await this.router.invalidate(record.id);
    await i.reply({
      content: `Tool ${action} list: ${list.length === 0 ? "(cleared)" : "`" + list.join(", ") + "`"}. Next turn starts a fresh runtime.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdConfigSet(
    i: ChatInputCommandInteraction
  ): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const json = i.options.getString("json", true);
    let cfg: SessionConfigState;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      cfg = parsed as SessionConfigState;
    } catch (err) {
      await i.reply({
        content: `Invalid JSON: ${(err as Error).message}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!cfg.model) cfg.model = this.config.DEFAULT_MODEL;
    this.persistConfig(record, cfg);
    await this.router.invalidate(record.id);
    await i.reply({
      content: "Config replaced; next turn starts a fresh runtime.",
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdRepos(i: ChatInputCommandInteraction): Promise<void> {
    const dirs = this.listRepoDirs();
    if (!dirs) {
      await i.reply({
        content: `REPOS_ROOT not found: \`${this.config.REPOS_ROOT}\``,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (dirs.length === 0) {
      await i.reply({
        content: `No repos under \`${this.config.REPOS_ROOT}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = dirs.slice(0, 50).map((d) => `- ${path.basename(d)}`);
    await i.reply({
      content: `**Repos**\n${this.renderer.codeBlock(lines.join("\n"))}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdInit(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: "Use `/seam init` inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    await i.reply({
      content: "Session ready. Pick a repo to begin:",
      flags: MessageFlags.Ephemeral,
    });
    await this.sendRepoPicker(channel);
  }

  private async cmdApprove(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const policy = i.options.getString("policy", true) as
      | "always"
      | "ask"
      | "deny";
    const cfg = this.store.readConfig(record);
    cfg.permissionPolicy = policy;
    // Drop the deprecated field so it can never override the new value.
    delete cfg.autoApprovePermissions;
    this.persistConfig(record, cfg);
    const messages: Record<typeof policy, string> = {
      always:
        "Approval policy set to `always`. ⚠️ The agent will auto-approve every permission request (shell exec, file writes, network, etc.).",
      ask:
        "Approval policy set to `ask`. The bot will post a Discord prompt for each permission request and auto-deny after 5 minutes.",
      deny:
        "Approval policy set to `deny`. The agent will be auto-denied every permission request — useful for read-only sessions.",
    };
    await i.reply({ content: messages[policy], flags: MessageFlags.Ephemeral });
  }

  private async cmdAvatar(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const ok = await (this.adapter as unknown as DiscordAdapter).pushAvatar();
      await i.editReply({
        content: ok ? "✅ Bot avatar updated." : "⚠️ Avatar file not found (`assets/seam-acp-avatar.png`).",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await i.editReply({ content: `❌ Failed to update avatar: ${msg}` });
    }
  }

  private async cmdHelp(i: ChatInputCommandInteraction): Promise<void> {
    const lines = [
      "**seam-acp** — control the agent in this thread.",
      "",
      "`/seam new [name]` — create a new agent thread",
      "`/seam init` — bind this thread + show repo picker",
      "`/seam repo <path>` — set working repo (under REPOS_ROOT)",
      "`/seam repos` — list repos under REPOS_ROOT",
      "`/seam model [id]` — get / set agent model",
      "`/seam mode <id>` — set agent operational mode",
      "`/seam effort <low|medium|high>` — reasoning effort",
      "`/seam tools <allow|exclude> [list]` — tool filters",
      "`/seam approve <always|ask|deny>` — permission policy",
      "`/seam abort` — cancel current turn",
      "`/seam config` — show session config JSON",
      "`/seam config-set <json>` — replace session config",
      "`/seam sessions` — list known sessions",
      "`/seam avatar` — re-push bot avatar to Discord",
      "",
      "Free-form messages in a thread are sent to the agent.",
    ];
    await i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
  }

  // --- agent file uploads (Phase 2) ---

  /**
   * Upload a file produced by the agent (image / audio / embedded resource)
   * to the Discord thread. Falls back to inline text if the adapter doesn't
   * implement sendFile or the file is over Discord's free-tier 25 MB limit.
   */
  private async sendAgentFile(
    channel: ChannelRef,
    event: {
      filename: string;
      mimeType: string;
      data: string;
      base64: boolean;
      uri?: string;
    }
  ): Promise<void> {
    const buf = event.base64
      ? Buffer.from(event.data, "base64")
      : Buffer.from(event.data, "utf8");

    if (!this.adapter.sendFile) {
      await this.adapter.sendMessage(
        channel,
        `_Agent produced \`${event.filename}\` (${event.mimeType}, ${buf.byteLength} B) but this platform doesn't support file uploads._`
      );
      return;
    }

    const MAX_DISCORD_BYTES = 25 * 1024 * 1024;
    if (buf.byteLength > MAX_DISCORD_BYTES) {
      await this.adapter.sendMessage(
        channel,
        `_Agent produced \`${event.filename}\` (${buf.byteLength} B) — too large for Discord (25 MB limit)._${
          event.uri ? ` Source: ${event.uri}` : ""
        }`
      );
      return;
    }

    await this.adapter.sendFile(channel, {
      data: buf,
      filename: event.filename,
      mimeType: event.mimeType,
    });
  }

  /**
   * After a turn finishes, scan the assistant's accumulated text for
   * fenced code blocks that look like complete file artifacts (markdown
   * docs, JSON configs, scripts, etc.) and upload each as a Discord
   * attachment. Mirrors what Claude.ai's UI does — the model only
   * emits text; the client decides what's file-shaped.
   *
   * Failures are logged but never crash the turn.
   */
  private async uploadDetectedCodeBlocks(
    channel: ChannelRef,
    fullText: string
  ): Promise<void> {
    if (!this.adapter.sendFile) return;
    let blocks;
    try {
      blocks = detectFileBlocks(fullText);
    } catch (err) {
      this.logger.warn({ err }, "code-block detection failed");
      return;
    }
    if (blocks.length === 0) return;
    this.logger.info(
      { count: blocks.length, langs: blocks.map((b) => b.lang) },
      "uploading detected code blocks"
    );
    for (const b of blocks) {
      try {
        const buf = Buffer.from(b.content, "utf8");
        if (buf.byteLength > 25 * 1024 * 1024) continue;
        await this.adapter.sendFile(channel, {
          data: buf,
          filename: b.filename,
          mimeType: b.mimeType,
        });
      } catch (err) {
        this.logger.warn(
          { err, filename: b.filename },
          "code-block upload failed"
        );
      }
    }
  }

  // --- repo picker ---

  private async sendRepoPicker(channel: ChannelRef): Promise<void> {
    const dirs = this.listRepoDirs();
    if (!dirs) {
      await this.adapter.sendMessage(
        channel,
        `❌ REPOS_ROOT not found: \`${this.config.REPOS_ROOT}\``
      );
      return;
    }
    if (dirs.length === 0) {
      await this.adapter.sendMessage(
        channel,
        `⚠️ No repos under \`${this.config.REPOS_ROOT}\`. Use \`/seam repo <path>\`.`
      );
      return;
    }
    const top = dirs.slice(0, REPO_PICK_EMOJIS.length);
    const lines = top.map(
      (p, idx) => `${REPO_PICK_EMOJIS[idx]} ${path.basename(p)}`
    );
    const body =
      "🗂️ **Select repo**\n" +
      this.renderer.codeBlock(lines.join("\n")) +
      "\nReact with a number to choose, or use `/seam repo <path>`.";

    const sent = await this.adapter.sendMessage(channel, body);
    this.repoPickers.set(sent.id, {
      channel,
      repoPaths: top,
      createdAt: Date.now(),
    });

    if (this.adapter.addReactions) {
      try {
        await this.adapter.addReactions(
          sent,
          REPO_PICK_EMOJIS.slice(0, top.length).map((e) => e)
        );
      } catch (err) {
        this.logger.warn({ err }, "failed to add picker reactions");
      }
    }
  }

  private async handleReaction(event: ReactionEvent): Promise<void> {
    const picker = this.repoPickers.get(event.message.id);
    if (!picker) return;
    const idx = REPO_PICK_EMOJIS.indexOf(
      event.reaction as (typeof REPO_PICK_EMOJIS)[number]
    );
    if (idx < 0 || idx >= picker.repoPaths.length) return;
    const picked = picker.repoPaths[idx];
    if (!picked) return;

    if (!isWithinRoot(picked, this.config.REPOS_ROOT)) {
      await this.adapter.sendMessage(
        picker.channel,
        `🛡️ Repo \`${picked}\` is outside REPOS_ROOT.`
      );
      return;
    }

    const record = this.router.ensureSessionRecord({
      platform: picker.channel.platform,
      channelRef: picker.channel.id,
      ...(picker.channel.parentId
        ? { parentRef: picker.channel.parentId }
        : {}),
      cwd: this.config.REPOS_ROOT,
    });
    this.store.upsert({
      ...record,
      repoPath: picked,
      updatedUtc: new Date().toISOString(),
    });
    await this.router.invalidate(record.id);
    this.repoPickers.delete(event.message.id);

    await this.adapter.sendMessage(
      picker.channel,
      `📌 Repo set to \`${this.repoDisplay(picked)}\`. Send a message to begin.`
    );
  }

  private listRepoDirs(): string[] | undefined {
    const root = this.config.REPOS_ROOT;
    if (!fs.existsSync(root)) return undefined;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      this.logger.warn({ err, root }, "readdir failed");
      return [];
    }
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name))
      .sort((a, b) => a.localeCompare(b));
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

function parseCsv(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

// Re-export for convenience.
export type { EmbedBuilder };
