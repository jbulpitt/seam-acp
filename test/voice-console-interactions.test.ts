import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

const logger = pino({ level: "silent" }) as unknown as Logger;

function fixture() {
  const console = {
    id: "tvc_abc",
    status: "ready",
    ownerUserId: "owner",
    voiceChannelId: "voice-chat",
    cardMessageId: "canonical-card",
    revision: 1,
    fanoutArmed: false,
  };
  const bindings = [
    { id: "tvb_a", consoleId: console.id },
    { id: "tvb_b", consoleId: console.id },
  ];
  const mutationLedger = new Map<string, string>();
  let durableApplications = 0;
  const store = {
    getVoiceConsole: vi.fn(() => console),
    listVoiceConsoleBindings: vi.fn(() => bindings),
    listVoiceConsoleInputTargets: vi.fn(() => []),
  };
  const control = {
    setInputTargets: vi.fn(async (
      _consoleId: string,
      bindingIds: readonly string[],
      fanoutArmed: boolean,
      expectedRevision: number,
      interactionId?: string
    ) => {
      const fingerprint = JSON.stringify({ bindingIds, fanoutArmed, expectedRevision });
      const prior = interactionId ? mutationLedger.get(interactionId) : undefined;
      if (prior !== undefined) {
        return prior === fingerprint
          ? { ok: true as const, value: { applied: false, console, bindings } }
          : { ok: false as const, error: "Voice Console interaction id collision." };
      }
      if (expectedRevision !== console.revision) {
        return { ok: false as const, error: "Console changed; refresh." };
      }
      if (interactionId) mutationLedger.set(interactionId, fingerprint);
      durableApplications++;
      console.revision++;
      return { ok: true as const, value: { applied: true, console, bindings } };
    }),
    refreshCard: vi.fn(async () => {}),
  };
  const orchestrator = new Orchestrator({
    logger,
    config: {
      DATA_DIR: "/tmp",
      REPOS_ROOT: "/repo",
      TURN_TIMEOUT_SECONDS: 60,
      SEAM_CONFIG_ADMIN_USER_IDS: new Set<string>(),
    } as never,
    adapter: {} as never,
    router: {
      listProfiles: () => [],
      describeConfig: () => ({}),
    } as never,
    store: store as never,
    renderer: {} as never,
  });
  orchestrator.setVoiceConsoleManager({} as never, control as never);

  const event = (interactionId: string, values = ["tvb_a"], messageId = "canonical-card") => ({
    customId: "tvc:tvc_abc:1:input",
    interactionId,
    kind: "select" as const,
    values,
    userId: "owner",
    messageId,
    channel: { platform: "discord", id: "voice-chat" },
    deferUpdate: vi.fn(async () => {}),
    replyEphemeral: vi.fn(async () => {}),
    followUpEphemeral: vi.fn(async () => {}),
  });
  const handle = (evt: ReturnType<typeof event>) =>
    (orchestrator as unknown as {
      handleVoiceConsoleComponent(input: ReturnType<typeof event>): Promise<void>;
    }).handleVoiceConsoleComponent(evt);

  return {
    console,
    control,
    event,
    handle,
    durableApplications: () => durableApplications,
  };
}

describe("Voice Console component revision and idempotency boundary", () => {
  it("lets an exact duplicate reach the durable replay ledger after revision advances", async () => {
    const subject = fixture();
    const first = subject.event("interaction-1");
    await subject.handle(first);
    expect(subject.console.revision).toBe(2);
    expect(subject.durableApplications()).toBe(1);

    const duplicate = subject.event("interaction-1");
    await subject.handle(duplicate);
    expect(subject.durableApplications()).toBe(1);
    expect(subject.control.setInputTargets).toHaveBeenCalledTimes(2);
    expect(duplicate.deferUpdate).toHaveBeenCalledOnce();
    expect(duplicate.replyEphemeral).not.toHaveBeenCalled();
  });

  it("rejects a new stale interaction and an interaction-id fingerprint collision", async () => {
    const subject = fixture();
    await subject.handle(subject.event("interaction-1"));

    const stale = subject.event("interaction-2");
    await subject.handle(stale);
    expect(subject.durableApplications()).toBe(1);
    expect(stale.deferUpdate).toHaveBeenCalledOnce();
    expect(stale.followUpEphemeral).toHaveBeenCalledWith("Console changed; refresh.");

    const collision = subject.event("interaction-1", ["tvb_b"]);
    await subject.handle(collision);
    expect(subject.durableApplications()).toBe(1);
    expect(collision.deferUpdate).toHaveBeenCalledOnce();
    expect(collision.followUpEphemeral).toHaveBeenCalledWith(
      "Voice Console interaction id collision."
    );
  });

  it("rejects copied controls from a non-canonical message before mutation", async () => {
    const subject = fixture();
    const copied = subject.event("interaction-copied", ["tvb_a"], "copied-card");
    await subject.handle(copied);
    expect(subject.durableApplications()).toBe(0);
    expect(subject.control.setInputTargets).not.toHaveBeenCalled();
    expect(copied.replyEphemeral).toHaveBeenCalledWith(
      "That Voice Console card was replaced. Use the current canonical card."
    );
  });

  it("does not let forged select values arm fan-out implicitly", async () => {
    const subject = fixture();
    const forged = subject.event("interaction-fanout", ["tvb_a", "tvb_b"]);
    await subject.handle(forged);
    expect(subject.durableApplications()).toBe(0);
    expect(subject.control.setInputTargets).not.toHaveBeenCalled();
    expect(forged.replyEphemeral).toHaveBeenCalledWith(
      "Arm fan-out before selecting more than one input binding."
    );
  });

  it("rejects a modal submission without its registered originating editor message", async () => {
    const subject = fixture();
    const modal = {
      ...subject.event("interaction-modal", [], ""),
      customId: "tvc:tvc_abc:1:alias-save:tvb_a",
      kind: "modal" as const,
      fields: { alias: "Renamed" },
    };
    await subject.handle(modal as never);
    expect(subject.durableApplications()).toBe(0);
    expect(modal.replyEphemeral).toHaveBeenCalledWith(
      "That Voice Console card was replaced. Use the current canonical card."
    );
  });
});
