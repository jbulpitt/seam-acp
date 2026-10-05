import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigEditorStore } from "../packages/core/src/plugins/config-ui/store.js";
import { DRAFT_IDLE_TTL_MS, type ThreadConfigDraft } from "../packages/core/src/platforms/discord/config-editor.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-config-drafts-")); directories.push(dir);
  const file = path.join(dir, "drafts.json");
  let now = 1_000_000;
  const open = () => { const store = new ConfigEditorStore({ now: () => now }); store.load(file); return store; };
  const draft = { id: "draft", userId: "owner", threadId: "thread", parentRef: "project", messageId: "message",
    createdAt: now, updatedAt: now, snapshot: {}, overlay: { rider: "Unsaved text", role: "qa" }, warnings: ["warning"],
    editScope: "channel", awaitingRiderUpload: true } as ThreadConfigDraft;
  return { file, draft, open, advance: (ms: number) => { now += ms; } };
}

describe("config draft plugin storage", () => {
  it("restores the snapshot, selections, scope and pending upload without refreshing idle time", () => {
    const h = fixture(); const first = h.open(); first.put(h.draft);
    h.advance(DRAFT_IDLE_TTL_MS - 1);
    const restarted = h.open();
    expect(restarted.getForUserThread("owner", "thread")).toEqual(h.draft);
    expect(restarted.getForUserThread("other", "thread")).toBeUndefined();
    h.advance(2);
    expect(restarted.get(h.draft.id)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(h.file, "utf8"))).toEqual([]);
    expect(h.open().get(h.draft.id)).toBeUndefined();
  });

  it("retains the existing idle refresh on edits across repeated restarts", () => {
    const h = fixture(); h.open().put(h.draft);
    h.advance(DRAFT_IDLE_TTL_MS - 1);
    const edited = h.open().touch(h.draft.id, { overlay: { effort: "low" }, awaitingRiderUpload: false });
    h.advance(DRAFT_IDLE_TTL_MS - 1);
    expect(h.open().get(h.draft.id)).toEqual(edited);
    h.advance(2);
    expect(h.open().get(h.draft.id)).toBeUndefined();
  });

  it("persists replacement, cancellation and completion without reviving spent cards", () => {
    const h = fixture(); h.open().put(h.draft);
    const next = { ...h.draft, id: "next", messageId: "next-message" };
    expect(h.open().put(next)).toEqual(h.draft);
    const restarted = h.open();
    expect(restarted.get(h.draft.id)).toBeUndefined();
    expect(restarted.getForUserThread("owner", "thread")).toEqual(next);
    expect(restarted.delete(next.id)).toEqual(next);
    expect(h.open().getForUserThread("owner", "thread")).toBeUndefined();
  });
});
