import { randomUUID } from "node:crypto";
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { cleanTextForPreview, type SessionSummary, type SessionSummaryLine } from "@seam/adapters";
import type { BrowserClick, BrowserReply, SessionBrowserFacade } from "../../core/session-browser.js";
import type { SessionActions } from "../../core/session-actions.js";
import type { ChannelRef } from "../../platforms/chat-adapter.js";
import type { Logger } from "../../lib/logger.js";
import { SerialQueue } from "../../core/serial-queue.js";
import { CardLifecycle, expiredCardView, type CardView } from "../../platforms/discord/collector-lifecycle.js";
import { describeAttachOutcome, type AttachOutcome } from "../../core/session-attach.js";
import { DISCORD_COMPACTION_EXECUTOR_LABEL } from "../../core/compaction/discord-executor.js";
const STATUS_EDIT_DEBOUNCE_MS = 2500;
export interface BrowserState {
  id: string; owner: string; channelId: string; expires: number; closed: boolean;
  context: string; target: string; sessions: SessionSummary[]; currentIndex: number;
  imports: Record<string, { session: SessionSummary; model: string; expires: number }>;
}
export function createBrowser(ports: SessionBrowserFacade, actions: SessionActions, state: BrowserState,
  reply: BrowserReply, persist: () => void, logger: Pick<Logger, "error" | "warn">) {
  const record = actions.info;
  const profile = { displayName: record.displayName };
  const cwd = record.cwd;
  const queue = new SerialQueue();
  const save = () => { state.context = actions.snapshot(); if (state.target) persist(); };
  const i: BrowserReply = {
    get target() { return reply.target; }, user: reply.user, channelId: reply.channelId,
    deleteReply: () => reply.deleteReply(), followUp: view => reply.followUp(view),
    editReply: async view => {
      save(); await reply.editReply(routeView(view, state.id));
      state.target = reply.target; state.context = actions.snapshot(); persist();
    },
  };
  const formatLine = (line: SessionSummaryLine) => {
    const prefix = line.sender === "human" ? "👤" : "🤖";
    const cleaned = cleanTextForPreview(line.text);
    if (!cleaned) return null;
    const truncatedText = cleaned.length > 80 ? cleaned.substring(0, 77) + "..." : cleaned;
    return `${prefix} ${truncatedText}`;
  };

  const makeSessionMessageOptions = (idx: number, list: SessionSummary[], activeId: string) => {
    const isOrphaned = !list.some((s) => s.sessionId === activeId);

    if (list.length === 0) {
      const embed = new EmbedBuilder()
        .setTitle(`Browse & Manage Sessions — ${profile.displayName}`)
        .setDescription(
          `⚠️ **Warning:** The current Discord thread is completely disconnected from any known backend session.\n\n` +
          `*There are no sessions in the database for this workspace.*`
        )
        .setColor(0xe74c3c);

      const rebuildBtn = new ButtonBuilder()
        .setCustomId("sessions:rebuild")
        .setLabel("🏗️ Rebuild")
        .setStyle(ButtonStyle.Primary);
      const compactThreadBtn = new ButtonBuilder()
        .setCustomId("sessions:compact_thread")
        .setLabel("🧵 Compact from Thread")
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(rebuildBtn, compactThreadBtn);

      return {
        content: "",
        embeds: [embed],
        components: [row],
      };
    }

    const session = list[idx];
    if (!session) return { content: "No sessions found.", embeds: [], components: [] };

    const formatted = session.previewLines.map(formatLine).filter(Boolean) as string[];
    const previewText = formatted.length > 0
      ? formatted.join("\n")
      : "*No meaningful messages in this session.*";

    const embed = new EmbedBuilder()
      .setTitle(`Browse & Manage Sessions — ${profile.displayName}`)
      .setDescription(
        (isOrphaned ? `⚠️ **Warning:** The current Discord thread is completely disconnected from any known backend session.\n\n` : "") +
        `**Session ID:** \`${session.sessionId}\`\n` +
        `**Created:** ${session.createdAt ? `<t:${Math.floor(session.createdAt / 1000)}:f>` : "Unknown"}\n` +
        `**Last Activity:** ${session.lastActivityAt ? `<t:${Math.floor(session.lastActivityAt / 1000)}:R>` : "Unknown"}\n` +
        `**Status:** ${activeId === session.sessionId ? "🟢 **Active Session in this channel**" : "⚪ Inactive"}\n\n` +
        `**Preview (Heuristic):**\n` +
        previewText
      )
      .setColor(activeId === session.sessionId ? 0x2ecc71 : (isOrphaned ? 0xe74c3c : 0x3498db));

    let footerText = `Session ${idx + 1} of ${list.length}`;
    if (session.estimatedTokens !== undefined) {
      footerText += session.tokensFromUsage
        ? ` • Context: ${session.estimatedTokens.toLocaleString()} tokens`
        : ` • Context: ~${session.estimatedTokens.toLocaleString()} tokens (estimate, refines after next turn)`;
    }
    embed.setFooter({ text: footerText });

    const prevBtn = new ButtonBuilder()
      .setCustomId("sessions:prev")
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idx === 0);

    const nextBtn = new ButtonBuilder()
      .setCustomId("sessions:next")
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idx === list.length - 1);

    const closeBtn = new ButtonBuilder()
      .setCustomId("sessions:close")
      .setLabel("Close")
      .setStyle(ButtonStyle.Danger);

    const attachBtn = new ButtonBuilder()
      .setCustomId("sessions:attach")
      .setLabel("Attach")
      .setStyle(ButtonStyle.Success)
      .setDisabled(activeId === session.sessionId);

    const cloneBtn = new ButtonBuilder()
      .setCustomId("sessions:clone")
      .setLabel("Clone")
      .setStyle(ButtonStyle.Primary);

    const cloneAttachBtn = new ButtonBuilder()
      .setCustomId("sessions:clone_attach")
      .setLabel("Clone & Attach")
      .setStyle(ButtonStyle.Success);

    const deleteBtn = new ButtonBuilder()
      .setCustomId("sessions:delete")
      .setLabel("Delete")
      .setStyle(ButtonStyle.Danger);

    const summaryBtn = new ButtonBuilder()
      .setCustomId("sessions:summary")
      .setLabel("🪄 AI Summary")
      .setStyle(ButtonStyle.Primary);

    const capabilities = actions.capabilities();
    const canCompact = capabilities.canCompact;
    const canDiscordPremium = capabilities.canPremiumDiscord;
    const targetProfiles = capabilities.migrationTargets;

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn, closeBtn);
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(attachBtn, cloneBtn, cloneAttachBtn, deleteBtn);

    const row3Buttons = [summaryBtn];

    if (canCompact) {
      row3Buttons.push(
        new ButtonBuilder()
          .setCustomId("sessions:compact")
          .setLabel("🗳️ Compact")
          .setStyle(ButtonStyle.Success)
      );
    }

    if (capabilities.canRepair) {
      row3Buttons.push(
        new ButtonBuilder()
          .setCustomId("sessions:repair")
          .setLabel("Repair")
          .setStyle(ButtonStyle.Danger)
      );
    }

    if (targetProfiles.length > 0) {
      row3Buttons.push(
        new ButtonBuilder()
          .setCustomId("sessions:migrate")
          .setLabel("Migrate Agent")
          .setStyle(ButtonStyle.Primary)
      );
    }

    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(row3Buttons);

    const row4Buttons: ButtonBuilder[] = [
      new ButtonBuilder()
        .setCustomId("sessions:rebuild")
        .setLabel("🏗️ Rebuild")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("sessions:compact_thread")
        .setLabel("🧵 Compact from Thread")
        .setStyle(ButtonStyle.Secondary),
    ];
    if (canCompact) {
      row4Buttons.push(
        new ButtonBuilder()
          .setCustomId("sessions:import_to_cwd")
          .setLabel("📤 Import to Cwd")
          .setStyle(ButtonStyle.Primary)
      );
    }
    if (capabilities.canPremiumSession) {
      row4Buttons.push(
        new ButtonBuilder()
          .setCustomId("sessions:premium")
          .setLabel("✨ Premium Compact (Session)")
          .setStyle(ButtonStyle.Success)
      );
    }
    if (canDiscordPremium) {
      row4Buttons.push(
        new ButtonBuilder()
          .setCustomId("sessions:premium_discord")
          .setLabel("✨ Premium Compact (Discord)")
          .setStyle(ButtonStyle.Success)
      );
    }
    const components: ActionRowBuilder<ButtonBuilder>[] = [row1, row2, row3];
    if (row4Buttons.length > 0) {
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(row4Buttons));
    }

    return {
      content: "",
      embeds: [embed],
      components,
    };
  };


  const activeSessionId = () => actions.activeSessionId();
  const closedView = () => {
    const activeId = activeSessionId();
    const currentSession = state.sessions[state.currentIndex];
    if (!currentSession) {
      return expiredCardView("⏰ Session browser closed — run `/seam info sessions` again.");
    }
    const embed = new EmbedBuilder()
      .setTitle(`Browse Sessions — ${profile.displayName} (Closed)`)
      .setDescription(
        `**Session ID:** \`${currentSession.sessionId}\`\n` +
        `**Created:** ${currentSession.createdAt ? `<t:${Math.floor(currentSession.createdAt / 1000)}:f>` : "Unknown"}\n` +
        `**Last Activity:** ${currentSession.lastActivityAt ? `<t:${Math.floor(currentSession.lastActivityAt / 1000)}:R>` : "Unknown"}\n` +
        `**Status:** ${activeId === currentSession.sessionId ? "🟢 **Active Session in this channel**" : "⚪ Inactive"}\n\n` +
        `**Preview (Heuristic):**\n` +
        (currentSession.previewLines.length > 0
          ? currentSession.previewLines.map(formatLine).filter(Boolean).join("\n") || "*No meaningful messages in this session.*"
          : "*No messages in this session yet.*")
      )
      .setColor(activeId === currentSession.sessionId ? 0x2ecc71 : 0x7f8c8d)
      .setFooter({ text: `Session ${state.currentIndex + 1} of ${state.sessions.length} (Menu Timed Out)` });
    return { embeds: [embed], components: [] };
  };
  const lifecycle = new CardLifecycle({
    render: view => ports.track(queue.run(() => i.editReply(view))),
    stop: () => { state.closed = true; save(); },
    expired: closedView,
    onError: (err) => logger.warn({ err }, "session browser card render failed"),
  });
  if (state.closed) void lifecycle.dispose("restored");
  const browserChannel: ChannelRef = { platform: record.platform, id: record.channelRef,
    ...(record.parentRef ? { parentId: record.parentRef } : {}) };
  const backRow = () =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("sessions:summary_back")
        .setLabel("⬅ Back to Manage")
        .setStyle(ButtonStyle.Secondary)
    );


  const runBrowserCompaction = (opts: {
    session: SessionSummary;
    progressEmbed: EmbedBuilder;
    progressPrefix: string;
    successTitle: string;
    failureTitle: string;
    run: (onProgress: (m: string) => void) => Promise<{
      newId: string;
      attachment: AttachOutcome;

      detail: string;
      report?: { path: string; name: string };
    }>;
  }): void => {
    ports.runJob(async () => {
      await lifecycle.refresh({ embeds: [opts.progressEmbed], components: [] });

      let lastEdit = 0;
      let editing = false;

      let sealed = false;
      const lines: string[] = [];
      const pushProgress = (m: string) => {
        lines.push(m);
        if (sealed || editing) return;
        const now = Date.now();
        if (now - lastEdit < STATUS_EDIT_DEBOUNCE_MS) return;
        editing = true;
        lastEdit = now;
        const tail = lines.slice(-8).map((l) => `• ${l}`).join("\n");
        void lifecycle
          .refresh({
            embeds: [
              EmbedBuilder.from(opts.progressEmbed).setDescription(
                `${opts.progressPrefix}\n\n${tail}`
              ),
            ],
            components: [],
          })
          .finally(() => {
            editing = false;
          });
      };

      try {
        const res = await opts.run(pushProgress);
        sealed = true;
        state.sessions = await actions.list();
        const newIndex = state.sessions.findIndex((s) => s.sessionId === res.newId);
        if (newIndex !== -1) state.currentIndex = newIndex;

        const attachLine = describeAttachOutcome(res.attachment, {
          newId: res.newId,
          sourceId: opts.session.sessionId,
        });
        const successEmbed = new EmbedBuilder()
          .setTitle(opts.successTitle)
          .setDescription(
            `${res.detail}\n${attachLine}\n\n` +
            `Original \`${opts.session.sessionId}\` is **preserved** — review or delete it from this list.`
          )
          .setColor(res.attachment.attached ? 0x2ecc71 : 0xf1c40f);

        await ports.settle({
          lifecycle,
          view: {
            embeds: [successEmbed],
            components: [backRow()],
            ...(res.report
              ? { files: [new AttachmentBuilder(res.report.path, { name: res.report.name })] }
              : {}),
          },
          channel: browserChannel ?? null,
          fallback: { kind: "compaction", outcome: "ok" },
        });
      } catch (err: unknown) {
        sealed = true;
        const message = (err as Error)?.message ?? String(err);
        logger.error(
          { err, sessionId: opts.session.sessionId, customId: opts.successTitle },
          "session browser compaction failed"
        );
        const errorEmbed = new EmbedBuilder()
          .setTitle(opts.failureTitle)
          .setDescription(`\`\`\`\n${message.slice(0, 1500)}\n\`\`\``)
          .setColor(0xe74c3c);
        await ports.settle({
          lifecycle,
          view: { embeds: [errorEmbed], components: [backRow()] },
          channel: browserChannel ?? null,
          fallback: { kind: "compaction", outcome: "failed" },
        });
      }
    });
  };

  const handle = async (btnInteraction: BrowserClick) => {
    const customId = btnInteraction.customId;
    if (customId === "sessions:prev") {
      await btnInteraction.deferUpdate();
      if (state.currentIndex > 0) {
        state.currentIndex--;
        await btnInteraction.editReply(makeSessionMessageOptions(state.currentIndex, state.sessions, activeSessionId()));
      }
    } else if (customId === "sessions:next") {
      await btnInteraction.deferUpdate();
      if (state.currentIndex < state.sessions.length - 1) {
        state.currentIndex++;
        await btnInteraction.editReply(makeSessionMessageOptions(state.currentIndex, state.sessions, activeSessionId()));
      }
    } else if (customId === "sessions:close") {
      await btnInteraction.deferUpdate();
      await btnInteraction.deleteReply().catch(() => {});
      await i.deleteReply().catch(() => {});
      await lifecycle.dispose("user_closed");
    } else if (customId === "sessions:attach") {
      await btnInteraction.deferUpdate();
      const session = state.sessions[state.currentIndex];
      if (session) {
        await actions.attach(session.sessionId);
        await lifecycle.terminal("attached", {
          embeds: [
            new EmbedBuilder()
              .setTitle("Session Attached")
              .setDescription(`🟢 Session \`${session.sessionId}\` has been attached to this channel. Next message will run in this session.`)
              .setColor(0x2ecc71)
          ],
          components: [],
        });
      }
    } else if (customId === "sessions:clone") {
      await btnInteraction.deferUpdate();
      const session = state.sessions[state.currentIndex];
      if (session) {
        try {
          const newSessionId = await actions.clone(session.sessionId);
          state.sessions = await actions.list();
          const newIndex = state.sessions.findIndex(s => s.sessionId === newSessionId);
          if (newIndex !== -1) {
            state.currentIndex = newIndex;
          }
          const opts = makeSessionMessageOptions(state.currentIndex, state.sessions, activeSessionId());
          const embed = opts.embeds?.[0];
          if (embed) {
            embed.setDescription(
              `✨ **Cloned successfully as** \`${newSessionId}\`!\n\n` +
              (embed.data.description ?? "")
            );
          }
          await btnInteraction.editReply(opts);
        } catch (err: any) {
          await btnInteraction.followUp({
            content: `❌ Failed to clone session: ${err.message}`,
            flags: MessageFlags.Ephemeral,
          });
        }
      }
    } else if (customId === "sessions:clone_attach") {
      await btnInteraction.deferUpdate();
      const session = state.sessions[state.currentIndex];
      if (session) {
        try {
          const newSessionId = await actions.clone(session.sessionId);
          state.sessions = await actions.list();

          await actions.attach(newSessionId);

          await lifecycle.terminal("cloned_attached", {
            embeds: [
              new EmbedBuilder()
                .setTitle("Session Cloned & Attached")
                .setDescription(
                  `✨ **Cloned successfully as** \`${newSessionId}\`!\n\n` +
                  `🟢 **This new session has been attached to this channel.** Next message will run in this session.`
                )
                .setColor(0x2ecc71)
            ],
            components: [],
          });
        } catch (err: any) {
          await btnInteraction.followUp({
            content: `❌ Failed to clone and attach session: ${err.message}`,
            flags: MessageFlags.Ephemeral,
          });
        }
      }
    } else if (customId === "sessions:delete") {
      await btnInteraction.deferUpdate();
      const session = state.sessions[state.currentIndex];
      if (session) {
        const confirmEmbed = new EmbedBuilder()
          .setTitle("⚠️ Delete Session?")
          .setDescription(`Are you sure you want to permanently delete session \`${session.sessionId}\`? This action cannot be undone.`)
          .setColor(0xe74c3c);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("sessions:delete_confirm")
            .setLabel("Yes, Delete")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId("sessions:delete_cancel")
            .setLabel("No, Cancel")
            .setStyle(ButtonStyle.Secondary)
        );

        await btnInteraction.editReply({
          embeds: [confirmEmbed],
          components: [row],
        });
      }
    } else if (customId === "sessions:delete_cancel") {
      await btnInteraction.deferUpdate();
      await btnInteraction.editReply(makeSessionMessageOptions(state.currentIndex, state.sessions, activeSessionId()));
    } else if (customId === "sessions:delete_confirm") {
      await btnInteraction.deferUpdate();
      const session = state.sessions[state.currentIndex];
      if (session) {
        try {
          await actions.delete(session.sessionId);
          state.sessions = await actions.list();
          if (state.sessions.length === 0) {
            await btnInteraction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle("No Sessions")
                  .setDescription("All sessions have been deleted.")
                  .setColor(0x7f8c8d)
              ],
              components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId("sessions:close")
                    .setLabel("Close")
                    .setStyle(ButtonStyle.Secondary)
                )
              ],
            });
          } else {
            state.currentIndex = 0;
            await btnInteraction.editReply(makeSessionMessageOptions(state.currentIndex, state.sessions, activeSessionId()));
          }
        } catch (err: any) {
          await btnInteraction.followUp({
            content: `❌ Failed to delete session: ${err.message}`,
            flags: MessageFlags.Ephemeral,
          });
        }
      }
    } else if (customId === "sessions:repair") {
      await btnInteraction.deferUpdate();
      const session = state.sessions[state.currentIndex];
      if (session) {
        const confirmEmbed = new EmbedBuilder()
          .setTitle("⚠️ Repair Session?")
          .setDescription(`This will attempt to repair session \`${session.sessionId}\` by rolling back to the last clean user state. Proceed?`)
          .setColor(0xe74c3c);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("sessions:repair_confirm")
            .setLabel("Yes, Repair")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId("sessions:repair_cancel")
            .setLabel("No, Cancel")
            .setStyle(ButtonStyle.Secondary)
        );

        await btnInteraction.editReply({
          embeds: [confirmEmbed],
          components: [row],
        });
      }
    } else if (customId === "sessions:repair_cancel") {
      await btnInteraction.deferUpdate();
      await btnInteraction.editReply(makeSessionMessageOptions(state.currentIndex, state.sessions, activeSessionId()));
    } else if (customId === "sessions:repair_confirm") {
      await btnInteraction.deferUpdate();
      const session = state.sessions[state.currentIndex];
      if (session && actions.canRepair()) {
        try {
          await actions.repair(session.sessionId);
          state.sessions = await actions.list();
          const opts = makeSessionMessageOptions(state.currentIndex, state.sessions, activeSessionId());
          const embed = opts.embeds?.[0];
          if (embed) {
            embed.setDescription(
              `✨ **Session repaired successfully!**\n\n` +
              (embed.data.description ?? "")
            );
          }
          await btnInteraction.editReply(opts);
        } catch (err: any) {
          await btnInteraction.followUp({
            content: `❌ Failed to repair session: ${err.message}`,
            flags: MessageFlags.Ephemeral,
          });
        }
      }
    } else if (customId === "sessions:rebuild") {
      const observedAtStart = activeSessionId();
      await btnInteraction.deferUpdate();
      await lifecycle.refresh({
        embeds: [
          new EmbedBuilder()
            .setTitle("🏗️ Rebuild")
            .setDescription("Deterministic Discord reconstruction (no summarizer). One destination seed turn.")
            .setColor(0xe67e22)
        ],
        components: [],
      });

      ports.runJob(async () => {
        try {
          const channelRef: ChannelRef = {
            platform: "discord",
            id: i.channelId,
            ...(record.parentRef ? { parentId: record.parentRef } : {}),
          };
          const { newSessionId, attachment, seed, destination } = await actions.rebuild(channelRef, observedAtStart);
          state.sessions = await actions.list();
          const newIndex = state.sessions.findIndex((s) => s.sessionId === newSessionId);
          if (newIndex !== -1) state.currentIndex = newIndex;
          const attachLine = describeAttachOutcome(attachment, {
            newId: newSessionId,
            sourceId: observedAtStart,
          });
          const successEmbed = new EmbedBuilder()
            .setTitle("🏗️ Rebuild complete")
            .setDescription(
              `Destination: \`${destination.agentId}\` · \`${destination.model}\` · window ${destination.contextWindow}\n` +
                `Discord posts ${seed.sourcePostCount} → logical ${seed.projectedLogicalCount}\n` +
                `Retained ${seed.retainedLogicalCount}, omitted ${seed.omittedLogicalCount}\n` +
                `Estimated seed tokens ${seed.estimatedTokens} / ${seed.budgetTokens} (60% budget)` +
                (seed.transformSavedTokens ? `\nNormalization saved ~${seed.transformSavedTokens} tokens` : "") +
                `\nNew session: \`${newSessionId}\`\n${attachLine}`
            )
            .setColor(attachment.attached ? 0x2ecc71 : 0xf1c40f);
          await ports.settle({
            lifecycle,
            view: {
              embeds: [successEmbed],
              components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId("sessions:close")
                    .setLabel("Close")
                    .setStyle(ButtonStyle.Secondary)
                ),
              ],
            },
            channel: browserChannel ?? null,
            fallback: { kind: "rebuild", outcome: "ok" },
          });
        } catch (err: any) {
          logger.error({ err, channelId: i.channelId }, "failed to rebuild session");
          const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Rebuild Failed")
            .setDescription(`An error occurred while reconstructing the session:\n\`\`\`\n${err.message}\n\`\`\``)
            .setColor(0xe74c3c);
          await ports.settle({
            lifecycle,
            view: { embeds: [errorEmbed], components: [backRow()] },
            channel: browserChannel ?? null,
            fallback: { kind: "rebuild", outcome: "failed" },
          });
        }
      });
    } else if (customId === "sessions:compact_thread") {
      await btnInteraction.deferUpdate();
      await lifecycle.refresh({
        embeds: [
          new EmbedBuilder()
            .setTitle("🧵 Compact from Thread")
            .setDescription("Fetching Discord history and asking the destination model for a summary…")
            .setColor(0xe67e22)
        ],
        components: [],
      });

      ports.runJob(async () => {
        try {
          const channelRef = { platform: "discord", id: i.channelId };
          const { newSessionId, summary } = await actions.compactFromThread(channelRef);
          state.sessions = await actions.list();
          const newIndex = state.sessions.findIndex(s => s.sessionId === newSessionId);
          if (newIndex !== -1) state.currentIndex = newIndex;
          const successEmbed = new EmbedBuilder()
            .setTitle("🧵 Compact from Thread complete")
            .setDescription(`Thread was summarized from Discord history.\n\n**New Session ID:** \`${newSessionId}\`\n\n**Summary:**\n${summary.substring(0, 1500)}${summary.length > 1500 ? "..." : ""}`)
            .setColor(0x2ecc71);
          await ports.settle({
            lifecycle,
            view: {
              embeds: [successEmbed],
              components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId("sessions:close")
                    .setLabel("Close")
                    .setStyle(ButtonStyle.Secondary)
                ),
              ],
            },
            channel: browserChannel ?? null,
            fallback: { kind: "compact_thread", outcome: "ok" },
          });
        } catch (err: any) {
          logger.error({ err, channelId: i.channelId }, "failed to compact from thread");
          const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Compact from Thread failed")
            .setDescription(`An error occurred while compacting from Discord history:\n\`\`\`\n${err.message}\n\`\`\``)
            .setColor(0xe74c3c);
          await ports.settle({
            lifecycle,
            view: { embeds: [errorEmbed], components: [backRow()] },
            channel: browserChannel ?? null,
            fallback: { kind: "compact_thread", outcome: "failed" },
          });
        }
      });
    } else if (customId === "sessions:summary") {
      await btnInteraction.deferUpdate();
      const session = state.sessions[state.currentIndex];
      if (session) {
        await btnInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("🪄 Generating AI Summary...")
              .setDescription(`Analyzing transcript logs for session \`${session.sessionId}\`...`)
              .setColor(0xe67e22)
          ],
          components: [],
        });

        ports.runJob(async () => {
          await actions.summary(session.sessionId, async (summaryText) => {
            const displaySummary = summaryText.length > 4000 ? summaryText.substring(0, 3997) + "..." : summaryText;

            const summaryEmbed = new EmbedBuilder()
              .setTitle(`🪄 AI Summary — ${profile.displayName}`)
              .setDescription(
                `**Session ID:** \`${session.sessionId}\`\n\n` +
                `${displaySummary}`
              )
              .setColor(0x9b59b6);

            await ports.settle({
              lifecycle,
              view: { embeds: [summaryEmbed], components: [backRow()] },
              channel: browserChannel ?? null,
              fallback: {
                kind: "summary",
                outcome: "ok",
                recordId: record.id,
                userId: i.user.id,
              },
              fallbackFile: { filename: "session-summary.md", body: summaryText },
            });
          }, async (err: any) => {
            logger.error({ err, sessionId: session.sessionId }, "failed to generate AI summary");

            const errorEmbed = new EmbedBuilder()
              .setTitle("❌ AI Summary Failed")
              .setDescription(`An error occurred while generating the summary:\n\`\`\`\n${err.message}\n\`\`\``)
              .setColor(0xe74c3c);

            await ports.settle({
              lifecycle,
              view: { embeds: [errorEmbed], components: [backRow()] },
              channel: browserChannel ?? null,
              fallback: { kind: "summary", outcome: "failed" },
            });
          });
        });
      }
    } else if (
      customId === "sessions:compact" ||
      customId === "sessions:premium" ||
      customId === "sessions:premium_discord"
    ) {
      const observedAtStart = activeSessionId();
      await btnInteraction.deferUpdate();
      const session = state.sessions[state.currentIndex];
      if (session) {
        if (customId === "sessions:compact") {
          runBrowserCompaction({
            session,
            progressEmbed: new EmbedBuilder()
              .setTitle("🗳️ Compacting Session...")
              .setDescription(
                `Generating compaction summary for session \`${session.sessionId}\` ` +
                `(summary + verbatim recent window + pinned facts)...`
              )
              .setColor(0xe67e22),
            progressPrefix: `Compacting \`${session.sessionId}\`…`,
            successTitle: "🗳️ Session Compacted",
            failureTitle: "❌ Compaction Failed",
            run: async () => {
              const result = await actions.compact(session.sessionId, observedAtStart);
              const { newId, attachment } = result;
              return {
                newId,
                attachment,
                detail:
                  `Compacted into a **new session** \`${newId}\` ` +
                  `(summarized ${result.summarizedTurns} older turn(s), kept ${result.keptTurns} verbatim, ` +
                  `pinned ${result.pinnedCount} fact(s)).`,
              };
            },
          });
        } else {
          const fromDiscord = customId === "sessions:premium_discord";
          runBrowserCompaction({
            session,
            progressEmbed: new EmbedBuilder()
              .setTitle(fromDiscord ? "✨ Premium Compaction (Discord)" : "✨ Premium Compaction")
              .setDescription(
                (fromDiscord
                  ? `Running multi-agent compaction on full Discord history via ${DISCORD_COMPACTION_EXECUTOR_LABEL}…`
                  : `Running multi-agent compaction on \`${session.sessionId}\`…`) +
                `\nThis can take several minutes (fan-out → reduce → deep-dive → synthesize → verify).`
              )
              .setColor(0x9b59b6),
            progressPrefix: fromDiscord
              ? "Compacting from Discord history…"
              : `Compacting \`${session.sessionId}\`…`,
            successTitle: fromDiscord
              ? "✨ Premium Compaction (Discord) Complete"
              : "✨ Premium Compaction Complete",
            failureTitle: "❌ Premium Compaction Failed",
            run: async (onProgress) => {
              const res = await actions.premium(session.sessionId, observedAtStart, {
                fromDiscord, ...(browserChannel ? { channel: browserChannel } : {}), onProgress,
              });
              return {
                newId: res.newId,
                attachment: res.attachment,
                detail:
                  (fromDiscord
                    ? `Compacted from Discord thread history into a **new session** \`${res.newId}\``
                    : `Compacted into a **new session** \`${res.newId}\``) +
                  ` with the multi-agent pipeline (${res.stats.chunks} chunk(s)` +
                  (res.analysisExecutor
                    ? `, analysis ${res.analysisExecutor.displayName} · ${res.analysisExecutor.model}`
                    : "") +
                  `).`,
                ...(res.report ? { report: res.report } : {}),
              };
            },
          });
        }
      }
    } else if (customId === "sessions:import_to_cwd" || btnInteraction.isModalSubmit()) {
      const importId = btnInteraction.isModalSubmit() ? customId.split(":")[2]! : randomUUID();
      const pending = state.imports[importId];
      const session = btnInteraction.isModalSubmit() ? pending?.session : state.sessions[state.currentIndex];
      if (!session) return;
      const compactionModel = btnInteraction.isModalSubmit() ? pending!.model : actions.compactionModel();
      if (!compactionModel) {
        await btnInteraction.reply({ content: "❌ Import is not supported for this agent.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!btnInteraction.isModalSubmit()) {
        const modal = new ModalBuilder()
          .setCustomId(`sessions:import_cwd_modal:${importId}:${state.id}`)
          .setTitle("Import Session to New Cwd")
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("target_cwd")
                .setLabel("Target cwd (absolute or under REPOS_ROOT)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder("/srv/repos/example-project")
            )
          );
        const admitted = { session, model: compactionModel, expires: Date.now() + 120_000 };
        state.imports[importId] = admitted;
        save();
        await btnInteraction.showModal(modal);
        admitted.expires = Date.now() + 120_000;
        save();
        return;
      }
      const submission = btnInteraction;
      delete state.imports[importId];
      save();
      const rawCwd = submission.fields.getTextInputValue("target_cwd").trim();
      let targetCwd: string;
      try {
        targetCwd = actions.resolveImportCwd(rawCwd);
      } catch (err) {
        await submission.reply({
          content: `❌ Invalid cwd: ${(err as Error).message}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await submission.deferUpdate();
      await lifecycle.refresh({
        embeds: [
          new EmbedBuilder()
            .setTitle("📤 Importing Session…")
            .setDescription(
              `Summarizing session \`${session.sessionId}\` and creating a new session under \`${ports.repoDisplay(targetCwd)}\`…`
            )
            .setColor(0xe67e22),
        ],
        components: [],
      });

      ports.runJob(async () => {
        await actions.import(session.sessionId, targetCwd, compactionModel, async (newSessionId) => {
          const successEmbed = new EmbedBuilder()
            .setTitle("📤 Session Imported Successfully!")
            .setDescription(
              `Summary of \`${session.sessionId}\` was seeded into a fresh session.\n\n` +
              `**New Cwd:** \`${ports.repoDisplay(targetCwd)}\`\n` +
              `**New Session ID:** \`${newSessionId}\``
            )
            .setColor(0x2ecc71);
          await ports.settle({
            lifecycle,
            view: { embeds: [successEmbed], components: [backRow()] },
            channel: browserChannel ?? null,
            fallback: { kind: "import", outcome: "ok" },
          });
        }, async (err: any) => {
          logger.error({ err, sessionId: session.sessionId }, "failed to import session");
          const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Import Failed")
            .setDescription(`An error occurred during import:\n\`\`\`\n${err.message}\n\`\`\``)
            .setColor(0xe74c3c);
          await ports.settle({
            lifecycle,
            view: { embeds: [errorEmbed], components: [backRow()] },
            channel: browserChannel ?? null,
            fallback: { kind: "import", outcome: "failed" },
          });
        });
      });
    } else if (customId === "sessions:migrate") {
      await btnInteraction.deferUpdate();
      const session = state.sessions[state.currentIndex];
      if (session) {
        const targetProfiles = actions.capabilities().migrationTargets;

        const embed = new EmbedBuilder()
          .setTitle(`Migrate Session — ${profile.displayName}`)
          .setDescription(
            `Migrate session \`${session.sessionId}\` to a different agent.\n\n` +
            `This will generate a premium AI compaction summary of the current session and initialize a brand-new session under the selected target agent.`
          )
          .setColor(0xf1c40f);

        const select = new StringSelectMenuBuilder()
          .setCustomId("sessions:migrate_target")
          .setPlaceholder("Select target agent...")
          .addOptions(
            targetProfiles.map(p => ({
              label: p.displayName,
              value: p.id,
              description: `Migrate to ${p.displayName} agent`
            }))
          );

        const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("sessions:migrate_cancel")
            .setLabel("⬅ Cancel")
            .setStyle(ButtonStyle.Secondary)
        );

        await btnInteraction.editReply({
          embeds: [embed],
          components: [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
            cancelRow
          ],
        });
      }
    } else if (customId === "sessions:migrate_cancel") {
      await btnInteraction.deferUpdate();
      await btnInteraction.editReply(makeSessionMessageOptions(state.currentIndex, state.sessions, activeSessionId()));
    } else if (btnInteraction.isStringSelectMenu() && customId === "sessions:migrate_target") {
      await btnInteraction.deferUpdate();
      const targetAgentId = btnInteraction.values[0];
      const session = state.sessions[state.currentIndex];
      if (session && targetAgentId) {
        const targetProfile = actions.migrationTarget(targetAgentId);
        if (!targetProfile) {
          await btnInteraction.followUp({
            content: `❌ Target agent \`${targetAgentId}\` is not compatible or does not support session management.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await btnInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("🗳️ Migrating Session...")
              .setDescription(`Generating premium AI compaction summary and initializing new session under agent \`${targetProfile.displayName}\`...`)
              .setColor(0xe67e22)
          ],
          components: [],
        });

        ports.runJob(async () => {
          await targetProfile.migrate(session.sessionId, { id: btnInteraction.user.id, name: btnInteraction.user.name ?? null }, async (newSessionId) => {
            const successEmbed = new EmbedBuilder()
              .setTitle("🎉 Session Migrated Successfully!")
              .setDescription(
                `Successfully migrated to agent **${targetProfile.displayName}**.\n\n` +
                `**New Session ID:** \`${newSessionId}\`\n\n` +
                `🟢 **This new session is now active and attached to this channel.** Any future messages will run in this session.`
              )
              .setColor(0x2ecc71);
            await ports.settle({
              lifecycle,
              view: { embeds: [successEmbed], components: [] },
              mode: "terminal",
              reason: "migrated",
              channel: browserChannel ?? null,
              fallback: { kind: "migration", outcome: "ok" },
            });
          }, async (err: any) => {
            logger.error({ err, sessionId: session.sessionId }, "failed to migrate session");

            const errorEmbed = new EmbedBuilder()
              .setTitle("❌ Migration Failed")
              .setDescription(`An error occurred during migration:\n\`\`\`\n${err.message}\n\`\`\``)
              .setColor(0xe74c3c);
            await ports.settle({
              lifecycle,
              view: { embeds: [errorEmbed], components: [backRow()] },
              channel: browserChannel ?? null,
              fallback: { kind: "migration", outcome: "failed" },
            });
          });
        });
      }
    } else if (customId === "sessions:summary_back") {
      await btnInteraction.deferUpdate();
      await btnInteraction.editReply(makeSessionMessageOptions(state.currentIndex, state.sessions, activeSessionId()));
    }
  };
  return { handle, lifecycle, checkpoint: save, render: () => i.editReply(makeSessionMessageOptions(state.currentIndex, state.sessions, activeSessionId())),
    expire: () => lifecycle.expire("time") };

}
export function routeView(view: CardView, id: string): CardView {
  const route = (node: any): any => {
    const plain = typeof node?.toJSON === "function" ? node.toJSON() : node;
    return { ...plain,
      ...(plain?.custom_id?.startsWith("sessions:") ? { custom_id: plain.custom_id + ":" + id } : {}),
      ...(plain?.components ? { components: plain.components.map(route) } : {}),
    };
  };
  return { ...view, ...(view.components ? { components: view.components.map(route) } : {}) };
}
