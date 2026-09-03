import { describe, it, expect } from "vitest";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import {
  ConfigEditorStore,
  HUB_FIELD_ACTIONS,
  INHERIT_VALUE,
  RIDER_FILE_MAX_BYTES,
  applyPickerValue,
  authorizeDraftClick,
  buildSavePlan,
  currentChannelRiderText,
  currentThreadRiderText,
  decodeRiderUpload,
  draftAfterSave,
  effectiveAgentAtLocation,
  dirtyChannelRider,
  dirtyChannelAgent,
  dirtyPermission,
  dirtyChannelStatusCardStyle,
  dirtyStatusCardStyle,
  dirtySimpleCardGif,
  dirtyChannelSimpleCardGif,
  dirtyThreadPresetChanges,
  isDirty,
  makeCustomId,
  parseCustomId,
  renderCancelledHub,
  renderExpiredHub,
  renderHub,
  renderSavedHub,
  riderDownloadFilename,
  snapshotFromDescribe,
  type DraftAgentCapabilities,
  type InheritedConfig,
  type ThreadConfigDraft,
  type ThreadConfigSnapshot,
} from "../packages/core/src/platforms/discord/config-editor.js";
import type { ConfigDescription } from "../packages/core/src/core/session-router.js";

const WITHOUT: InheritedConfig = {
  location: "local",
  agent: "copilot",
  model: "gpt-5.4",
  effort: null,
  cwd: "/repo/session",
  permission: "ask",
  detached: false,
  statusCardStyle: "full",
  simpleCardGif: false,
  role: null,
  disableThreadPrefix: false,
};

function setting<T>(value: T, source: ConfigDescription["agent"]["source"]) {
  return { value, source };
}

function snapshot(over: Partial<ThreadConfigSnapshot> = {}): ThreadConfigSnapshot {
  return {
    location: setting("local", "default"),
    agent: setting("copilot", "session config"),
    model: setting("gpt-5.4", "session config"),
    effort: setting(null, "default"),
    cwd: setting("/repo/session", "session config"),
    permission: setting("ask", "default"),
    detached: setting(false, "default"),
    statusCardStyle: setting("full", "default"),
    simpleCardGif: setting(false, "default"),
    role: setting(null, "default"),
    disableThreadPrefix: setting(false, "default"),
    rider: {},
    locked: false,
    channelPins: {},
    withoutThread: { ...WITHOUT },
    ...over,
  };
}

function draft(over: Partial<ThreadConfigDraft> = {}): ThreadConfigDraft {
  const now = Date.now();
  return {
    id: "draft-1",
    threadId: "thread-1",
    parentRef: "chan-1",
    userId: "user-1",
    messageId: "msg-1",
    createdAt: now,
    updatedAt: now,
    snapshot: snapshot(),
    overlay: {},
    warnings: [],
    ...over,
  };
}

const copilotCaps: DraftAgentCapabilities = {
  staticModels: [{ modelId: "gpt-5.4" }, { modelId: "gpt-5.5" }],
  effortMechanism: "none",
  effortLevels: [],
};
const claudeCaps: DraftAgentCapabilities = {
  staticModels: [{ modelId: "claude-opus-4.6" }, { modelId: "claude-sonnet-4.6" }],
  effortMechanism: "meta",
  effortLevels: ["low", "medium", "high"],
};

function caps(agentId: string): DraftAgentCapabilities | undefined {
  if (agentId === "claude") return claudeCaps;
  if (agentId === "copilot") return copilotCaps;
  return undefined;
}

describe("config editor custom_id", () => {
  it("round-trips seam-cfg-edit:<draftId>:<action>", () => {
    const id = makeCustomId("abc-uuid", "host");
    expect(id).toBe("seam-cfg-edit:abc-uuid:host");
    expect(parseCustomId(id)).toEqual({ draftId: "abc-uuid", action: "host" });
    expect(parseCustomId("seam-cfg-edit:abc-uuid:rider-save")).toEqual({
      draftId: "abc-uuid",
      action: "rider-save",
    });
    expect(parseCustomId("seam-cfg-edit:abc-uuid:rider-get")).toEqual({
      draftId: "abc-uuid",
      action: "rider-get",
    });
    expect(parseCustomId("seam-cfg-edit:abc-uuid:scope")).toEqual({
      draftId: "abc-uuid",
      action: "scope",
    });
    expect(parseCustomId("seam-pick:1")).toBeNull();
  });
});

describe("rider file download / upload", () => {
  it("currentThreadRiderText prefers overlay then snapshot", () => {
    expect(currentThreadRiderText(draft())).toBeNull();
    expect(
      currentThreadRiderText(draft({ snapshot: snapshot({ rider: { thread: "saved" } }) }))
    ).toBe("saved");
    expect(
      currentThreadRiderText(
        draft({
          snapshot: snapshot({ rider: { thread: "saved" } }),
          overlay: { rider: "draft" },
        })
      )
    ).toBe("draft");
    expect(
      currentThreadRiderText(
        draft({
          snapshot: snapshot({ rider: { thread: "saved" } }),
          overlay: { rider: null },
        })
      )
    ).toBeNull();
    expect(
      currentChannelRiderText(draft({ snapshot: snapshot({ rider: { channel: "ch pin" } }) }))
    ).toBe("ch pin");
    expect(
      currentChannelRiderText(
        draft({
          snapshot: snapshot({ rider: { channel: "ch pin" } }),
          overlay: { channelRider: "draft ch" },
        })
      )
    ).toBe("draft ch");
  });

  it("decodeRiderUpload accepts utf-8 md/txt, empty means inherit, rejects binary and huge", () => {
    expect(decodeRiderUpload(Buffer.from("# hi\n", "utf8"), "rider.md")).toEqual({
      ok: true,
      text: "# hi\n",
    });
    expect(decodeRiderUpload(Buffer.from("   \n", "utf8"), "x.txt")).toEqual({
      ok: true,
      text: null,
    });
    expect(decodeRiderUpload(Buffer.from("nope"), "photo.png").ok).toBe(false);
    expect(decodeRiderUpload(Buffer.from([0, 1, 2]), "x.md").ok).toBe(false);
    const huge = Buffer.alloc(RIDER_FILE_MAX_BYTES + 1, 97);
    expect(decodeRiderUpload(huge, "x.md").ok).toBe(false);
  });

  it("riderDownloadFilename is a safe .md name", () => {
    expect(riderDownloadFilename("1539280857473482835")).toBe("rider-1539280857473482835.md");
    expect(riderDownloadFilename("1539280857473482835", "channel")).toBe(
      "rider-channel-1539280857473482835.md"
    );
    expect(riderDownloadFilename("../../etc")).toMatch(/^rider-.*\.md$/);
    expect(riderDownloadFilename("../../etc")).not.toMatch(/\.\./);
  });
});

describe("hub render (#90)", () => {
  it("unset / default fields show not set or default source", () => {
    const panel = renderHub(draft());
    expect(panel.title).toBe("🧩 Thread config");
    const host = panel.fields.find((f) => f.name === "Host")!.value;
    expect(host).toMatch(/default/);
    const effort = panel.fields.find((f) => f.name === "Effort")!.value;
    expect(effort).toMatch(/not set/);
    const rider = panel.fields.find((f) => f.name === "Rider")!.value;
    expect(rider).toMatch(/\(none\)/);
    expect(panel.footer).toMatch(/applies on the next turn/);
    expect(panel.actions).toHaveLength(4);
    expect(panel.actions![0].map((b) => b.label)).toEqual([
      "Agent",
      "Model",
      "Effort",
      "Repo",
    ]);
    expect(panel.actions![1].map((b) => b.label)).toEqual([
      "Approve",
      "Rider",
      "Download",
      "Upload",
      "Attach",
    ]);
    expect(panel.actions![2].map((b) => b.label)).toEqual([
      "Save",
      "Cancel",
      "Card",
      "GIF",
      "Channel",
    ]);
    expect(panel.actions![3].map((b) => b.label)).toEqual(["Role", "Auto-name", "Fast"]);
    expect(panel.fields.find((f) => f.name === "Role")!.value).toMatch(/not set/);
    expect(panel.fields.find((f) => f.name === "Auto-name")!.value).toMatch(/enabled/);
    expect(panel.actions![2][0]!.disabled).toBe(true);
  });

  it("inherited (channel) source is labeled channel", () => {
    const d = draft({
      snapshot: snapshot({
        model: setting("claude-opus-4.6", "channel preset"),
        agent: setting("claude", "channel preset"),
      }),
    });
    const panel = renderHub(d);
    expect(panel.fields.find((f) => f.name === "Model")!.value).toMatch(/channel/);
    expect(panel.fields.find((f) => f.name === "Agent")!.value).toMatch(/channel/);
  });

  it("thread overlay source is labeled thread", () => {
    const d = draft({
      snapshot: snapshot({
        model: setting("claude-haiku-4.5", "thread preset"),
        rider: { thread: "homework only" },
      }),
    });
    const panel = renderHub(d);
    expect(panel.fields.find((f) => f.name === "Model")!.value).toMatch(/thread/);
    expect(panel.fields.find((f) => f.name === "Rider")!.value).toMatch(/homework/);
  });

  it("draft dirty state shows will-be / will-inherit and enables Save", () => {
    const d = draft({
      overlay: { model: "gpt-5.5", agent: null },
    });
    const panel = renderHub(d);
    expect(panel.fields.find((f) => f.name === "Model")!.value).toMatch(/will be/);
    expect(panel.fields.find((f) => f.name === "Agent")!.value).toMatch(/will inherit/);
    expect(panel.actions![2][0]!.disabled).toBe(false);
  });

  it("session-reset warning appears when host/agent will change", () => {
    const d = draft({ overlay: { agent: "claude" } });
    const panel = renderHub(d);
    expect(panel.footer).toMatch(/reset the ACP session/);
  });

  it("disables Effort when the draft agent has no effort mechanism", () => {
    const panel = renderHub(draft(), { effortDisabled: true });
    expect(panel.actions![0].find((b) => b.label === "Effort")!.disabled).toBe(true);
  });

  it("expired / cancelled hubs clear action rows", () => {
    expect(renderExpiredHub(draft()).actions).toEqual([]);
    expect(renderCancelledHub(draft()).actions).toEqual([]);
    expect(renderExpiredHub(draft()).footer).toMatch(/expired/);
  });

  it("saved hub shows committed values, not will-be notes, and clears buttons", () => {
    const panel = renderSavedHub(draft({ overlay: { model: "gpt-5.5" } }));
    const model = panel.fields.find((f) => f.name === "Model")!.value;
    expect(model).toMatch(/gpt-5\.5/);
    expect(model).not.toMatch(/will be/);
    expect(panel.actions).toEqual([]);
    expect(panel.footer).toMatch(/Saved/);
    expect(panel.footer).toMatch(/next turn/);
  });

  it("rider longer than 4000 still leaves Rider enabled so Clear/Inherit is reachable", () => {
    const long = "x".repeat(4001);
    const panel = renderHub(
      draft({ snapshot: snapshot({ rider: { thread: long } }) })
    );
    const rider = panel.fields.find((f) => f.name === "Rider")!.value;
    expect(rider).toMatch(/too long for modal/);
    expect(panel.actions![1].find((b) => b.label === "Rider")!.disabled).not.toBe(true);
    expect(panel.actions![1].find((b) => b.label === "Download")).toBeTruthy();
    expect(panel.actions![1].find((b) => b.label === "Upload")).toBeTruthy();
  });

  it("awaiting upload is visible on the rider field", () => {
    const panel = renderHub(draft({ awaitingRiderUpload: true }));
    expect(panel.fields.find((f) => f.name === "Rider")!.value).toMatch(/waiting for a/);
  });
});

describe("Save writes only dirty fields; Cancel writes nothing", () => {
  it("empty overlay → empty threadPreset and no permission write", () => {
    const plan = buildSavePlan(draft());
    expect(plan.threadPreset).toEqual({});
    expect(plan.permission).toBeUndefined();
    expect(isDirty(draft())).toBe(false);
  });

  it("Save maps only the fields the user changed", () => {
    const d = draft({
      overlay: { model: "gpt-5.5", permission: "always" },
    });
    const plan = buildSavePlan(d);
    expect(plan.threadPreset).toEqual({ model: "gpt-5.5" });
    expect(plan.permission).toBe("always");
    expect(dirtyThreadPresetChanges(d)).not.toHaveProperty("agent");
    expect(dirtyThreadPresetChanges(d)).not.toHaveProperty("cwd");
  });

  it("inherit writes null for a thread overlay (not a channel write)", () => {
    const d = draft({
      snapshot: snapshot({
        model: setting("claude-haiku-4.5", "thread preset"),
        rider: { thread: "stay in lane", channel: "school-wide" },
      }),
      overlay: { model: null, rider: null },
    });
    const changes = dirtyThreadPresetChanges(d);
    expect(changes.model).toBeNull();
    expect(changes.rider).toBeNull();
    expect(changes).not.toHaveProperty("agent");
  });

  it("role picker writes thread overlay; channel scope writes channel pin", () => {
    const next = applyPickerValue(draft(), "role", "analyst", () => undefined);
    expect(next.overlay.role).toBe("analyst");
    expect(dirtyThreadPresetChanges(next).role).toBe("analyst");
    expect(buildSavePlan(next).threadPreset.role).toBe("analyst");

    const ch = applyPickerValue(
      draft({ editScope: "channel" }),
      "role",
      "qa",
      () => undefined
    );
    expect(ch.overlay.channelRole).toBe("qa");
    expect(buildSavePlan(ch).channelPreset?.role).toBe("qa");
  });

  it("saved channel cards reflect cleared role and re-enabled automatic naming", () => {
    const saved = draftAfterSave(draft({
      editScope: "channel",
      snapshot: snapshot({
        channelPins: { role: "qa", disableThreadPrefix: true },
        withoutThread: { ...WITHOUT, role: "qa", disableThreadPrefix: true },
      }),
      overlay: { channelRole: null, channelDisableThreadPrefix: false },
    }));

    expect(saved.snapshot.channelPins.role).toBeUndefined();
    expect(saved.snapshot.channelPins.disableThreadPrefix).toBeUndefined();
    expect(saved.snapshot.withoutThread.role).toBeNull();
    expect(saved.snapshot.withoutThread.disableThreadPrefix).toBe(false);
    const panel = renderHub(saved);
    expect(panel.fields.find((field) => field.name === "Role")!.value).toMatch(/not set/);
    expect(panel.fields.find((field) => field.name === "Auto-name")!.value).toMatch(/enabled/);
  });

  it("inherit of an already-unset thread field is not dirty", () => {
    const d = draft({ overlay: { model: null } });
    expect(dirtyThreadPresetChanges(d)).toEqual({});
  });

  it("permission inherit writes null (clears session policy)", () => {
    const d = draft({
      snapshot: snapshot({ permission: setting("always", "session config") }),
      overlay: { permission: null },
    });
    expect(dirtyPermission(d)).toBeNull();
  });

  it("Card picker is on the hub and dirty style writes session config (#96)", () => {
    const panel = renderHub(draft());
    expect(panel.fields.find((f) => f.name === "Card")!.value).toMatch(/full/);
    expect(panel.actions![2].find((b) => b.label === "Card")).toBeTruthy();
    expect(panel.actions![2][0]!.label).toBe("Save");

    const next = applyPickerValue(draft(), "card", "simple", caps);
    expect(next.overlay.statusCardStyle).toBe("simple");
    expect(dirtyStatusCardStyle(next)).toBe("simple");
    const plan = buildSavePlan(next);
    expect(plan.statusCardStyle).toBe("simple");
    expect(plan.threadPreset).toEqual({});

    const inherit = applyPickerValue(
      draft({
        snapshot: snapshot({ statusCardStyle: setting("simple", "session config") }),
      }),
      "card",
      INHERIT_VALUE,
      caps
    );
    expect(inherit.overlay.statusCardStyle).toBeNull();
    expect(dirtyStatusCardStyle(inherit)).toBeNull();
  });

  it("Card picker can target the channel preset without writing session config", () => {
    const next = applyPickerValue(draft(), "card", "channel:simple", caps);
    expect(next.overlay.channelStatusCardStyle).toBe("simple");
    expect(next.overlay.statusCardStyle).toBeUndefined();
    expect(dirtyChannelStatusCardStyle(next)).toBe("simple");
    expect(dirtyStatusCardStyle(next)).toBeUndefined();
    const plan = buildSavePlan(next);
    expect(plan.channelPreset).toEqual({ statusCardStyle: "simple" });
    expect(plan.statusCardStyle).toBeUndefined();
    expect(plan.threadPreset).toEqual({});
    expect(isDirty(next)).toBe(true);
    expect(renderHub(next).fields.find((f) => f.name === "Card")!.value).toMatch(/channel will be/);
  });

  it("channel Card pick matching inherit is not dirty", () => {
    const next = applyPickerValue(
      draft({
        snapshot: snapshot({
          withoutThread: { ...WITHOUT, statusCardStyle: "simple" },
          statusCardStyle: setting("simple", "channel preset"),
        }),
      }),
      "card",
      "channel:simple",
      caps
    );
    expect(dirtyChannelStatusCardStyle(next)).toBeUndefined();
    expect(isDirty(next)).toBe(false);
  });

  it("session inherit does not clear a drafted channel card style", () => {
    const channel = applyPickerValue(draft(), "card", "channel:simple", caps);
    const inherit = applyPickerValue(channel, "card", INHERIT_VALUE, caps);
    expect(inherit.overlay.statusCardStyle).toBeNull();
    expect(inherit.overlay.channelStatusCardStyle).toBe("simple");
    const plan = buildSavePlan(inherit);
    expect(plan.channelPreset).toEqual({ statusCardStyle: "simple" });
  });

  it("GIF picker writes session overlay and channel overlay like Card", () => {
    const panel = renderHub(draft());
    expect(panel.fields.find((f) => f.name === "GIF")!.value).toMatch(/off/);
    expect(panel.actions![2].find((b) => b.label === "GIF")).toBeTruthy();

    const next = applyPickerValue(draft(), "gif", "on", caps);
    expect(next.overlay.simpleCardGif).toBe(true);
    expect(dirtySimpleCardGif(next)).toBe(true);
    expect(buildSavePlan(next).simpleCardGif).toBe(true);

    const channel = applyPickerValue(draft(), "gif", "channel:on", caps);
    expect(channel.overlay.channelSimpleCardGif).toBe(true);
    expect(dirtyChannelSimpleCardGif(channel)).toBe(true);
    expect(buildSavePlan(channel).channelPreset).toEqual({ simpleCardGif: true });

    const inherit = applyPickerValue(
      draft({
        snapshot: snapshot({ simpleCardGif: setting(true, "session config") }),
      }),
      "gif",
      INHERIT_VALUE,
      caps
    );
    expect(inherit.overlay.simpleCardGif).toBeNull();
    expect(buildSavePlan(inherit).simpleCardGif).toBeNull();
  });

  it("Channel scope re-renders the hub and writes channel rider/agent on Save plan", () => {
    const panel = renderHub(draft({ editScope: "channel" }));
    expect(panel.title).toBe("🧩 Channel preset");
    expect(panel.footer).toMatch(/editing channel preset/);
    expect(panel.actions![0].find((b) => b.label === "Host")).toBeUndefined();
    expect(panel.fields.find((f) => f.name === "Host")!.value).toMatch(/per-thread/);
    expect(panel.actions![1].find((b) => b.label === "Approve")!.disabled).toBe(true);
    expect(panel.actions![1].find((b) => b.label === "Attach")!.disabled).toBe(true);
    expect(panel.actions![2].map((b) => b.label)).toEqual([
      "Save",
      "Cancel",
      "Card",
      "GIF",
      "Thread",
    ]);
    expect(panel.fields.find((f) => f.name === "Rider")!.value).toMatch(/scope: channel preset/);

    const started = draft({
      editScope: "channel",
      snapshot: snapshot({
        rider: { channel: "old channel rider" },
        channelPins: { agent: "grok" },
      }),
    });
    const withRider = applyPickerValue(started, "rider", "be kind in this class", caps);
    expect(withRider.overlay.channelRider).toBe("be kind in this class");
    expect(withRider.overlay.rider).toBeUndefined();
    expect(dirtyChannelRider(withRider)).toBe("be kind in this class");
    expect(currentChannelRiderText(withRider)).toBe("be kind in this class");
    expect(currentThreadRiderText(withRider)).toBeNull();

    const withAgent = applyPickerValue(withRider, "agent", "claude", caps);
    expect(withAgent.overlay.channelAgent).toBe("claude");
    expect(dirtyChannelAgent(withAgent)).toBe("claude");
    const plan = buildSavePlan(withAgent);
    expect(plan.channelPreset).toEqual({
      rider: "be kind in this class",
      agent: "claude",
    });
    expect(plan.threadPreset).toEqual({});
  });

  it("channel rider inherit/clear is dirty when a pin exists", () => {
    const d = applyPickerValue(
      draft({
        editScope: "channel",
        snapshot: snapshot({ rider: { channel: "pin" } }),
      }),
      "rider",
      INHERIT_VALUE,
      caps
    );
    expect(d.overlay.channelRider).toBeNull();
    expect(dirtyChannelRider(d)).toBeNull();
    expect(buildSavePlan(d).channelPreset).toEqual({ rider: null });
  });

  it("channel Card/GIF in channel scope write channel overlay (not session)", () => {
    const started = draft({ editScope: "channel" });
    const card = applyPickerValue(started, "card", "simple", caps);
    expect(card.overlay.channelStatusCardStyle).toBe("simple");
    expect(card.overlay.statusCardStyle).toBeUndefined();
    const gif = applyPickerValue(started, "gif", "on", caps);
    expect(gif.overlay.channelSimpleCardGif).toBe(true);
    expect(gif.overlay.simpleCardGif).toBeUndefined();
  });

  it("scope toggle is hidden when canEditChannel is false", () => {
    const panel = renderHub(draft(), { canEditChannel: false });
    expect(panel.actions![2].map((b) => b.label)).toEqual(["Save", "Cancel", "Card", "GIF"]);
  });

  it("approve/attach are no-ops in channel scope; agent never pins a location", () => {
    const started = draft({ editScope: "channel" });
    const chanAgent = applyPickerValue(started, "agent", "claude@mac", caps);
    expect(chanAgent.overlay.channelAgent).toBe("claude");
    expect(chanAgent.overlay.location).toBeUndefined();
    expect(applyPickerValue(started, "approve", "always", caps).overlay.permission).toBeUndefined();
    expect(applyPickerValue(started, "attach", "detached", caps).overlay.detached).toBeUndefined();
  });

  it("Cancel is a no-op on the overlay (store delete; no mutation payload)", () => {
    const d = draft({ overlay: { model: "x" } });
    const store = new ConfigEditorStore();
    store.put(d);
    store.delete(d.id);
    expect(store.get(d.id)).toBeUndefined();
    expect(buildSavePlan(draft()).threadPreset).toEqual({});
  });
});

describe("host/agent change drops unsupported model/effort (D13)", () => {
  it("switching to an agent with effort.mechanism none clears drafted effort", () => {
    const started = draft({
      snapshot: snapshot({
        agent: setting("claude", "thread preset"),
        effort: setting("high", "thread preset"),
      }),
      overlay: { effort: "high" },
    });
    const next = applyPickerValue(started, "agent", "copilot", caps);
    expect(next.overlay.effort).toBeNull();
    expect(next.warnings.join(" ")).toMatch(/Effort dropped/);
  });

  it("switching agent drops a model the new agent does not advertise", () => {
    const started = draft({
      snapshot: snapshot({
        agent: setting("claude", "thread preset"),
        model: setting("claude-opus-4.6", "thread preset"),
      }),
      overlay: { model: "claude-opus-4.6" },
    });
    const next = applyPickerValue(started, "agent", "copilot", caps);
    expect(next.overlay.model).toBeNull();
    expect(next.warnings.join(" ")).toMatch(/Model dropped/);
  });

  it("moving the same capable agent to another host keeps a supported effort", () => {
    const started = draft({
      snapshot: snapshot({
        agent: setting("claude", "session config"),
        effort: setting("high", "thread preset"),
        location: setting("local", "default"),
        withoutThread: { ...WITHOUT, agent: "claude" },
      }),
      overlay: { effort: "high" },
    });
    const next = applyPickerValue(started, "agent", "claude@mac", () => claudeCaps);
    expect(next.overlay.effort).toBe("high");
    expect(next.overlay.location).toBe("mac");
  });

  it("agent@location picker sets both agent and host", () => {
    const next = applyPickerValue(draft(), "agent", "claude@mac", caps);
    expect(next.overlay.agent).toBe("claude");
    expect(next.overlay.location).toBe("mac");
  });

  it("Inherit sentinel writes null", () => {
    const next = applyPickerValue(draft(), "model", INHERIT_VALUE, caps);
    expect(next.overlay.model).toBeNull();
  });
});

describe("agent id is the only host control (#156)", () => {
  const remote = () =>
    draft({
      snapshot: snapshot({
        agent: setting("claude", "thread preset"),
        location: setting("mac", "thread preset"),
      }),
    });

  it("the hub exposes no Host button — Host is a read-only field", () => {
    const panel = renderHub(remote());
    const buttons = panel.actions!.flat().map((b) => b.label);
    expect(buttons).not.toContain("Host");
    expect(buttons).toContain("Agent");
    expect(HUB_FIELD_ACTIONS).not.toContain("host" as never);
    const host = panel.fields.find((f) => f.name === "Host")!.value;
    expect(host).toMatch(/from agent/);
    expect(host).toMatch(/mac/);
  });

  it("the Agent field renders the addressable agent@host id", () => {
    const panel = renderHub(remote());
    expect(panel.fields.find((f) => f.name === "Agent")!.value).toMatch(/claude@mac/);
  });

  it("a drafted agent move reports one will-be note carrying the host", () => {
    const next = applyPickerValue(remote(), "agent", "copilot@local", caps);
    const panel = renderHub(next);
    expect(panel.fields.find((f) => f.name === "Agent")!.value).toMatch(
      /will be `copilot@local`/
    );
    expect(panel.fields.find((f) => f.name === "Host")!.value).toMatch(/will be `local`/);
    expect(effectiveAgentAtLocation(next)).toBe("copilot@local");
  });

  it("inheriting the agent inherits its host — no orphaned host pin", () => {
    const next = applyPickerValue(remote(), "agent", INHERIT_VALUE, caps);
    expect(next.overlay.agent).toBeNull();
    expect(next.overlay.location).toBeNull();
    expect(effectiveAgentAtLocation(next)).toBe(`${WITHOUT.agent}@${WITHOUT.location}`);
    expect(dirtyThreadPresetChanges(next)).toEqual({ agent: null, location: null });
  });

  it("a bare agent id lands on local rather than stranding the old host", () => {
    const next = applyPickerValue(remote(), "agent", "copilot", caps);
    expect(next.overlay.agent).toBe("copilot");
    expect(next.overlay.location).toBeNull();
    expect(effectiveAgentAtLocation(next)).toBe("copilot@local");
  });

  it("no picker action can write a location without an agent", () => {
    for (const action of HUB_FIELD_ACTIONS) {
      if (action === "agent") continue;
      const next = applyPickerValue(remote(), action, "mac", caps);
      expect(next.overlay.location, action).toBeUndefined();
    }
  });

  it("saving an agent move writes agent and location together", () => {
    const next = applyPickerValue(remote(), "agent", "copilot@local", caps);
    const plan = buildSavePlan(next);
    expect(plan.threadPreset.agent).toBe("copilot");
    // "local" is the default host, so the thread pin is cleared, not set to it.
    expect(plan.threadPreset.location).toBeNull();

    const toRemote = applyPickerValue(draft(), "agent", "claude@mac", caps);
    expect(buildSavePlan(toRemote).threadPreset).toMatchObject({
      agent: "claude",
      location: "mac",
    });
  });
});

describe("draft store: TTL and one-draft-per-user-thread", () => {
  it("second edit for the same user+thread evicts the first", () => {
    const store = new ConfigEditorStore();
    const first = draft({ id: "d1", messageId: "msg-old" });
    store.put(first);
    const second = draft({ id: "d2", messageId: "msg-new" });
    const evicted = store.put(second);
    expect(evicted?.id).toBe("d1");
    expect(store.get("d1")).toBeUndefined();
    expect(store.get("d2")?.messageId).toBe("msg-new");
  });

  it("idle TTL expires a draft so Save no-ops", () => {
    let now = 1_000_000;
    const store = new ConfigEditorStore({ ttlMs: 60_000, now: () => now });
    store.put(draft({ id: "d1", updatedAt: now, createdAt: now }));
    now += 60_001;
    expect(store.get("d1")).toBeUndefined();
    expect(authorizeDraftClick(undefined, "user-1")).toBe("expired");
  });

  it("other users' clicks are not-yours", () => {
    expect(authorizeDraftClick(draft(), "someone-else")).toBe("not-yours");
    expect(authorizeDraftClick(draft(), "user-1")).toBe("ok");
  });
});

describe("/seam config edit slash gates (#90 D9)", () => {
  const ADMIN = "1487094572696867019";
  const STUDENT = "1534937951044112505";

  it("participants cannot open the editor", () => {
    const cfg = {
      SEAM_PARTICIPANT_USER_IDS: new Set([STUDENT]),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    } as any;
    expect(Orchestrator.isParticipantSlashRefused(cfg, "edit", STUDENT)).toBe(true);
    expect(Orchestrator.isParticipantSlashRefused(cfg, "gif", STUDENT)).toBe(true);
    expect(Orchestrator.isParticipantSlashRefused(cfg, "edit", ADMIN)).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(cfg, "gif", ADMIN)).toBe(false);
  });

  it("locked channel refuses non-admins; admins may open without unlocking", () => {
    const locked = {
      channelPresets: new Map([["channel-1", { locked: true }]]),
      threadPresets: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    } as any;
    expect(Orchestrator.isLockedSlashRefused(locked, "channel-1", "edit", STUDENT)).toBe(true);
    expect(Orchestrator.isLockedSlashRefused(locked, "channel-1", "gif", STUDENT)).toBe(true);
    expect(Orchestrator.isLockedSlashRefused(locked, "channel-1", "edit", ADMIN)).toBe(false);
    expect(Orchestrator.isLockedSlashRefused(locked, "channel-1", "gif", ADMIN)).toBe(false);
  });

  it("channel-preset edits: admin set + locked match slash (admin-only when listed)", () => {
    const ADMIN = "1487094572696867019";
    const OPERATOR = "111";
    const STUDENT = "1534937951044112505";
    const withAdmins = {
      channelPresets: new Map([["channel-1", { locked: false }]]),
      threadPresets: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
      SEAM_PARTICIPANT_USER_IDS: new Set([STUDENT]),
    } as any;
    expect(Orchestrator.canEditChannelPreset(withAdmins, ADMIN, "channel-1")).toBe(true);
    expect(Orchestrator.canEditChannelPreset(withAdmins, OPERATOR, "channel-1")).toBe(false);
    expect(Orchestrator.canEditChannelPreset(withAdmins, STUDENT, "channel-1")).toBe(false);
    const locked = {
      channelPresets: new Map([["channel-1", { locked: true }]]),
      threadPresets: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
      SEAM_PARTICIPANT_USER_IDS: undefined,
    } as any;
    expect(Orchestrator.canEditChannelPreset(locked, ADMIN, "channel-1")).toBe(true);
    expect(Orchestrator.canEditChannelPreset(locked, OPERATOR, "channel-1")).toBe(false);
    const noAdminSet = {
      channelPresets: new Map([["channel-1", { locked: false }]]),
      threadPresets: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: undefined,
      SEAM_PARTICIPANT_USER_IDS: undefined,
    } as any;
    expect(Orchestrator.canEditChannelPreset(noAdminSet, OPERATOR, "channel-1")).toBe(true);
    expect(Orchestrator.canEditChannelPreset(noAdminSet, OPERATOR, undefined)).toBe(false);
  });
});

describe("snapshotFromDescribe keeps rider from describeConfig", () => {
  it("copies channel + thread rider onto the snapshot", () => {
    const d: ConfigDescription = {
      sessionId: "s",
      channelRef: "thread-1",
      parentRef: "chan-1",
      agent: setting("copilot", "session config"),
      model: setting("gpt-5.4", "session config"),
      effort: setting(null, "default"),
      cwd: setting("/repo", "session config"),
      permission: setting("ask", "default"),
      locked: false,
      detached: setting(false, "default"),
      tts: setting(false, "default"),
      ttsVoice: setting(null, "default"),
      ttsPace: setting("natural", "default"),
      ttsStyle: setting("neutral", "default"),
      location: setting("local", "default"),
      rider: { channel: "ch", thread: "th" },
      statusCardStyle: setting("full", "default"),
      simpleCardGif: setting(false, "default"),
    };
    const snap = snapshotFromDescribe(d, WITHOUT);
    expect(snap.rider).toEqual({ channel: "ch", thread: "th" });
    expect(snap.channelPins).toEqual({});
  });
});
