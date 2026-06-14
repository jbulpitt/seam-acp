/**
 * GOLDEN CORPUS / REFACTOR ORACLE — output pipeline (FenceStream + splitForFlush + chunker)
 * ------------------------------------------------------------------------------------------
 * Purpose: a safety net for the streaming-output path, and the regression oracle for the
 * proposed "unified markdown block model" refactor (see chat / future
 * docs/output-pipeline-refactor.md). It is intentionally focused on the GAPS the existing
 * per-function suites (fence-stream / stream-flush / text-chunker / renderer .test.ts) don't
 * cover:
 *
 *   1. TABLE BASELINE — how a markdown table flows through the pipeline TODAY (it doesn't;
 *      it's treated as prose and can be split anywhere). This pins the pre-refactor behavior
 *      so we can prove the refactor changes it deliberately, not by accident.
 *   2. FENCE → FILE ROUTING CONTRACT — the must-preserve rule: a fenced block whose inline
 *      render would exceed the per-message cap is uploaded as a FILE instead. (Mirrors
 *      orchestrator emitClosedFence / ORCH_INLINE_FENCE_MAX = 1900.)
 *   3. MUST-SURVIVE BEHAVIORS — a catalog (executable where the logic is pure; `it.todo`
 *      where it's I/O-bound in the orchestrator) of behaviors the refactor must NOT lose.
 *
 * NOTE: the orchestrator's emit path (emitClosedFence, bare-filename upload, watchdog) is
 * I/O-bound and not yet unit-testable. Where that's the case we pin the *contract* with a
 * local mirror + an `it.todo` to wire a real integration test once the decision is extracted
 * into a pure function during the refactor.
 */
import { describe, it, expect } from "vitest";
import { FenceStream, type Segment } from "../src/core/fence-stream.js";
import { splitForFlush } from "../src/core/stream-flush.js";

const proseText = (segs: Segment[]) =>
  segs.map((s) => (s.kind === "prose" ? s.text : "")).join("");

const TABLE = [
  "| Name  | Role   |",
  "| ----- | ------ |",
  "| Alice | Eng    |",
  "| Bob   | PM     |",
  "| Carol | Design |",
  "| Dave  | Sales  |",
].join("\n");

describe("golden — table handling (BASELINE: current pre-refactor behavior)", () => {
  it("FenceStream treats a markdown table as plain prose (not a fence)", () => {
    const fs = new FenceStream();
    const { segments } = fs.feed(TABLE);
    const { segments: tail, unclosed } = fs.flush();
    const all = [...segments, ...tail];
    expect(all.every((s) => s.kind === "prose")).toBe(true);
    expect(proseText(all)).toBe(TABLE);
    expect(unclosed).toBeNull();
  });

  it("a table delimiter row does NOT false-trigger the '---' thematic-break cut", () => {
    // The `| --- |` delimiter contains pipes, so findThematicBreakCut (which matches a bare
    // `---` line) must leave it intact — the row must survive in the sent message.
    const buf = `Intro.\n\n${TABLE}\n\nOutro.`;
    const res = splitForFlush(buf, { maxLen: 1000, force: true });
    expect(res).not.toBeNull();
    expect(res!.send).toContain("| ----- | ------ |");
  });

  it("BASELINE BUG: a table IS split mid-rows when forced over a small cap", () => {
    // This is the behavior the refactor is meant to FIX. Pinning it so the fix is visible.
    const res = splitForFlush(TABLE, { maxLen: 40, force: true });
    expect(res).not.toBeNull();
    expect(res!.keep.length).toBeGreaterThan(0); // it split
    expect(res!.send).not.toBe(TABLE); // neither half is the whole table → cut mid-table
    // DESIRED post-refactor: a table is a non-splittable block (see must-survive catalog).
  });
});

describe("golden — fence → file routing CONTRACT (must preserve)", () => {
  // Mirror of orchestrator emitClosedFence (orchestrator.ts:5043) + ORCH_INLINE_FENCE_MAX.
  // SPEC, not a test of the real fn (it's I/O-bound). The refactor's code_fence overflow
  // policy MUST keep satisfying these. See it.todo below to make this a real integration test.
  const ORCH_INLINE_FENCE_MAX = 1900; // mirrors orchestrator.ts:103
  const inlineLen = (lang: string, content: string, notice?: string) =>
    3 + lang.length + 1 + content.length + 1 + 3 + (notice ? 2 + notice.length : 0);
  const routesToFile = (lang: string, content: string, notice?: string) =>
    inlineLen(lang, content, notice) > ORCH_INLINE_FENCE_MAX;

  it("a small fence renders inline (not a file)", () => {
    expect(routesToFile("ts", "const x = 1;")).toBe(false);
  });

  it("a fence whose inline render exceeds the cap is uploaded as a FILE", () => {
    expect(routesToFile("ts", "x".repeat(2000))).toBe(true);
  });

  it("boundary: exactly-at-cap stays inline; one char over routes to file", () => {
    const lang = "ts";
    const overhead = 3 + lang.length + 1 + 1 + 3; // ```ts\n … \n```
    const fit = "x".repeat(ORCH_INLINE_FENCE_MAX - overhead);
    expect(routesToFile(lang, fit)).toBe(false);
    expect(routesToFile(lang, fit + "x")).toBe(true);
  });

  it("the trailing notice counts toward the inline budget", () => {
    const lang = "";
    const overhead = 3 + 0 + 1 + 1 + 3;
    const content = "y".repeat(ORCH_INLINE_FENCE_MAX - overhead); // fits with no notice
    expect(routesToFile(lang, content)).toBe(false);
    expect(routesToFile(lang, content, "_(closed early)_")).toBe(true); // notice pushes it over
  });
});

describe("golden — must-survive behaviors (refactor contract)", () => {
  // Pure/unit-covered elsewhere — listed here as the contract index:
  //   • FenceStream split-across-chunks, fake-opener abort, unclosed-on-flush, forceClose
  //     → covered in test/fence-stream.test.ts
  //   • link/image + inline-code split safety → covered in test/stream-flush.test.ts
  // The following are I/O-bound in the orchestrator and must be wired as integration tests
  // (ideally after extracting the decisions into pure functions during the refactor):
  it.todo(
    "oversized fence (inline > ORCH_INLINE_FENCE_MAX) uploads as a file with lang-derived ext/mime [emitClosedFence → emitFenceAttachment]"
  );
  it.todo(
    "a bare-filename fence resolving under an allowed root uploads the REAL host file (≤25MB cap) [tryEmitBareFilenameFence]"
  );
  it.todo(
    "a fence open longer than FENCE_MAX_OPEN_MS is force-closed and emitted with a notice [watchdog]"
  );
  it.todo(
    "a fence still open at end-of-turn is emitted via flush() snapshot [unclosed]"
  );
  it.todo(
    "POST-REFACTOR: a markdown table is a non-splittable block (never cut mid-table) and rendered Discord-safe (list or single fenced message)"
  );
});
