import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
const stores: SessionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new SessionStore(":memory:"); stores.push(store);
  const askUser = vi.fn(async () => ({ outcome: { outcome: "cancelled" } })),
    elicitUser = vi.fn(async () => ({ action: "cancel" })), completeElicitation = vi.fn(async () => {}), cancelElicitations = vi.fn(async () => {});
  const router = new SessionRouter({ store, profiles: [], modelCatalog: fixtureModelCatalog([]), logger: pino({ level: "silent" }) as any,
    defaultAgentId: "fixture", defaultModel: "default", defaultPermissionMode: "ask" } as any);
  router.setAskUser(askUser as any);
  router.setElicitationHandlers({ create: elicitUser as any, complete: completeElicitation, cancel: cancelElicitations });
  const record = router.ensureSessionRecord({ platform: "google-chat", channelRef: "old.topic", parentRef: "old", cwd: "/projects" });
  const callbacks = (router as any).clientOptions(record);
  store.rebindChannel(record.id, "new", null);
  return { record, callbacks, askUser, elicitUser, completeElicitation, cancelElicitations };
}
describe("retained runtime callbacks follow the durable channel binding", () => {
  it("asks in the new home without recreating the runtime", async () => {
    const h = fixture(); await h.callbacks.permissionPolicy({ options: [] }, {});
    expect(h.askUser).toHaveBeenCalledWith(expect.objectContaining({ id: h.record.id, channelRef: "new", parentRef: null }), expect.anything(), expect.anything());
  });
  it("completes elicitation in the new home", async () => {
    const h = fixture(); await h.callbacks.completeElicitationHandler({});
    expect(h.completeElicitation).toHaveBeenCalledWith(expect.objectContaining({ channelRef: "new" }), {});
  });
  it("cancels elicitation in the new home", async () => {
    const h = fixture(); await h.callbacks.cancelElicitations();
    expect(h.cancelElicitations).toHaveBeenCalledWith(expect.objectContaining({ channelRef: "new" }), "cancelled", expect.any(String));
  });
});
