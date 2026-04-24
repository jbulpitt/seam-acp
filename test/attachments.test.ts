import { describe, it, expect } from "vitest";
import {
  mapAttachmentsToBlocks,
  MAX_ATTACHMENTS,
  MAX_BYTES_PER_ATTACHMENT,
  MAX_INLINE_TEXT_BYTES,
} from "../src/agents/attachments.js";
import type { MessageAttachment } from "../src/platforms/chat-adapter.js";

function fakeFetch(map: Record<string, { body: string | Uint8Array; ok?: boolean }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const entry = map[url];
    if (!entry) throw new Error(`unexpected url: ${url}`);
    const body = entry.body;
    return {
      ok: entry.ok ?? true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () =>
        typeof body === "string"
          ? new TextEncoder().encode(body).buffer
          : body.buffer,
    } as unknown as Response;
  }) as typeof fetch;
}

const a = (over: Partial<MessageAttachment> = {}): MessageAttachment => ({
  url: "https://cdn.example/file.bin",
  filename: "file.bin",
  contentType: "application/octet-stream",
  size: 100,
  ...over,
});

describe("mapAttachmentsToBlocks", () => {
  it("returns empty for empty input", async () => {
    const r = await mapAttachmentsToBlocks([], {});
    expect(r.blocks).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it("inlines images as image blocks when capability present", async () => {
    const url = "https://cdn.example/cat.png";
    const bytes = new Uint8Array([1, 2, 3]);
    const r = await mapAttachmentsToBlocks(
      [a({ url, filename: "cat.png", contentType: "image/png", size: 3 })],
      { capabilities: { image: true }, fetchFn: fakeFetch({ [url]: { body: bytes } }) }
    );
    expect(r.rejected).toEqual([]);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: Buffer.from(bytes).toString("base64"),
    });
  });

  it("falls back to resource_link for images when capability missing", async () => {
    const url = "https://cdn.example/cat.png";
    const r = await mapAttachmentsToBlocks(
      [a({ url, filename: "cat.png", contentType: "image/png", size: 3 })],
      { capabilities: {} }
    );
    expect(r.blocks[0]).toMatchObject({ type: "resource_link", uri: url, name: "cat.png" });
    expect(r.rejected).toHaveLength(0);
  });

  it("rejects audio when capability missing", async () => {
    const r = await mapAttachmentsToBlocks(
      [a({ filename: "voice.ogg", contentType: "audio/ogg", size: 100 })],
      { capabilities: { image: true, embeddedContext: true } }
    );
    expect(r.blocks).toHaveLength(0);
    expect(r.rejected).toEqual([
      { filename: "voice.ogg", reason: expect.stringContaining("audio") },
    ]);
  });

  it("inlines audio when capability present", async () => {
    const url = "https://cdn.example/voice.ogg";
    const bytes = new Uint8Array([9, 8, 7]);
    const r = await mapAttachmentsToBlocks(
      [a({ url, filename: "voice.ogg", contentType: "audio/ogg", size: 3 })],
      { capabilities: { audio: true }, fetchFn: fakeFetch({ [url]: { body: bytes } }) }
    );
    expect(r.blocks[0]).toMatchObject({ type: "audio", mimeType: "audio/ogg" });
  });

  it("inlines text-ish files as embedded resources when capability present", async () => {
    const url = "https://cdn.example/notes.md";
    const text = "# hello\nworld";
    const r = await mapAttachmentsToBlocks(
      [a({ url, filename: "notes.md", contentType: "text/markdown", size: text.length })],
      { capabilities: { embeddedContext: true }, fetchFn: fakeFetch({ [url]: { body: text } }) }
    );
    expect(r.blocks[0]).toMatchObject({
      type: "resource",
      resource: { uri: "attachment://notes.md", mimeType: "text/markdown", text },
    });
  });

  it("detects text by extension when MIME is generic", async () => {
    const url = "https://cdn.example/script.ts";
    const text = "export const x = 1;";
    const r = await mapAttachmentsToBlocks(
      [a({ url, filename: "script.ts", contentType: "application/octet-stream", size: text.length })],
      { capabilities: { embeddedContext: true }, fetchFn: fakeFetch({ [url]: { body: text } }) }
    );
    expect(r.blocks[0]).toMatchObject({ type: "resource" });
  });

  it("falls back to resource_link for text files when over inline-size limit", async () => {
    const url = "https://cdn.example/big.txt";
    const r = await mapAttachmentsToBlocks(
      [a({ url, filename: "big.txt", contentType: "text/plain", size: MAX_INLINE_TEXT_BYTES + 1 })],
      { capabilities: { embeddedContext: true } }
    );
    expect(r.blocks[0]).toMatchObject({ type: "resource_link", uri: url });
    expect(r.rejected).toHaveLength(0);
  });

  it("falls back to resource_link for text files when capability missing", async () => {
    const url = "https://cdn.example/notes.md";
    const r = await mapAttachmentsToBlocks(
      [a({ url, filename: "notes.md", contentType: "text/markdown", size: 10 })],
      { capabilities: {} }
    );
    expect(r.blocks[0]).toMatchObject({ type: "resource_link", uri: url, name: "notes.md" });
    expect(r.rejected).toHaveLength(0);
  });

  it("inlines unknown binary as blob when embeddedContext present", async () => {
    const url = "https://cdn.example/report.docx";
    const bytes = new Uint8Array([1, 2, 3]);
    const r = await mapAttachmentsToBlocks(
      [a({ url, filename: "report.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 3 })],
      { capabilities: { embeddedContext: true }, fetchFn: fakeFetch({ [url]: { body: bytes } }) }
    );
    expect(r.blocks[0]).toMatchObject({ type: "resource" });
    expect(r.rejected).toHaveLength(0);
  });

  it("falls back to resource_link for unknown binary when no embeddedContext", async () => {
    const url = "https://cdn.example/report.docx";
    const r = await mapAttachmentsToBlocks(
      [a({ url, filename: "report.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 100 })],
      { capabilities: {} }
    );
    expect(r.blocks[0]).toMatchObject({ type: "resource_link", uri: url });
    expect(r.rejected).toHaveLength(0);
  });

  it("rejects attachments larger than the per-file byte limit", async () => {
    const r = await mapAttachmentsToBlocks(
      [a({ filename: "huge.png", contentType: "image/png", size: MAX_BYTES_PER_ATTACHMENT + 1 })],
      { capabilities: { image: true } }
    );
    expect(r.blocks).toHaveLength(0);
    expect(r.rejected[0]).toMatchObject({ filename: "huge.png" });
    expect(r.rejected[0].reason).toMatch(/larger/i);
  });

  it("rejects attachments past the count limit", async () => {
    const list = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) =>
      a({ filename: `f${i}.dat`, contentType: "application/x-thing", size: 10 })
    );
    const r = await mapAttachmentsToBlocks(list, { capabilities: {} });
    // With no embeddedContext, binary files become resource_links (not rejected).
    expect(r.blocks).toHaveLength(MAX_ATTACHMENTS);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0].reason).toMatch(/limit/i);
  });

  it("falls back to resource_link if download fails", async () => {
    const url = "https://cdn.example/cat.png";
    const failing: typeof fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const r = await mapAttachmentsToBlocks(
      [a({ url, filename: "cat.png", contentType: "image/png", size: 3 })],
      { capabilities: { image: true }, fetchFn: failing }
    );
    expect(r.blocks[0]).toMatchObject({ type: "resource_link", uri: url });
    expect(r.rejected).toEqual([]);
  });
});
