import { describe, expect, it, vi } from "vitest";
import { acquireWithModelFallback, matchingModelAcquisition, type ModelAcquisitionState } from "../packages/core/src/core/model-acquisition.js";
import type { ModelFallbackPlan } from "@seam/adapters";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";

const identity = { agentId: "claude", location: "remote-one", requestedModel: "original", cwd: "/repo", acpSessionId: "history" };
const refused = () => Object.assign(new Error("model unavailable"), { data: { errorKind: "model_not_found", agentId: "claude" } });
const plan = (): ModelFallbackPlan => ({ version: 1, agentId: "claude", location: "remote-one", requestedModel: "original",
  requiredContextTokens: 400_000, alternatives: ["one", "two"].map(model => ({ model, normalizedModel: model,
    applicationMode: "reload", contextWindow: 1_000_000, notice: `Model fallback: original → ${model}; capability unknown; price unknown.` })) });
function fixture() {
  let saved: ModelAcquisitionState | undefined;
  const save = vi.fn((state: ModelAcquisitionState) => { saved = JSON.parse(JSON.stringify(state)); });
  const acquire = vi.fn(async (model: string) => { if (model !== "two") throw refused(); return model; });
  const notice = vi.fn();
  const run = () => acquireWithModelFallback({ identity, plan: plan(), saved: matchingModelAcquisition(saved, identity),
    save, acquire, notice, sessionId: () => "history", discard: vi.fn() });
  return { save, acquire, notice, run, saved: () => saved };
}
describe("Seam-owned acquisition budget", () => {
  it.each(["auth_required", "connection_closed", "cancelled", "unclassified"])("does not substitute for %s", async errorKind => {
    const h = fixture();
    const error = Object.assign(new Error(errorKind), { data: { agentId: "claude", errorKind } });
    h.acquire.mockRejectedValue(error);
    await expect(h.run()).rejects.toBe(error);
    expect(h.acquire).toHaveBeenCalledTimes(1);
    expect(h.save).not.toHaveBeenCalled();
  });
  it("persists rejection progress and restarts directly at the selected model with the notice", async () => {
    const h = fixture();
    await expect(h.run()).resolves.toBe("two");
    expect(h.acquire.mock.calls.map(c => c[0])).toEqual(["original", "one", "two"]);
    expect(h.save.mock.calls.map(c => [c[0].index, c[0].phase])).toEqual([[0, "trying"], [1, "trying"], [1, "trying"], [1, "selected"]]);
    h.acquire.mockClear(); h.notice.mockClear();
    await expect(h.run()).resolves.toBe("two");
    expect(h.acquire.mock.calls.map(c => c[0])).toEqual(["two"]);
    expect(h.notice).toHaveBeenCalledWith("two", plan().alternatives[1]!.notice);
  });
  it("does not replenish an exhausted budget on an outer boot retry", async () => {
    const h = fixture(); h.acquire.mockRejectedValue(refused());
    await expect(h.run()).rejects.toMatchObject({ acquisitionRecoveryExhausted: true });
    await expect(h.run()).rejects.toMatchObject({ acquisitionRecoveryExhausted: true });
    expect(h.acquire).toHaveBeenCalledTimes(3);
    expect(h.saved()?.phase).toBe("exhausted");
  });
  it("resumes a persisted trying choice after a transport interruption, without replenishing rejected choices", async () => {
    const h = fixture();
    h.acquire.mockImplementation(async model => { if (model === "original") throw refused(); throw new Error("connection closed"); });
    await expect(h.run()).rejects.toThrow("connection closed");
    expect(h.saved()).toMatchObject({ index: 0, phase: "trying" });
    h.acquire.mockClear(); h.acquire.mockImplementation(async model => model);
    await expect(h.run()).resolves.toBe("one");
    expect(h.acquire.mock.calls.map(c => c[0])).toEqual(["one"]);
  });
  it("rejects a saved cursor from another session, host, model, effort or cwd", () => {
    const state: ModelAcquisitionState = { version: 1, identity, plan: plan(), index: 0, phase: "selected" };
    for (const key of ["agentId", "location", "requestedModel", "effort", "cwd", "acpSessionId"] as const) {
      expect(matchingModelAcquisition(state, { ...identity, [key]: "other" })).toBeUndefined();
    }
    expect(matchingModelAcquisition(state, identity)).toEqual(state);
  });
  it("never replaces history with a fresh session or uses a candidate removed by current metadata", async () => {
    const p = plan(); p.alternatives[0]!.applicationMode = "freshSession";
    const acquire = vi.fn(async () => "bad");
    await expect(acquireWithModelFallback({ identity, plan: { ...p, alternatives: [p.alternatives[0]!] },
      saved: { version: 1, identity, plan: p, index: 0, phase: "trying" }, save: vi.fn(), acquire,
      sessionId: () => "history", notice: vi.fn(), discard: vi.fn() })).rejects.toMatchObject({ acquisitionRecoveryExhausted: true });
    expect(acquire).not.toHaveBeenCalled();
  });
  it("disposes a selected child if its durable selection cannot be committed", async () => {
    const discard = vi.fn();
    await expect(acquireWithModelFallback({ identity, plan: plan(),
      saved: { version: 1, identity, plan: plan(), index: 0, phase: "trying" },
      save: state => { if (state.phase === "selected") throw new Error("disk full"); },
      acquire: async () => "child", sessionId: () => "history", notice: vi.fn(), discard })).rejects.toThrow("disk full");
    expect(discard).toHaveBeenCalledWith("child");
  });
  it("does not mistake a recovery cursor for user reconfiguration", () => {
    const base = { agent: "claude", model: "original", config: { model: "original" } };
    expect(executionIdentity({ ...base, config: { ...base.config, modelAcquisition: { phase: "selected" } } }))
      .toBe(executionIdentity(base));
    expect(executionIdentity({ ...base, config: { model: "other" } })).not.toBe(executionIdentity(base));
  });
});
