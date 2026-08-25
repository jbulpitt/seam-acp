import { describe, it, expect } from "vitest";
import {
  deleteSimpleCardGifMessage,
  isSimpleCardGifTerminal,
  pickSimpleCardGifUrl,
  postSimpleCardGifMessage,
  simpleCardGifPanel,
} from "../packages/core/src/core/simple-card-gif.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";

const URL = "https://cdn.example/a.gif";

describe("pickSimpleCardGifUrl", () => {
  it("picks when style is simple and gif is on", () => {
    expect(
      pickSimpleCardGifUrl({
        style: "simple",
        gifOn: true,
        randomGif: () => URL,
      })
    ).toBe(URL);
  });

  it("does not pick when style is full", () => {
    expect(
      pickSimpleCardGifUrl({
        style: "full",
        gifOn: true,
        randomGif: () => URL,
      })
    ).toBeUndefined();
  });

  it("does not pick when gif is off", () => {
    expect(
      pickSimpleCardGifUrl({
        style: "simple",
        gifOn: false,
        randomGif: () => URL,
      })
    ).toBeUndefined();
  });

  it("does not pick when the catalog is empty", () => {
    expect(
      pickSimpleCardGifUrl({
        style: "simple",
        gifOn: true,
        randomGif: () => null,
      })
    ).toBeUndefined();
  });
});

describe("isSimpleCardGifTerminal", () => {
  it("Done / Failed / Timed out delete the GIF message", () => {
    expect(isSimpleCardGifTerminal("Done")).toBe(true);
    expect(isSimpleCardGifTerminal("Failed")).toBe(true);
    expect(isSimpleCardGifTerminal("Timed out")).toBe(true);
  });

  it("Working / Waiting / Monitoring keep the GIF message", () => {
    expect(isSimpleCardGifTerminal("Working")).toBe(false);
    expect(isSimpleCardGifTerminal("Waiting")).toBe(false);
    expect(isSimpleCardGifTerminal("Monitoring")).toBe(false);
  });
});

describe("simpleCardGifPanel", () => {
  it("is a minimal embed with only the GIF image", () => {
    const panel = simpleCardGifPanel(URL);
    expect(panel.imageUrl).toBe(URL);
    expect(panel.fields).toEqual([]);
    expect(panel.title).toBeUndefined();
    expect(panel.author).toBeUndefined();
    expect(panel.description).toBeUndefined();
  });
});

describe("postSimpleCardGifMessage / deleteSimpleCardGifMessage", () => {
  it("posts via sendPanel when available, then terminal-state delete uses that ref", async () => {
    const posted: StructuredPanel[] = [];
    const deleted: string[] = [];
    const ref = await postSimpleCardGifMessage({
      url: URL,
      sendPanel: async (panel) => {
        posted.push(panel);
        return { id: "gif-1" };
      },
      sendMessage: async () => {
        throw new Error("sendMessage should not run when sendPanel works");
      },
    });
    expect(ref).toEqual({ id: "gif-1" });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.imageUrl).toBe(URL);

    await deleteSimpleCardGifMessage({
      ref,
      deleteMessage: async (r) => {
        deleted.push(r.id);
      },
    });
    expect(deleted).toEqual(["gif-1"]);
  });

  it("does not post when pick returned undefined (caller skips)", async () => {
    const url = pickSimpleCardGifUrl({
      style: "simple",
      gifOn: false,
      randomGif: () => URL,
    });
    expect(url).toBeUndefined();
  });

  it("falls back to sendMessage(url) without sendPanel", async () => {
    const texts: string[] = [];
    const ref = await postSimpleCardGifMessage({
      url: URL,
      sendMessage: async (text) => {
        texts.push(text);
        return { id: "gif-plain" };
      },
    });
    expect(texts).toEqual([URL]);
    expect(ref).toEqual({ id: "gif-plain" });
  });

  it("swallows delete errors (message already gone)", async () => {
    await expect(
      deleteSimpleCardGifMessage({
        ref: { id: "gone" },
        deleteMessage: async () => {
          throw new Error("Unknown Message");
        },
      })
    ).resolves.toBeUndefined();
  });

  it("no-ops delete when there is no ref", async () => {
    let called = false;
    await deleteSimpleCardGifMessage({
      ref: undefined,
      deleteMessage: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });
});
