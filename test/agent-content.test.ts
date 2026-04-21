import { describe, it, expect } from "vitest";
import { blockToFile } from "../src/agents/agent-content.js";

describe("blockToFile", () => {
  it("returns undefined for non-objects and unknown types", () => {
    expect(blockToFile(undefined)).toBeUndefined();
    expect(blockToFile("string")).toBeUndefined();
    expect(blockToFile({ type: "text", text: "hi" })).toBeUndefined();
    expect(blockToFile({ type: "resource_link", uri: "x", name: "y" })).toBeUndefined();
  });

  it("extracts an image block with base64 data", () => {
    const r = blockToFile({ type: "image", data: "AAAA", mimeType: "image/png" });
    expect(r).toMatchObject({
      mimeType: "image/png",
      data: "AAAA",
      base64: true,
    });
    expect(r!.filename).toMatch(/\.png$/);
  });

  it("extracts an audio block", () => {
    const r = blockToFile({ type: "audio", data: "BBBB", mimeType: "audio/ogg" });
    expect(r).toMatchObject({ mimeType: "audio/ogg", base64: true });
    expect(r!.filename).toMatch(/\.ogg$/);
  });

  it("uses URI basename when present", () => {
    const r = blockToFile({
      type: "image",
      data: "x",
      mimeType: "image/png",
      uri: "file:///tmp/screenshot.png",
    });
    expect(r!.filename).toBe("screenshot.png");
    expect(r!.uri).toBe("file:///tmp/screenshot.png");
  });

  it("falls back to a synthesized name when URI has no basename", () => {
    const r = blockToFile({
      type: "image",
      data: "x",
      mimeType: "image/jpeg",
      uri: "https://example.com/",
    });
    expect(r!.filename).toMatch(/^image-\d+\.jpg$/);
  });

  it("extracts an embedded text resource", () => {
    const r = blockToFile({
      type: "resource",
      resource: {
        uri: "file:///tmp/notes.md",
        mimeType: "text/markdown",
        text: "# hi",
      },
    });
    expect(r).toMatchObject({
      filename: "notes.md",
      mimeType: "text/markdown",
      data: "# hi",
      base64: false,
    });
  });

  it("extracts an embedded blob resource as base64", () => {
    const r = blockToFile({
      type: "resource",
      resource: {
        uri: "file:///tmp/data.bin",
        mimeType: "application/octet-stream",
        blob: "ZmFrZQ==",
      },
    });
    expect(r).toMatchObject({
      filename: "data.bin",
      data: "ZmFrZQ==",
      base64: true,
    });
  });

  it("returns undefined when image data is missing", () => {
    expect(blockToFile({ type: "image", mimeType: "image/png" })).toBeUndefined();
  });

  it("returns undefined when resource has neither text nor blob", () => {
    expect(
      blockToFile({ type: "resource", resource: { uri: "x", mimeType: "y" } })
    ).toBeUndefined();
  });

  it("handles bare paths in URIs (not absolute URLs)", () => {
    const r = blockToFile({
      type: "resource",
      resource: { uri: "/tmp/output.json", mimeType: "application/json", text: "{}" },
    });
    expect(r!.filename).toBe("output.json");
  });
});
