import { describe, it, expect } from "vitest";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import {
  ConfigEditorStore,
  INHERIT_VALUE,
  RIDER_FILE_MAX_BYTES,
  applyPickerValue,
  authorizeDraftClick,
  buildSavePlan,
  currentThreadRiderText,
  decodeRiderUpload,
  dirtyPermission,
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
    rider: {},
    locked: false,
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
    expect(panel.actions).toHaveLength(3);
    expect(panel.actions![0].map((b) => b.label)).toEqual([
      "Host",
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
    expect(panel.actions![2].map((b) => b.label)).toEqual(["Save", "Cancel"]);
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

  it("host change with the same capable agent keeps a supported effort", () => {
    const started = draft({
      snapshot: snapshot({
        agent: setting("claude", "session config"),
        effort: setting("high", "thread preset"),
        location: setting("local", "default"),
        withoutThread: { ...WITHOUT, agent: "claude" },
      }),
      overlay: { effort: "high" },
    });
    const next = applyPickerValue(started, "host", "mac", () => claudeCaps);
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
    expect(Orchestrator.isParticipantSlashRefused(cfg, "edit", ADMIN)).toBe(false);
  });

  it("locked channel refuses non-admins; admins may open without unlocking", () => {
    const locked = {
      channelPresets: new Map([["channel-1", { locked: true }]]),
      threadPresets: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    } as any;
    expect(Orchestrator.isLockedSlashRefused(locked, "channel-1", "edit", STUDENT)).toBe(true);
    expect(Orchestrator.isLockedSlashRefused(locked, "channel-1", "edit", ADMIN)).toBe(false);
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
      location: setting("local", "default"),
      rider: { channel: "ch", thread: "th" },
    };
    const snap = snapshotFromDescribe(d, WITHOUT);
    expect(snap.rider).toEqual({ channel: "ch", thread: "th" });
  });
});
