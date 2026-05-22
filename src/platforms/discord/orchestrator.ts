import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { MessageFlags, type ChatInputCommandInteraction, type EmbedBuilder } from "discord.js";
import type { Logger } from "../../lib/logger.js";
import type { Config } from "../../config.js";
import type { Renderer } from "../renderer.js";
import { serializePanelText } from "../renderer.js";
import type {
  ChatAdapter,
  ChannelRef,
  IncomingMessage,
  MessageRef,
  SessionRecord,
} from "../chat-adapter.js";
import type { PromptOutcome } from "../../agents/agent-runtime.js";
import type { SessionStore } from "../../core/session-store.js";
import { SessionRouter } from "../../core/session-router.js";
import { TurnStatus, renderStatusPanel } from "../../core/status-panel.js";
import { isWithinRoot, resolveRepoPath } from "../../core/path-utils.js";
import { splitForFlush, hasOpenFence } from "../../core/stream-flush.js";
import { FenceStream, type CompletedFence } from "../../core/fence-stream.js";
import { mimeTypeForFilename } from "../../core/fence-mime.js";
import {
  defaultSessionConfig,
  type SessionConfigState,
} from "../../core/types.js";
import type { DiscordAdapter } from "./adapter.js";

const STATUS_EDIT_DEBOUNCE_MS = 2500;
const STATUS_HEARTBEAT_MS = 5000;
const PLATFORM = "discord";
// Maximum total size of an inline-rendered fence message
// (```lang\n...\n``` plus optional notice). Fences whose rendered
// inline form would exceed this are uploaded as attachments instead.
// Discord's hard limit per message is 2000 chars; 1900 leaves headroom
// for the optional `_(notice)_` paragraph and a tiny safety margin.
const ORCH_INLINE_FENCE_MAX = 1900;

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

  private activeTurns = 0;
  private restartPending = false;

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
    this.watchSentinel();
  }

  async postNotification(message: string): Promise<void> {
    const channelId = this.config.DISCORD_NOTIFICATIONS_CHANNEL_ID;
    if (!channelId) return;
    try {
      await this.adapter.sendMessage({ platform: PLATFORM, id: channelId }, `**seam-acp**: ${message}`);
    } catch (err) {
      this.logger.warn({ err }, "failed to post notification");
    }
  }

  private sentinelPoller: ReturnType<typeof setInterval> | null = null;

  /** Stop the sentinel file watcher (call on shutdown). */
  stopSentinelWatcher(): void {
    if (this.sentinelPoller) {
      clearInterval(this.sentinelPoller);
      this.sentinelPoller = null;
    }
  }

  private sentinelPath(): string {
    return path.join(this.config.DATA_DIR, ".restart-pending");
  }

  private watchSentinel(): void {
    const checkSentinel = () => {
      if (this.restartPending) return;
      if (!fs.existsSync(this.sentinelPath())) return;
      this.logger.info("restart sentinel detected");
      void this.handleRestartSentinel();
    };

    // Poll every 2s — more reliable than fs.watch on Linux
    this.sentinelPoller = setInterval(checkSentinel, 2000);
    // Also check immediately in case sentinel was written before startup
    checkSentinel();
  }

  private async handleRestartSentinel(): Promise<void> {
    this.restartPending = true;

    if (this.activeTurns > 0) {
      const turnWord = this.activeTurns === 1 ? "turn" : "turn(s)";
      await this.postNotification(
        `♻️ Restart requested — waiting for ${this.activeTurns} ${turnWord} to finish.`
      );
      this.logger.info({ activeTurns: this.activeTurns }, "restart pending, draining turns");

      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.activeTurns === 0) {
            clearInterval(check);
            resolve();
          }
        }, 500);
      });
    }

    this.logger.info("all turns drained, executing restart");
    try {
      await fsp.unlink(this.sentinelPath());
    } catch {
      // ignore if already gone
    }

    // exec replaces this process — pm2 revives with the new dist/
    const { execSync } = await import("node:child_process");
    execSync("pm2 restart seam-acp", { stdio: "inherit" });
  }

  // --- message turn ---

  private async handleIncomingMessage(msg: IncomingMessage): Promise<void> {
    this.activeTurns++;
    try {
      await this.handleIncomingMessageInner(msg);
    } finally {
      this.activeTurns--;
    }
  }

  private async handleIncomingMessageInner(msg: IncomingMessage): Promise<void> {
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

    const initialPanel = renderStatusPanel(this.renderer, status.toInput(), Date.now());
    const statusMsg = this.adapter.sendPanel
      ? await this.adapter.sendPanel(channel, initialPanel)
      : await this.adapter.sendMessage(channel, serializePanelText(initialPanel));

    let lastEdit = 0;
    let lastRendered = "";
    const refresh = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastEdit < STATUS_EDIT_DEBOUNCE_MS) return;
      const panel = renderStatusPanel(this.renderer, status.toInput(), now);
      const fingerprint = JSON.stringify(panel);
      if (fingerprint === lastRendered) return;
      lastRendered = fingerprint;
      lastEdit = now;
      try {
        if (this.adapter.editPanel) {
          await this.adapter.editPanel(statusMsg, panel);
        } else {
          await this.adapter.editMessage(statusMsg, serializePanelText(panel));
        }
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

    // Typing indicator: refresh on real agent activity (text, tool calls,
    // thoughts) rather than a dumb timer. Discord's typing indicator
    // expires after ~10s, so we re-arm it every 8s while the agent is
    // working. Stops once we start posting actual messages — keeping it
    // alive past that point looks wrong.
    const TYPING_INTERVAL_MS = 8_000;
    let lastTypingSentAt = 0;
    let typingDone = false;
    const refreshTyping = (): void => {
      if (typingDone) return;
      const now = Date.now();
      if (now - lastTypingSentAt < TYPING_INTERVAL_MS) return;
      lastTypingSentAt = now;
      if (this.adapter.sendTyping) {
        void this.adapter.sendTyping(channel).catch(() => {});
      }
    };

    let textBuffer = "";
    let textSent = false;
    let totalAgentChars = 0;
    // Streaming fence extractor: pulls every ```lang ... ``` block out
    // of the agent's text and emits ordered segments. Fence-close
    // segments are routed to inline-or-attachment rendering based on
    // size; bare-filename fences resolve to a host-file upload.
    const fenceStream = new FenceStream();
    let fenceCounter = 0;
    // Watchdog: if a fence stays open longer than this with no closer,
    // we emit whatever's accumulated and treat the fence as closed so
    // subsequent bytes flow as prose. Checked on each chunk.
    const FENCE_MAX_OPEN_MS = 60_000;
    let fenceWatchdogTripped = false;
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
    const drainBuffer = async (force: boolean, allowUnsafeCut = false) => {
      while (textBuffer) {
        const split = splitForFlush(textBuffer, {
          maxLen: HARD_MAX,
          softMin: SOFT_MIN,
          force,
          allowUnsafeCut,
        });
        if (!split) return;
        textBuffer = split.keep;
        if (split.send) {
          await this.adapter.sendMessage(channel, split.send);
          textSent = true;
          typingDone = true;
        }
        if (!force) return;
      }
    };
    const flushChunks = async () => {
      // End-of-turn: must drain everything. An open link will never be
      // closed, so allow unsafe cuts here.
      await drainBuffer(true, true);
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
        // Idle for IDLE_FLUSH_MS — any open markdown link is probably
        // never going to close. Allow unsafe cuts so we don't strand
        // the buffer waiting for a `)` that won't come.
        if (textBuffer) void drainBuffer(true, true);
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
    // Whitespace runaway: when the model gets stuck emitting nothing but
    // newlines/spaces, no trimmed chunk ever lands so the repeat-detector
    // can't fire. Count whitespace-only chunks separately and bail out
    // after enough of them in a row.
    const WHITESPACE_RUN_THRESHOLD = 30;
    let whitespaceRun = 0;
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

    const isSessionGoneError = (e: unknown): boolean => {
      const message = e instanceof Error ? e.message : String(e);
      const details = String((e as any)?.data?.details ?? "");
      return (
        message.toLowerCase().includes("session not found") ||
        details.toLowerCase().includes("session not found")
      );
    };

    // A 400 error from the agent means the current prompt was rejected (e.g.
    // invalid image). The session itself may still be valid, but we invalidate
    // anyway so the next message doesn't replay the same bad content.
    const isAgentRejectionError = (e: unknown): boolean => {
      return (e as any)?.code === 400;
    };

    try {
      let activeRuntime = await this.router.getOrStartRuntime(record);
      const eventHandler = async (event: Parameters<Parameters<typeof activeRuntime.onEvent>[0]>[0]) => {
        switch (event.kind) {
          case "agent-text": {
            refreshTyping();
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
                whitespaceRun = 0;
                if (trimmed === loopChunk) {
                  loopCount += 1;
                } else {
                  loopChunk = trimmed;
                  loopCount = 1;
                }
              } else {
                // pure-whitespace chunk: track separately so a runaway
                // newline loop still trips the canary.
                whitespaceRun += 1;
              }
              const repeatThreshold =
                loopChunk && loopChunk.length <= LOOP_SHORT_MAX
                  ? LOOP_THRESHOLD_SHORT
                  : LOOP_THRESHOLD_LONG;
              const repeatTripped =
                loopChunk !== null && loopCount >= repeatThreshold;
              const whitespaceTripped =
                whitespaceRun >= WHITESPACE_RUN_THRESHOLD;
              if (repeatTripped || whitespaceTripped) {
                loopAborted = true;
                const reason = whitespaceTripped
                  ? "whitespace"
                  : "repeated chunk";
                this.logger.warn(
                  {
                    session: record.id,
                    reason,
                    chunkLen: loopChunk?.length ?? 0,
                    chunkPreview: loopChunk?.slice(0, 80),
                    repeats: loopCount,
                    whitespaceRun,
                  },
                  "runaway agent output detected; cancelling turn"
                );
                try {
                  await activeRuntime.cancel();
                } catch (err) {
                  this.logger.warn({ err }, "cancel after loop failed");
                }
                try {
                  await flushChunks();
                  const notice = whitespaceTripped
                    ? "⚠️ Agent got stuck emitting blank output — turn cancelled. Try rephrasing."
                    : (() => {
                        const c = loopChunk ?? "";
                        const preview =
                          c.length > 80 ? `${c.slice(0, 77)}...` : c;
                        return `⚠️ Agent got stuck repeating the same output (\`${preview}\`) — turn cancelled. Try rephrasing.`;
                      })();
                  await this.adapter.sendMessage(channel, notice);
                  textSent = true;
                } catch (err) {
                  this.logger.warn({ err }, "loop notice send failed");
                }
                return;
              }
            }
            totalAgentChars += event.text.length;
            // Run text through the fence extractor and process each
            // ordered segment. Prose flows into the chat pipeline;
            // fence-open forces a flush of preceding prose; fence-close
            // routes to inline-or-attachment rendering based on size.
            const fenceResult = fenceStream.feed(event.text);
            for (const seg of fenceResult.segments) {
              if (seg.kind === "prose") {
                if (seg.text) {
                  textBuffer += seg.text;
                  maybeFlush();
                  armIdleFlush();
                }
              } else if (seg.kind === "fence-open") {
                // Commit any pending prose before the fence so message
                // ordering matches the agent's stream order.
                cancelFlushTimer();
                await drainBuffer(true);
              } else {
                // fence-close: emit as inline message or attachment.
                fenceCounter += 1;
                await this.emitClosedFence(channel, seg.fence, fenceCounter, {
                  preferredRoot: record.repoPath,
                });
                textSent = true;
                typingDone = true;
              }
            }
            // Watchdog: if a fence has been open too long, snapshot what
            // we have, emit it with a notice, and treat the fence as
            // closed so subsequent bytes flow as prose.
            if (
              !fenceWatchdogTripped &&
              fenceStream.inFence &&
              fenceStream.openSinceMs() > FENCE_MAX_OPEN_MS
            ) {
              fenceWatchdogTripped = true;
              this.logger.warn(
                { session: record.id },
                "open fence exceeded watchdog timeout; emitting partial content"
              );
              const snap = fenceStream.forceClose();
              if (snap) {
                fenceCounter += 1;
                await this.emitClosedFence(channel, snap, fenceCounter, {
                  preferredRoot: record.repoPath,
                  notice:
                    "_(fence exceeded the watchdog timeout and was closed early)_",
                });
                textSent = true;
                typingDone = true;
              }
            }
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
            refreshTyping();
            const label = event.title ?? event.kindLabel ?? "…";
            status.setAction(`Tool: ${label}`);
            status.pushActivity(label);
            await refresh();
            return;
          }
          case "tool-update":
            refreshTyping();
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
            refreshTyping();
            status.pushThinkingChunk(event.text);
            void refresh();
            return;
          case "agent-state":
            refreshTyping();
            status.setAction(event.state);
            void refresh();
            return;
          case "config-options":
          case "error":
            return;
        }
      };
      activeRuntime.onEvent(eventHandler);

      status.setAction("Thinking…");
      await refresh(true);
      refreshTyping();

      turnStartedAt = Date.now();
      const timeoutMs = this.config.TURN_TIMEOUT_SECONDS * 1000;

      // One transparent retry if the agent has lost the session (e.g. bridge
      // restarted). Session-gone fires immediately before any output, so
      // textBuffer/fenceStream are still clean and the retry is invisible.
      let result: PromptOutcome | "timeout";
      try {
        result = await raceWithTimeout(activeRuntime.prompt(msg.text, msg.attachments), timeoutMs);
      } catch (promptErr) {
        if (isSessionGoneError(promptErr)) {
          this.logger.warn({ session: record.id }, "session-gone on prompt; invalidating and retrying with new session");
          await this.router.invalidate(record.id, { clearAcpSession: true });
          activeRuntime = await this.router.getOrStartRuntime(record);
          activeRuntime.onEvent(eventHandler);
          result = await raceWithTimeout(activeRuntime.prompt(msg.text, msg.attachments), timeoutMs);
        } else {
          throw promptErr;
        }
      }

      cancelFlushTimer();
      // Drain the fence extractor: any final segments enter the chat
      // pipeline; an unclosed fence is emitted with a notice rather
      // than dropped.
      const tail = fenceStream.flush();
      for (const seg of tail.segments) {
        if (seg.kind === "prose") {
          if (seg.text) textBuffer += seg.text;
        } else if (seg.kind === "fence-open") {
          // Shouldn't appear in flush output, but handle defensively.
          await drainBuffer(true, true);
        } else {
          fenceCounter += 1;
          await this.emitClosedFence(channel, seg.fence, fenceCounter, {
            preferredRoot: record.repoPath,
          });
          textSent = true;
        }
      }
      if (tail.unclosed && !fenceWatchdogTripped) {
        this.logger.warn(
          {
            session: record.id,
            lang: tail.unclosed.lang,
            chars: tail.unclosed.content.length,
          },
          "agent ended turn with an unclosed code fence; emitting partial"
        );
        // Drain any prose preceding the unclosed fence first.
        await drainBuffer(true, true);
        fenceCounter += 1;
        await this.emitClosedFence(channel, tail.unclosed, fenceCounter, {
          preferredRoot: record.repoPath,
          notice: "_(fence was not closed by the agent)_",
        });
        textSent = true;
      }
      await flushChunks();
      this.logger.info(
        {
          session: record.id,
          totalMs: Date.now() - turnStartedAt,
          ttftMs:
            firstChunkAt !== undefined ? firstChunkAt - turnStartedAt : null,
          chars: totalAgentChars,
          fenceFiles: fenceCounter,
        },
        "turn timing"
      );

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
        await activeRuntime.cancel();
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
      this.logger.error({ err, session: record.id }, "turn failed");
      cancelFlushTimer();
      await flushChunks();
      // If the agent reports that the session is gone (e.g. bridge restarted
      // with a fresh agent process), evict the dead runtime so the next message
      // triggers a clean newSession rather than repeatedly failing.
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isSessionGoneError(err)) {
        this.logger.warn({ session: record.id }, "session not found on agent; invalidating runtime");
        await this.router.invalidate(record.id, { clearAcpSession: true });
      } else if (isAgentRejectionError(err) || errMsg.includes("Prompt is too long")) {
        this.logger.warn({ session: record.id }, "agent rejected prompt (400); invalidating session to prevent replay");
        await this.router.invalidate(record.id, { clearAcpSession: true });
        
        if (errMsg.includes("Prompt is too long")) {
          await this.adapter.sendMessage(
            channel,
            "⚠️ **Claude hit its context limit before auto-compacting.** The context grew too large in a single turn. Try running `/compact` to free up space!"
          );
        }
      }
      status.setState("Failed");
      status.setAction(this.renderer.trimShort(isSessionGoneError(err) ? "Session lost — please resend your message." : errMsg, 120));
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
      case "attach":
        return this.cmdAttach(interaction);
      case "whoami":
        return this.cmdWhoami(interaction);
      case "usage":
        return this.cmdUsage(interaction);
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

    // Auto-init: bind a session to the new thread and post the repo
    // picker so the user doesn't have to /seam init themselves.
    try {
      this.router.ensureSessionRecord({
        platform: thread.platform,
        channelRef: thread.id,
        ...(thread.parentId ? { parentRef: thread.parentId } : {}),
        cwd: this.config.REPOS_ROOT,
      });
      await this.sendRepoPicker(thread);
      await i.editReply(`Created thread <#${thread.id}> and initialized it.`);
    } catch (err) {
      this.logger.warn({ err, threadId: thread.id }, "auto-init after /seam new failed");
      await i.editReply(
        `Created thread <#${thread.id}>. Run \`/seam init\` there to begin.`
      );
    }
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
      // No id given — show an interactive picker. Eagerly start the
      // runtime if needed so we have an availableModels list (the model
      // catalog comes from the agent at session-start, not from us).
      const cfg = this.store.readConfig(record);
      const current = cfg.model ?? this.config.DEFAULT_MODEL;
      if (!this.adapter.sendChoicePicker) {
        await i.reply({
          content: `Current model: \`${current}\``,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      let models: ReadonlyArray<{ modelId: string; name?: string }> = [];
      const profile = this.router.getProfile(record.agentId);

      if (profile?.staticModels && profile.staticModels.length > 0) {
        models = profile.staticModels;
      } else {
        try {
          const rt = await this.router.getOrStartRuntime(record);
          models = rt.getSessionInfo()?.availableModels ?? [];
        } catch (err) {
          this.logger.warn({ err }, "could not start runtime / enumerate models");
          await i.editReply(
            `Current model: \`${current}\`\nFailed to start the agent to list models: ${(err as Error).message}`
          );
          return;
        }
      }

      if (models.length === 0) {
        await i.editReply(
          `Current model: \`${current}\`\n_(agent did not advertise any models — pass an id manually: \`/seam model id:<name>\`.)_`
        );
        return;
      }
      await i.editReply(`Current model: \`${current}\`. Posting picker…`);
      const picked = await this.adapter.sendChoicePicker(channel, {
        panel: {
          color: 0x5865f2,
          title: "🧠 Choose a model",
          fields: [{ name: "Current", value: `\`${current}\``, inline: true }],
        },
        choices: models.slice(0, 25).map((m) => ({
          value: m.modelId,
          label: m.name ?? m.modelId,
          description: m.modelId,
        })),
        authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
        successPanel: (pickedChoice, username) => ({
          color: 0x57f287,
          title: "✅ Model changed",
          fields: [
            { name: "Previous", value: `\`${current}\``, inline: true },
            { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
          ],
          footer: `Changed by ${username}`
        }),
      });
      if (!picked) return;
      await this.applyModelChange(channel, record, picked.value);
      return;
    }
    await this.applyModelChange(channel, record, id, i);
  }

  /**
   * Persist + (best-effort) live-apply a model id. If `interaction` is
   * supplied, reply ephemerally to it; otherwise post the result to the
   * channel (for picker-driven flows).
   */
  private async applyModelChange(
    channel: ChannelRef,
    record: SessionRecord,
    id: string,
    interaction?: ChatInputCommandInteraction
  ): Promise<void> {
    const cfg = this.store.readConfig(record);
    cfg.model = id;
    this.persistConfig(record, cfg);
    let message: string;
    if (this.router.hasRuntime(record.id)) {
      try {
        const rt = await this.router.getOrStartRuntime(record);
        await rt.setModel(id);
        message = `🧠 Model set to \`${id}\` (live).`;
      } catch (err) {
        this.logger.warn({ err }, "live model set failed; will apply next turn");
        message = `🧠 Model will be \`${id}\` on the next turn.`;
      }
    } else {
      message = `🧠 Model will be \`${id}\` on the next turn.`;
    }
    if (interaction) {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await this.adapter.sendMessage(channel, message);
    }
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
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: "Use inside a thread.",
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
    const id = i.options.getString("id");
    const profiles = this.router.listProfiles();

    if (!id) {
      // Show interactive picker.
      if (!this.adapter.sendChoicePicker || profiles.length === 0) {
        const listing = profiles
          .map((p) => `\`${p.id}\` — ${p.displayName}`)
          .join(", ");
        await i.reply({
          content: `Current agent: \`${record.agentId}\`\nAvailable: ${listing}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await i.reply({
        content: `Current agent: \`${record.agentId}\`. Posting picker…`,
        flags: MessageFlags.Ephemeral,
      });
      const picked = await this.adapter.sendChoicePicker(channel, {
        panel: {
          color: 0x5865f2,
          title: "🤖 Choose an agent",
          fields: [{ name: "Current", value: `\`${record.agentId}\``, inline: true }],
        },
        choices: profiles.map((p) => ({
          value: p.id,
          label: p.displayName,
          description: p.id,
        })),
        authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
        successPanel: (pickedChoice, username) => ({
          color: 0x57f287,
          title: "✅ Agent changed",
          fields: [
            { name: "Previous", value: `\`${record.agentId}\``, inline: true },
            { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
          ],
          footer: `Changed by ${username}`
        }),
      });
      if (!picked) return;
      await this.applyAgentChange(channel, record, picked.value);
      return;
    }

    const profile = this.router.getProfile(id);
    if (!profile) {
      const listing = profiles
        .map((p) => `\`${p.id}\` — ${p.displayName}`)
        .join(", ");
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
    await this.applyAgentChange(channel, record, id, i);
  }

  private async applyAgentChange(
    channel: ChannelRef,
    record: SessionRecord,
    id: string,
    interaction?: ChatInputCommandInteraction
  ): Promise<void> {
    const profile = this.router.getProfile(id);
    if (!profile) {
      const msg = `Unknown agent \`${id}\`.`;
      if (interaction) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      else await this.adapter.sendMessage(channel, msg);
      return;
    }
    if (record.agentId === id) {
      const msg = `Agent is already \`${id}\`.`;
      if (interaction) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      else await this.adapter.sendMessage(channel, msg);
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
    const message = `🤖 Agent switched to \`${id}\` (${profile.displayName}), model \`${profile.defaultModel}\`. Next message will start a fresh session.`;
    if (interaction) {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await this.adapter.sendMessage(channel, message);
    }
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

  /**
   * Read a file from the host machine and post it to the channel as a
   * Discord attachment. The path must resolve under REPOS_ROOT or one
   * of the configured ATTACH_ROOTS — symlinks are followed and the
   * realpath is re-checked.
   */
  /**
   * Resolve a user/agent-supplied path to an existing file under one of
   * the allowed roots (REPOS_ROOT + ATTACH_ROOTS). Returns null on any
   * failure (not found, not a regular file, escapes roots, etc.).
   * Symlinks are followed and the realpath is re-checked.
   */
  private async resolveAllowedHostFile(
    requested: string,
    opts: { preferredRoot?: string | null } = {}
  ): Promise<{ realPath: string; size: number } | null> {
    const cleaned = requested.trim().replace(/^"|"$/g, "");
    if (!cleaned) return null;

    const allowedRoots = [
      this.config.REPOS_ROOT,
      ...this.config.ATTACH_ROOTS,
    ].map((p) => path.resolve(p));

    // For relative paths, try each candidate base in order until one
    // resolves to an existing regular file inside an allowed root:
    //   1. The session's repoPath (the thread's current repo) if any.
    //   2. Each allowed root in order.
    // For absolute paths, resolve directly.
    const candidates: string[] = [];
    if (path.isAbsolute(cleaned)) {
      candidates.push(path.resolve(cleaned));
    } else {
      const bases: string[] = [];
      if (opts.preferredRoot) bases.push(path.resolve(opts.preferredRoot));
      for (const r of allowedRoots) {
        if (!bases.includes(r)) bases.push(r);
      }
      for (const base of bases) candidates.push(path.resolve(base, cleaned));
    }

    for (const candidate of candidates) {
      let real: string;
      let stat: fs.Stats;
      try {
        real = await fsp.realpath(candidate);
        stat = await fsp.stat(real);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (!allowedRoots.some((r) => isWithinRoot(real, r))) continue;
      return { realPath: real, size: stat.size };
    }
    return null;
  }

  private async cmdAttach(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: "Use `/seam attach` from inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!this.adapter.sendFile) {
      await i.reply({
        content: "This platform does not support file uploads.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const requested = i.options.getString("path", true);
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const resolved = await this.resolveAllowedHostFile(requested);
    if (!resolved) {
      await i.editReply(
        `Could not attach \`${requested}\` — file not found, not a regular file, or outside REPOS_ROOT / ATTACH_ROOTS.`
      );
      return;
    }

    const MAX = 25 * 1024 * 1024;
    if (resolved.size > MAX) {
      await i.editReply(
        `File too large for Discord: ${resolved.size} B (25 MB limit).`
      );
      return;
    }

    let data: Buffer;
    try {
      data = await fsp.readFile(resolved.realPath);
    } catch (err) {
      await i.editReply(`Read failed: ${(err as Error).message}`);
      return;
    }

    const filename = path.basename(resolved.realPath);
    const mimeType = mimeTypeForFilename(filename);

    try {
      await this.adapter.sendFile(channel, { data, filename, mimeType });
      await i.editReply(`📎 Posted \`${filename}\` (${data.byteLength} B).`);
    } catch (err) {
      this.logger.warn({ err, filename }, "/seam attach upload failed");
      await i.editReply(`Upload failed: ${(err as Error).message}`);
    }
  }

  private async cmdWhoami(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.editReply({ content: "Use inside a thread." });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const profile = this.router.getProfile(record.agentId);
    if (!profile) {
      await i.editReply({
        content: `Agent \`${record.agentId}\` is not registered on this bot.`,
      });
      return;
    }
    if (!profile.whoami) {
      await i.editReply({
        content: `Agent \`${profile.id}\` (${profile.displayName}) does not expose account info.`,
      });
      return;
    }
    const id = await profile.whoami();
    if (!id) {
      await i.editReply({
        content:
          `Agent \`${profile.id}\` (${profile.displayName}) — no logged-in account found. ` +
          `Run \`copilot login\` (set \`COPILOT_HOME\` for non-default profiles) on the host.`,
      });
      return;
    }
    const hostNote = id.host ? ` (${id.host})` : "";
    await i.editReply({
      content: `Agent \`${profile.id}\` (${profile.displayName}) is signed in as **${id.login}**${hostNote}.`,
    });
  }

  private async cmdUsage(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.editReply({ content: "Use inside a thread." });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const isAgy = record.agentId === "agy";
    const isClaude = record.agentId === "claude" || record.agentId.startsWith("claude-");
    const isCopilot =
      record.agentId === "copilot" ||
      (record.agentId.startsWith("copilot-") && !record.agentId.startsWith("copilot-remote"));
    if (!isAgy && !isClaude && !isCopilot) {
      await i.editReply({
        content: `\`/seam usage\` is only available for the \`agy\`, \`claude\`, and \`copilot\` agents. This thread uses \`${record.agentId}\`.`,
      });
      return;
    }
    try {
      const profile = this.router.getProfile(record.agentId);
      const configDir = profile?.configDir;
      if (isAgy) {
        const { fetchAgyUserStatus } = await import("../../agents/profiles/agy.js");
        const data = await fetchAgyUserStatus(this.config.AGY_CLI_PATH);
        await i.editReply({ content: formatAgyUsage(data) });
      } else if (isClaude) {
        const { fetchClaudeUsage } = await import("../../agents/profiles/claude.js");
        const data = await fetchClaudeUsage(configDir);
        await i.editReply({ content: formatClaudeUsage(data) });
      } else {
        const { fetchCopilotUsage } = await import("../../agents/profiles/copilot.js");
        const data = await fetchCopilotUsage(configDir);
        await i.editReply({ content: formatCopilotUsage(data) });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err }, "/seam usage failed");
      await i.editReply({ content: `Couldn't fetch usage: ${msg}` });
    }
  }

  private async cmdAvatar(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const adapter = this.adapter as unknown as DiscordAdapter;
      const avatarOk = await adapter.pushAvatar();
      let bannerOk = false;
      let bannerErr: string | undefined;
      try {
        bannerOk = await adapter.pushBanner();
      } catch (err: unknown) {
        bannerErr = err instanceof Error ? err.message : String(err);
      }
      const parts: string[] = [];
      parts.push(
        avatarOk
          ? "✅ Bot avatar updated."
          : "⚠️ Avatar file not found (`assets/seam-acp-avatar.png`)."
      );
      if (bannerErr) {
        parts.push(`⚠️ Banner update failed: ${bannerErr}`);
      } else {
        parts.push(
          bannerOk
            ? "✅ Bot banner updated."
            : "⚠️ Banner file not found (`assets/seam-acp-banner.png`)."
        );
      }
      await i.editReply({ content: parts.join("\n") });
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
      "`/seam attach <path>` — upload a host-side file (under REPOS_ROOT or ATTACH_ROOTS) to this channel",
      "`/seam whoami` — show the account this thread's agent is signed in as",
      "`/seam usage` — show usage / credits (agy only)",
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
   * Render a closed fence to the chat thread. Routes between an inline
   * markdown message and a file attachment based on the rendered inline
   * size; bare-filename fences that resolve to a real host file under
   * the allowed roots are uploaded as the actual file.
   *
   * Failures are logged, never thrown.
   */
  private async emitClosedFence(
    channel: ChannelRef,
    fence: CompletedFence,
    counter: number,
    opts: { notice?: string; preferredRoot?: string | null } = {}
  ): Promise<void> {
    // Inline-rendered total size = ```lang\n<content>\n``` plus optional
    // trailing notice on its own paragraph.
    const inlineMessageLen =
      3 + fence.lang.length + 1 + fence.content.length + 1 + 3 +
      (opts.notice ? 2 + opts.notice.length : 0);
    const fitsInline = inlineMessageLen <= ORCH_INLINE_FENCE_MAX;

    // Bare-filename short-circuit (only meaningful for small content; a
    // long fence can't be a single-line filename anyway).
    if (fitsInline) {
      const sentAsFile = await this.tryEmitBareFilenameFence(
        channel,
        fence,
        opts
      );
      if (sentAsFile) return;
    }

    if (fitsInline || !this.adapter.sendFile) {
      await this.emitFenceInline(channel, fence, opts);
      return;
    }
    await this.emitFenceAttachment(channel, fence, counter, opts);
  }

  /**
   * If the fence content is a single non-empty line that resolves to a
   * file under our allowed roots, upload that real file (with optional
   * trailing notice) and return true. Otherwise return false.
   */
  private async tryEmitBareFilenameFence(
    channel: ChannelRef,
    fence: CompletedFence,
    opts: { notice?: string; preferredRoot?: string | null }
  ): Promise<boolean> {
    if (!this.adapter.sendFile) return false;
    const trimmed = fence.content.trim();
    if (trimmed.length === 0 || trimmed.includes("\n")) return false;
    const resolved = await this.resolveAllowedHostFile(trimmed, {
      preferredRoot: opts.preferredRoot ?? null,
    });
    if (!resolved) return false;

    const MAX = 25 * 1024 * 1024;
    if (resolved.size > MAX) {
      try {
        await this.adapter.sendMessage(
          channel,
          `_Referenced file too large to upload: \`${path.basename(resolved.realPath)}\` (${resolved.size} B, 25 MB limit)._${
            opts.notice ? `\n\n${opts.notice}` : ""
          }`
        );
      } catch (err) {
        this.logger.warn({ err }, "bare-filename oversize notice failed");
      }
      return true;
    }
    try {
      const data = await fsp.readFile(resolved.realPath);
      const filename = path.basename(resolved.realPath);
      await this.adapter.sendFile(channel, {
        data,
        filename,
        mimeType: mimeTypeForFilename(filename),
      });
      if (opts.notice) {
        try {
          await this.adapter.sendMessage(channel, opts.notice);
        } catch (err) {
          this.logger.warn({ err }, "bare-filename notice send failed");
        }
      }
      this.logger.info(
        { realPath: resolved.realPath, bytes: data.byteLength },
        "fence resolved to host file — uploaded actual file"
      );
      return true;
    } catch (err) {
      this.logger.warn(
        { err, realPath: resolved.realPath },
        "fence-to-file resolution read failed; falling back to inline"
      );
      return false;
    }
  }

  /**
   * Render a fence as an inline ```lang\n...\n``` Discord message,
   * with an optional trailing notice paragraph.
   */
  private async emitFenceInline(
    channel: ChannelRef,
    fence: CompletedFence,
    opts: { notice?: string } = {}
  ): Promise<void> {
    const body = `\`\`\`${fence.lang}\n${fence.content}\n\`\`\``;
    const text = opts.notice ? `${body}\n\n${opts.notice}` : body;
    try {
      await this.adapter.sendMessage(channel, text);
    } catch (err) {
      this.logger.warn({ err }, "fence inline send failed");
    }
  }

  /**
   * Upload a fence as a Discord file attachment. Falls back to inline
   * rendering if the adapter doesn't support file uploads or the
   * content exceeds Discord's 25 MB limit.
   */
  private async emitFenceAttachment(
    channel: ChannelRef,
    fence: CompletedFence,
    counter: number,
    opts: { notice?: string } = {}
  ): Promise<void> {
    if (!this.adapter.sendFile) {
      await this.emitFenceInline(channel, fence, opts);
      return;
    }
    const filename =
      fence.ext === "Dockerfile"
        ? counter === 1
          ? "Dockerfile"
          : `Dockerfile.${counter}`
        : `snippet-${counter}.${fence.ext}`;
    try {
      const buf = Buffer.from(fence.content, "utf8");
      const MAX = 25 * 1024 * 1024;
      if (buf.byteLength > MAX) {
        await this.adapter.sendMessage(
          channel,
          `_Code block too large to upload (${buf.byteLength} B, Discord 25 MB limit)._${
            opts.notice ? `\n\n${opts.notice}` : ""
          }`
        );
        return;
      }
      await this.adapter.sendFile(channel, {
        data: buf,
        filename,
        mimeType: fence.mimeType,
      });
      if (opts.notice) {
        try {
          await this.adapter.sendMessage(channel, opts.notice);
        } catch (err) {
          this.logger.warn({ err }, "fence attachment notice send failed");
        }
      }
    } catch (err) {
      this.logger.warn({ err, filename }, "fence upload failed");
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

    if (!this.adapter.sendChoicePicker) {
      // Adapter without interactive picker: list paths and let the user
      // pick via /seam repo <path>.
      const lines = dirs
        .slice(0, 20)
        .map((p) => `• ${path.basename(p)}`)
        .join("\n");
      await this.adapter.sendMessage(
        channel,
        `🗂️ **Available repos**\n${this.renderer.codeBlock(lines)}\nUse \`/seam repo <name>\`.`
      );
      return;
    }

    // Discord allows up to 25 select options; cap and warn if needed.
    const top = dirs.slice(0, 25);
    const overflow = dirs.length - top.length;

    const result = await this.adapter.sendChoicePicker(channel, {
      panel: {
        color: 0x5865f2,
        title: "🗂️ Select a project to begin",
        description: overflow > 0 ? `_(Showing first 25 of ${dirs.length} projects. Use \`/seam repo <path>\` to access the rest.)_` : undefined,
        fields: [],
      },
      choices: top.map((p) => ({
        value: p,
        label: path.basename(p),
      })),
      authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
      successPanel: (pickedChoice, username) => ({
        color: 0x57f287,
        title: "✅ Project selected",
        fields: [
          { name: "Project", value: `\`${pickedChoice.label}\``, inline: true },
        ],
        footer: `Started by ${username}`
      }),
    });

    if (!result) return;

    const picked = result.value;
    if (!isWithinRoot(picked, this.config.REPOS_ROOT)) {
      await this.adapter.sendMessage(
        channel,
        `🛡️ Repo \`${picked}\` is outside REPOS_ROOT.`
      );
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
      repoPath: picked,
      updatedUtc: new Date().toISOString(),
    });
    await this.router.invalidate(record.id);

    if (this.config.NEW_THREAD_WIZARD === "full") {
      await this.adapter.sendMessage(
        channel,
        `📌 Repo set to \`${this.repoDisplay(picked)}\`.`
      );
      // Re-read the record after repo was set.
      const freshRecord = this.store.get(record.id) ?? record;
      await this.runSetupWizard(channel, freshRecord);
    } else {
      await this.adapter.sendMessage(
        channel,
        `📌 Repo set to \`${this.repoDisplay(picked)}\`. Send a message to begin.`
      );
    }
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
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(root, e.name))
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * Post-repo-selection setup wizard: presents an agent picker followed by a
   * model picker. Called from `sendRepoPicker` when `NEW_THREAD_WIZARD=full`.
   *
   * Either picker can be skipped (only one option, user timeout, adapter
   * lacks `sendChoicePicker`). A runtime start failure for the model picker
   * is handled gracefully with a fallback notice.
   */
  private async runSetupWizard(
    channel: ChannelRef,
    record: SessionRecord
  ): Promise<void> {
    let currentRecord = record;

    // Step 1: Agent picker (skip when there's only one profile).
    const profiles = this.router.listProfiles();
    if (profiles.length > 1 && this.adapter.sendChoicePicker) {
      const picked = await this.adapter.sendChoicePicker(channel, {
        panel: {
          color: 0x5865f2,
          title: "🤖 Choose an agent",
          fields: [{ name: "Default", value: `\`${currentRecord.agentId}\``, inline: true }],
        },
        choices: profiles.map((p) => ({
          value: p.id,
          label: p.displayName,
          description:
            p.id === currentRecord.agentId ? `${p.id} (current)` : p.id,
        })),
        authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
        successPanel: (pickedChoice, username) => ({
          color: 0x57f287,
          title: "✅ Agent changed",
          fields: [
            { name: "Default", value: `\`${currentRecord.agentId}\``, inline: true },
            { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
          ],
          footer: `Changed by ${username}`
        }),
      });
      if (!picked) {
        // User timed out / cancelled — rename with default agent and end wizard.
        await this.renameThreadForSetup(channel, currentRecord);
        await this.adapter.sendMessage(
          channel,
          `✅ Setup complete. Send a message to begin.`
        );
        return;
      }
      if (picked.value !== currentRecord.agentId) {
        await this.applyAgentChange(channel, currentRecord, picked.value);
        // Re-read: applyAgentChange updated agent + model in the DB.
        currentRecord = this.store.get(currentRecord.id) ?? currentRecord;
      }
    }

    // Rename the thread now that we know the final agent.
    await this.renameThreadForSetup(channel, currentRecord);

    // Step 2: Model picker
    if (this.adapter.sendChoicePicker) {
      try {
        let models: ReadonlyArray<{ modelId: string; name?: string }> = [];
        const profile = this.router.getProfile(currentRecord.agentId);
        
        if (profile?.staticModels && profile.staticModels.length > 0) {
          models = profile.staticModels;
        } else {
          const rt = await this.router.getOrStartRuntime(currentRecord);
          models = rt.getSessionInfo()?.availableModels ?? [];
        }

        if (models.length > 1) {
          const cfg = this.store.readConfig(currentRecord);
          const current = cfg.model ?? this.config.DEFAULT_MODEL;
          const picked = await this.adapter.sendChoicePicker(channel, {
            panel: {
              color: 0x5865f2,
              title: "🧠 Choose a model",
              fields: [{ name: "Default", value: `\`${current}\``, inline: true }],
            },
            choices: models.slice(0, 25).map((m) => ({
              value: m.modelId,
              label: m.name ?? m.modelId,
              description:
                m.modelId === current ? `${m.modelId} (current)` : m.modelId,
            })),
            authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
            successPanel: (pickedChoice, username) => ({
              color: 0x57f287,
              title: "✅ Model changed",
              fields: [
                { name: "Default", value: `\`${current}\``, inline: true },
                { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
              ],
              footer: `Changed by ${username}`
            }),
          });
          if (picked && picked.value !== current) {
            await this.applyModelChange(channel, currentRecord, picked.value);
          }
        }
      } catch (err) {
        this.logger.warn(
          { err },
          "wizard: could not start runtime for model picker"
        );
        await this.adapter.sendMessage(
          channel,
          `_Could not list models: ${(err as Error).message}. Use \`/seam model\` later._`
        );
      }
    }

    await this.adapter.sendMessage(
      channel,
      `✅ Setup complete. Send a message to begin.`
    );
  }

  /**
   * Rename a thread to "<repo-basename> [<agent-abbr>]" after setup.
   * Best-effort: silently skipped if the adapter, channel, or profile doesn't
   * support it.
   */
  private async renameThreadForSetup(
    channel: ChannelRef,
    record: SessionRecord
  ): Promise<void> {
    if (!this.adapter.renameThread) return;
    if (!channel.parentId) return; // not a thread
    const repoPath = record.repoPath;
    if (!repoPath) return;
    const profile = this.router.getProfile(record.agentId);
    const abbr = profile?.threadAbbr;
    if (!abbr) return;
    // Only rename if the thread still has the default "seam" name; skip if
    // the user already gave it a custom name when running /seam new.
    if (this.adapter.getThreadName) {
      const current = await this.adapter.getThreadName(channel);
      if (current !== undefined && current !== "seam") return;
    }
    const repoName = path.basename(repoPath);
    const newName = `${repoName} [${abbr}]`;
    try {
      await this.adapter.renameThread(channel, newName);
    } catch (err) {
      this.logger.warn({ err }, "wizard: renameThread failed");
    }
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

function usageBar(pct: number): string {
  const filled = Math.min(20, Math.round(pct / 5));
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

function usageLine(pct: number | null, label: string): string {
  const bar = pct !== null ? usageBar(pct) : "░░░░░░░░░░░░░░░░░░░░";
  const pctStr = pct !== null ? `${Math.round(pct)}%`.padStart(4) : "  — ";
  return `\`${bar}\`  ${pctStr}  ${label}`;
}

function formatAgyUsage(d: import("../../agents/profiles/agy.js").AgyUsage): string {
  const lines: string[] = [];
  const who = [d.name, d.email].filter(Boolean).join(" · ");
  lines.push(`**Antigravity usage**${who ? ` — ${who}` : ""}`);
  const fmt = (n?: number): string =>
    typeof n === "number" ? n.toLocaleString("en-US") : "—";
  if (d.monthlyPromptCredits !== undefined || d.availablePromptCredits !== undefined) {
    const avail = d.availablePromptCredits ?? 0;
    const total = d.monthlyPromptCredits ?? 0;
    const pct = total > 0 ? ((total - avail) / total) * 100 : 0;
    lines.push(usageLine(pct, `Prompt credits — ${fmt(avail)} / ${fmt(total)} remaining`));
  }
  if (d.monthlyFlowCredits !== undefined || d.availableFlowCredits !== undefined) {
    const avail = d.availableFlowCredits ?? 0;
    const total = d.monthlyFlowCredits ?? 0;
    const pct = total > 0 ? ((total - avail) / total) * 100 : 0;
    lines.push(usageLine(pct, `Flow credits — ${fmt(avail)} / ${fmt(total)} remaining`));
  }
  const modelsWithQuota = d.models.filter(
    (m) => typeof m.remainingFraction === "number" || m.resetTime,
  );
  if (modelsWithQuota.length > 0) {
    lines.push("", "**Per-model quotas**");
    for (const m of modelsWithQuota) {
      if (typeof m.remainingFraction !== "number") continue;
      const pct = (1 - m.remainingFraction) * 100;
      const reset = m.resetTime ? ` · resets ${formatResetTime(m.resetTime)}` : "";
      lines.push(usageLine(pct, `${m.label}${reset}`));
    }
  }
  return lines.join("\n");
}

function formatCopilotUsage(
  d: import("../../agents/profiles/copilot.js").CopilotUsageData
): string {
  const lines: string[] = [];
  const who = [d.login, d.org ? `(${d.org})` : null].filter(Boolean).join(" ");
  lines.push(`**GitHub Copilot usage**${who ? ` — ${who}` : ""}`);
  if (d.plan) lines.push(`Plan: \`${d.plan}\``);
  const fmtQuota = (
    label: string,
    q: import("../../agents/profiles/copilot.js").CopilotQuotaSnapshot | null
  ): string | null => {
    if (!q) return null;
    if (q.unlimited) return `${label}: unlimited`;
    const used = q.entitlement - q.remaining;
    const pct = q.entitlement > 0 ? (used / q.entitlement) * 100 : 0;
    const over = q.overageCount > 0 ? ` (+${q.overageCount} overage)` : "";
    return usageLine(pct, `${label} — ${used} / ${q.entitlement}${over}`);
  };
  const quotas = [
    fmtQuota("Premium interactions", d.premiumInteractions),
    fmtQuota("Chat", d.chat),
    fmtQuota("Completions", d.completions),
  ].filter((s): s is string => s !== null);
  if (quotas.length > 0) {
    lines.push("", "**Quotas**", ...quotas);
    if (d.quotaResetAt) lines.push(`Resets ${formatResetTime(d.quotaResetAt)}`);
  }
  return lines.join("\n");
}

function formatClaudeUsage(
  d: import("../../agents/profiles/claude.js").ClaudeUsageData
): string {
  const lines: string[] = [];
  lines.push(`**Claude Code usage**${d.login ? ` — ${d.login}` : ""}`);
  if (d.subscriptionType) {
    const tier = d.rateLimitTier ? ` (${d.rateLimitTier})` : "";
    lines.push(`Subscription: \`${d.subscriptionType}${tier}\``);
  }
  const fmtBucket = (
    label: string,
    b: import("../../agents/profiles/claude.js").ClaudeUsageBucket | null
  ): string | null => {
    if (!b) return null;
    const reset = b.resetsAt ? ` · resets ${formatResetTime(b.resetsAt)}` : "";
    return usageLine(b.utilization, `${label}${reset}`);
  };
  const buckets = [
    fmtBucket("Current 5h session", d.fiveHour),
    fmtBucket("Current week (all models)", d.sevenDay),
    fmtBucket("Current week (Sonnet)", d.sevenDaySonnet),
    fmtBucket("Current week (Opus)", d.sevenDayOpus),
  ].filter((s): s is string => s !== null);
  if (buckets.length > 0) {
    lines.push("", "**Rate-limit utilization**", ...buckets);
  }
  if (d.extraUsage && d.extraUsage.enabled) {
    const dollars = (n: number): string => `$${(n / 100).toFixed(2)}`;
    const pct = d.extraUsage.utilization;
    lines.push(
      "",
      "**Usage credits**",
      usageLine(d.extraUsage.utilization, `${dollars(d.extraUsage.used)} / ${dollars(d.extraUsage.limit)}`),
    );
  }
  return lines.join("\n");
}

function formatResetTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const secs = Math.round((d.getTime() - Date.now()) / 1000);
  if (secs <= 0) return "now";
  if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
  if (secs < 86400) return `in ${Math.round(secs / 3600)}h`;
  return `in ${Math.round(secs / 86400)}d`;
}

// Re-export for convenience.
export type { EmbedBuilder };
