import type { AgentProfile, ISessionManager, SessionSummary } from "@seam/adapters";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRuntime } from "../agents/agent-runtime.js";
import type { Logger } from "../lib/logger.js";
import type { ChannelRef } from "../platforms/chat-adapter.js";
import type { CatalogBinding, ModelCatalogService } from "./model-catalog/service.js";
import type { PremiumCompactionResult } from "./compaction/pipeline.js";
import type { assembleReconstruction } from "./reconstruction/index.js";
import { isDiscordPremiumCompactAvailable } from "./compaction/discord-executor.js";
import { resolveRepoPath } from "./path-utils.js";
import type { SessionRecord } from "./types.js";
import type { SessionRouter } from "./session-router.js";
import type { SessionStore } from "./session-store.js";
import type { RuntimeTransition } from "./runtime-transition.js";
import type { MutationActor } from "./config-mutation.js";
import { planSessionAttachment, type AttachIntent, type AttachOutcome } from "./session-attach.js";

interface BindingDeps {
  store: SessionStore;
  router: SessionRouter;
  logger: Logger;
}

export interface RebuiltSession {
  newSessionId: string;
  attachment: AttachOutcome;
  seed: ReturnType<typeof assembleReconstruction>;
  destination: { agentId: string; model: string; contextWindow: number };
}

interface SessionActionServices {
  modelCatalog: ModelCatalogService;
  reposRoot: string;
  compactionModel(binding: CatalogBinding): string;
  compactionWindow(binding: CatalogBinding, model: string): number;
  launch(args: {
    profile: AgentProfile; location: string; cwd: string; model?: string;
    effort?: string; sessionId: string;
  }): Pick<ConstructorParameters<typeof AgentRuntime>[0], "spawnFn" | "mcpServers">;
  cleanup(args: {
    location: string; profile: AgentProfile; manager: ISessionManager;
    cwd: string; sessionId: string; label: string;
  }): Promise<void>;
  seed(args: {
    profile: AgentProfile; restrictionChannelId: string; cwd: string;
    model?: string; effort?: string; summary: string; location: string; sessionId: string;
  }): Promise<string>;
  buildSeed(args: {
    profile: AgentProfile; manager: ISessionManager; agentId: string; location: string;
    cwd: string; sessionId: string; restrictionChannelId: string;
  }): Promise<{ seed: string; keptTurns: number; summarizedTurns: number; pinnedCount: number } | null>;
  rebuild(args: {
    record: SessionRecord; channel: ChannelRef; observedAtStart: string; attachIntent: AttachIntent;
  }): Promise<RebuiltSession>;
  compactFromThread(channel: ChannelRef, record: SessionRecord): Promise<{ newSessionId: string; summary: string }>;
  premium(record: SessionRecord, opts: {
    source?: "session" | "discord"; sessionId: string; channel?: ChannelRef;
    attachIntent: AttachIntent; observedAtStart: string; onProgress?: (line: string) => void;
  }): Promise<{
    newSessionId: string; attachment: AttachOutcome; reportMarkdown: string;
    stats: PremiumCompactionResult["stats"]; analysisExecutor: PremiumCompactionResult["analysisExecutor"];
  }>;
  adoptMigration: RuntimeTransition["adoptMigratedSession"];
}

export interface SessionBrowserCapabilities {
  canCompact: boolean;
  canRepair: boolean;
  canPremiumSession: boolean;
  canPremiumDiscord: boolean;
  migrationTargets: Array<{ id: string; displayName: string }>;
}

export interface CompactedSessionAttachment {
  record: SessionRecord;
  sourceId: string;
  newId: string;
  observedAtStart: string;
  intent: AttachIntent;
}

/** The authoritative binding decision shared by browser and programmatic jobs. */
export async function attachCompactedSession(
  deps: BindingDeps,
  opts: CompactedSessionAttachment,
): Promise<AttachOutcome> {
  const { store, router, logger } = deps;
  const { record, sourceId, newId, observedAtStart, intent } = opts;
  const fresh = store.get(record.id);
  const plan = planSessionAttachment({
    current: fresh ? fresh.acpSessionId : null,
    observedAtStart,
    sourceId,
    newId,
    intent,
  });
  let outcome: AttachOutcome;
  if (plan.action === "cas") {
    if (store.compareAndSwapAcpSession(record.id, plan.expect, plan.next)) {
      outcome = { attached: true, reason: plan.reason };
      await router.invalidate(record.id, { clearAcpSession: false });
    } else {
      outcome = { attached: false, reason: "rebound-elsewhere" };
    }
  } else if (plan.action === "noop") {
    outcome = { attached: true, reason: plan.reason };
  } else {
    outcome = { attached: false, reason: plan.reason };
  }
  const settled = store.get(record.id);
  if (settled) record.acpSessionId = settled.acpSessionId;
  logger.info({ recordId: record.id, sourceId, newId, intent, outcome }, "compaction attachment decided");
  return outcome;
}

/** Internal operations bound to the browser's original execution host and cwd. */
export class SessionActions {
  constructor(private readonly deps: BindingDeps & {
    record: SessionRecord;
    manager: ISessionManager;
    cwd: string;
    profile: AgentProfile;
    binding: CatalogBinding;
    services: SessionActionServices;
  }) {}

  get info() {
    const { record, profile, cwd } = this.deps;
    return { id: record.id, platform: record.platform, channelRef: record.channelRef,
      parentRef: record.parentRef, agentId: record.agentId, acpSessionId: record.acpSessionId,
      cwd, displayName: profile.displayName };
  }

  snapshot(): string {
    const { record, binding, cwd } = this.deps;
    return JSON.stringify({ record, binding, cwd });
  }

  capabilities(): SessionBrowserCapabilities {
    const { manager, binding, services, router, record } = this.deps;
    const canCompact = services.compactionModel(binding) !== "";
    return {
      canCompact,
      canRepair: typeof manager.repairSession === "function",
      canPremiumSession: canCompact && typeof manager.getHistoryPath === "function",
      canPremiumDiscord: isDiscordPremiumCompactAvailable((id) => router.getProfile(id)),
      migrationTargets: router.listProfiles()
        .filter((p) => p.id !== record.agentId && !!p.sessionManager)
        .map((p) => ({ id: p.id, displayName: p.displayName })),
    };
  }

  migrationTarget(agentId: string) {
    const profile = this.deps.router.getProfile(agentId);
    return profile?.sessionManager ? {
      id: profile.id, displayName: profile.displayName,
      migrate: (sessionId: string, actor: MutationActor, complete: (newSessionId: string) => Promise<void>,
        failed?: (error: unknown) => Promise<void>) => this.migrateTo(sessionId, profile, actor, complete, failed),
    } : undefined;
  }

  rebuild(channel: ChannelRef, observedAtStart: string): Promise<RebuiltSession> {
    return this.deps.services.rebuild({ record: this.deps.record, channel, observedAtStart, attachIntent: "attach" });
  }

  compactFromThread(channel: ChannelRef): Promise<{ newSessionId: string; summary: string }> {
    return this.deps.services.compactFromThread(channel, this.deps.record);
  }

  async compact(sessionId: string, observedAtStart: string) {
    const { record, profile, manager, binding, cwd, services, store } = this.deps;
    if (!services.compactionModel(binding)) {
      throw new Error(`Compaction is not supported for agent profile \`${record.agentId}\` (no summarizer model).`);
    }
    const built = await services.buildSeed({
      profile, manager, agentId: record.agentId, location: binding.location, cwd, sessionId,
      restrictionChannelId: record.parentRef ?? record.channelRef,
    });
    if (!built) throw new Error("Nothing to compact (empty transcript or no summarizer model).");
    const cfg = store.readConfig(record);
    const newId = await services.seed({
      profile, restrictionChannelId: record.parentRef ?? record.channelRef, cwd,
      location: binding.location, sessionId: record.id,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
      summary: built.seed,
    });
    const attachment = await this.attachCompacted({ sourceId: sessionId, newId, observedAtStart, intent: "attach" });
    return { newId, attachment, keptTurns: built.keptTurns, summarizedTurns: built.summarizedTurns, pinnedCount: built.pinnedCount };
  }

  async premium(sessionId: string, observedAtStart: string, opts: {
    fromDiscord: boolean; channel?: ChannelRef; onProgress?: (line: string) => void;
  }) {
    const result = await this.deps.services.premium(this.deps.record, {
      ...(opts.fromDiscord ? { source: "discord" as const } : {}),
      sessionId, ...(opts.channel ? { channel: opts.channel } : {}),
      attachIntent: "attach", observedAtStart, onProgress: opts.onProgress,
    });
    const name = `premium-compaction${opts.fromDiscord ? "-discord" : ""}-${sessionId}.md`;
    const reportPath = path.join(os.tmpdir(), name);
    const wrote = await fsp.writeFile(reportPath, result.reportMarkdown, "utf8").then(() => true).catch(() => false);
    return {
      newId: result.newSessionId, attachment: result.attachment,
      stats: result.stats, analysisExecutor: result.analysisExecutor,
      ...(wrote ? { report: { path: reportPath, name } } : {}),
    };
  }

  activeSessionId(): string {
    const { record, store } = this.deps;
    const fresh = store.get(record.id);
    if (fresh) record.acpSessionId = fresh.acpSessionId;
    return record.acpSessionId;
  }

  list(): Promise<SessionSummary[]> {
    return this.deps.manager.listSessions(this.deps.cwd);
  }

  transcript(sessionId: string): Promise<string> {
    return this.deps.manager.getTranscript(this.deps.cwd, sessionId);
  }

  async clone(sourceId: string, newId: string = randomUUID()): Promise<string> {
    await this.deps.manager.cloneSession(this.deps.cwd, sourceId, newId);
    return newId;
  }

  async attach(sessionId: string): Promise<void> {
    const { record, store, router } = this.deps;
    await router.invalidate(record.id);
    store.upsert({ ...record, acpSessionId: sessionId, updatedUtc: new Date().toISOString() });
    const fresh = store.get(record.id);
    if (fresh) record.acpSessionId = fresh.acpSessionId;
  }

  async delete(sessionId: string): Promise<void> {
    const { record, manager, cwd, store, router } = this.deps;
    await manager.deleteSession(cwd, sessionId);
    if (record.acpSessionId === sessionId) {
      await router.invalidate(record.id, { clearAcpSession: true, operatorIntent: "replace-session" });
      const fresh = store.get(record.id);
      record.acpSessionId = fresh ? fresh.acpSessionId : "";
    }
  }

  async repair(sessionId: string): Promise<void> {
    const { record, manager, cwd, router } = this.deps;
    await manager.repairSession!(cwd, sessionId);
    if (record.acpSessionId === sessionId) await router.invalidate(record.id);
  }

  summary(sessionId: string, complete: (summary: string) => Promise<void>, failed?: (error: unknown) => Promise<void>): Promise<void> {
    return this.summarize(sessionId, "summary", this.deps.cwd, complete, failed);
  }

  resolveImportCwd(raw: string): string {
    return resolveRepoPath(this.deps.services.reposRoot, raw);
  }

  import(sessionId: string, targetCwd: string, compactionModel: string,
    complete: (newSessionId: string) => Promise<void>, failed?: (error: unknown) => Promise<void>): Promise<void> {
    const { record, profile, binding, services, store, router } = this.deps;
    return this.summarize(sessionId, "import", targetCwd, async (summary) => {
      const cfg = store.readConfig(record);
      const newSessionId = await services.seed({
        profile, restrictionChannelId: record.parentRef ?? record.channelRef, cwd: targetCwd,
        location: binding.location, sessionId: record.id,
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}), summary,
      });
      await router.invalidate(record.id);
      const importedCfg = store.readConfig(record);
      importedCfg.sessionCwdExplicit = true;
      store.upsert({
        ...record, repoPath: targetCwd, acpSessionId: newSessionId,
        configJson: store.writeConfig(importedCfg), updatedUtc: new Date().toISOString(),
      });
      await complete(newSessionId);
    }, failed, compactionModel);
  }

  migrate(sessionId: string, targetAgentId: string, actor: MutationActor, complete: (newSessionId: string) => Promise<void>,
    failed?: (error: unknown) => Promise<void>): Promise<void> {
    return this.migrateTo(sessionId, this.deps.router.getProfile(targetAgentId)!, actor, complete, failed);
  }

  private migrateTo(sessionId: string, targetProfile: AgentProfile, actor: MutationActor, complete: (newSessionId: string) => Promise<void>,
    failed?: (error: unknown) => Promise<void>): Promise<void> {
    const { record, binding, services, cwd } = this.deps;
    return this.summarize(sessionId, "migrate", cwd, async (summary) => {
      const selection = services.modelCatalog.resolve({ agentId: targetProfile.id, location: binding.location }, { model: "default" });
      const newSessionId = await services.seed({
        profile: targetProfile, restrictionChannelId: record.parentRef ?? record.channelRef, cwd,
        location: binding.location, sessionId: record.id, summary, model: selection.raw.model,
        ...(selection.raw.effort ? { effort: selection.raw.effort } : {}),
      });
      await services.adoptMigration(record, { agent: targetProfile.id, model: selection.normalized.model,
        effort: selection.normalized.effort, acpSessionId: newSessionId }, actor);
      await complete(newSessionId);
    }, failed);
  }

  private async summarize(sessionId: string, kind: "summary" | "import" | "migrate", cwd: string,
    complete: (summary: string) => Promise<void>, failed?: (error: unknown) => Promise<void>, compactionModel?: string): Promise<void> {
    const { profile, binding, record, router, services, logger, manager } = this.deps;
    let runtime: AgentRuntime | undefined;
    try {
      const transcript = await this.transcript(sessionId);
      if (!transcript.trim()) throw new Error("The session transcript is empty.");
      let sanitized = transcript.split("\n")
        .map((line) => line.length > 1000 ? line.substring(0, 1000) + " ... [Line truncated]" : line).join("\n");
      const selection = kind === "summary" ? services.modelCatalog.resolve(binding, { model: "default" }) : undefined;
      const model = selection ? selection.raw.model : compactionModel ?? services.compactionModel(binding);
      let prompt: string;
      if (kind === "summary") {
        if (sanitized.length > 50000) {
          sanitized = sanitized.substring(0, 15000) + "\n\n... [Transcript truncated due to length limits] ...\n\n" +
            sanitized.substring(sanitized.length - 30000);
        }
        prompt = "Please summarize the following conversation session. Highlight:\n" +
          "1. The primary goal of the session.\n" +
          "2. What key changes, debugging steps, or features were implemented.\n" +
          "3. The current status or remaining tasks.\n\n" + "Conversation Transcript:\n" + sanitized;
      } else {
        if (kind === "migrate" && !model) {
          throw new Error(`Migration compaction is not supported for source agent profile \`${record.agentId}\``);
        }
        const template = await fsp.readFile(path.join(services.reposRoot, "compact.md"), "utf8");
        sanitized = fitTranscriptToWindow(sanitized, template.length + "\n\nConversation Transcript:\n".length,
          services.compactionWindow(binding, model));
        prompt = `${template}\n\nConversation Transcript:\n${sanitized}`;
      }
      router.assertAgentAllowedForRecord(record, profile.id);
      const effort = selection?.raw.effort;
      const launch = services.launch({ profile, location: binding.location, cwd, model,
        ...(effort ? { effort } : {}), sessionId: record.id });
      runtime = new AgentRuntime({
        profile, logger: logger.child({ session: `temp-${kind}-${sessionId}` }),
        ...router.permissionOptions(record), mcpServers: launch.mcpServers, spawnFn: launch.spawnFn,
        ...(selection?.model ? { effortDescriptor: selection.model.effort } : {}),
      });
      await runtime.start();
      await runtime.newSession(kind === "summary"
        ? { cwd, model, ...(effort ? { effort } : {}), strictModel: true }
        : { cwd, model, meta: { reasoningEffort: "low" } });
      let summary = "";
      runtime.onEvent((event) => { if (event.kind === "agent-text") summary += event.text; });
      await runtime.prompt(prompt);
      if (!summary.trim()) throw new Error("Agent completed but returned an empty summary.");
      await complete(summary);
    } catch (error) {
      if (!failed) throw error;
      await failed(error);
    } finally {
      if (runtime) {
        const tempSessionId = runtime.getSessionInfo()?.sessionId;
        await runtime.dispose().catch(() => {});
        if (tempSessionId) await services.cleanup({ location: binding.location, profile, manager, cwd,
          sessionId: tempSessionId, label: `failed to clean up temporary ${kind === "migrate" ? "migration" : kind} session` });
      }
    }
  }

  compactionModel(): string {
    return this.deps.services.compactionModel(this.deps.binding);
  }

  canRepair(): boolean {
    return typeof this.deps.manager.repairSession === "function";
  }

  attachCompacted(input: Omit<CompactedSessionAttachment, "record">): Promise<AttachOutcome> {
    return attachCompactedSession(this.deps, { ...input, record: this.deps.record });
  }
}

/** Keep the same head/tail transcript budget used by the summarizer. */
export function fitTranscriptToWindow(transcript: string, templateOverhead: number, modelWindowTokens: number): string {
  const targetLen = Math.max(0, Math.floor(modelWindowTokens * 4 * 0.8) - templateOverhead);
  if (transcript.length <= targetLen) return transcript;
  const keepHead = Math.floor(targetLen * 0.3);
  const keepTail = Math.floor(targetLen * 0.6);
  return transcript.substring(0, keepHead) + "\n\n... [Transcript truncated to fit context window] ...\n\n" +
    transcript.substring(transcript.length - keepTail);
}
