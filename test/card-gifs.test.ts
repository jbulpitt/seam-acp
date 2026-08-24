import { describe, it, expect } from "vitest";
import { pino } from "pino";
import {
  CARD_GIF_BROWSER_UA,
  CardGifCatalog,
  parseGifManifest,
} from "../packages/core/src/core/card-gifs.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const URLS = [
  "https://cdn.example/one.gif",
  "https://cdn.example/two.gif",
  "https://cdn.example/three.gif",
];

describe("parseGifManifest", () => {
  it("keeps http(s) strings and drops junk", () => {
    expect(
      parseGifManifest({
        version: 1,
        gifs: ["https://a/x.gif", "not-a-url", 3, " http://b/y.gif ", null],
      })
    ).toEqual(["https://a/x.gif", "http://b/y.gif"]);
  });

  it("returns [] on a bad body", () => {
    expect(parseGifManifest(null)).toEqual([]);
    expect(parseGifManifest({ gifs: "nope" })).toEqual([]);
  });
});

describe("CardGifCatalog", () => {
  it("randomGif returns a member of the list", async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const catalog = new CardGifCatalog({
      url: "https://example.test/manifest.json",
      logger: silent,
      random: () => 0.5,
      fetchImpl: async (url, init) => {
        seen.push({ url, headers: init?.headers });
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: 1, gifs: URLS }),
        };
      },
    });
    await catalog.refresh();
    expect(catalog.randomGif()).toBe("https://cdn.example/two.gif");
    expect(seen[0]?.headers?.["user-agent"]).toBe(CARD_GIF_BROWSER_UA);
  });

  it("returns null on fetch failure without throwing", async () => {
    const catalog = new CardGifCatalog({
      url: "https://example.test/manifest.json",
      logger: silent,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: 1010 }),
      }),
    });
    await catalog.refresh();
    expect(catalog.randomGif()).toBeNull();
  });

  it("returns null on parse failure", async () => {
    const catalog = new CardGifCatalog({
      url: "https://example.test/manifest.json",
      logger: silent,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        },
      }),
    });
    await catalog.refresh();
    expect(catalog.randomGif()).toBeNull();
  });

  it("sends a browser User-Agent on every refresh", async () => {
    const headers: string[] = [];
    const catalog = new CardGifCatalog({
      url: "https://example.test/manifest.json",
      logger: silent,
      fetchImpl: async (_url, init) => {
        headers.push(init?.headers?.["user-agent"] ?? "");
        return { ok: true, status: 200, json: async () => ({ gifs: URLS }) };
      },
    });
    await catalog.refresh();
    expect(headers).toEqual([CARD_GIF_BROWSER_UA]);
    expect(CARD_GIF_BROWSER_UA).toMatch(/Mozilla\/5\.0/);
    expect(CARD_GIF_BROWSER_UA).toMatch(/Chrome\//);
  });

  it("returns null on an empty gifs list", async () => {
    const catalog = new CardGifCatalog({
      url: "https://example.test/manifest.json",
      logger: silent,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: 1, gifs: [] }),
      }),
    });
    await catalog.refresh();
    expect(catalog.randomGif()).toBeNull();
  });

  it("keeps the last-good list when a later refresh fails", async () => {
    let n = 0;
    const catalog = new CardGifCatalog({
      url: "https://example.test/manifest.json",
      logger: silent,
      random: () => 0,
      fetchImpl: async () => {
        n += 1;
        if (n === 1) {
          return { ok: true, status: 200, json: async () => ({ gifs: URLS }) };
        }
        return { ok: false, status: 403, json: async () => ({ error: 1010 }) };
      },
    });
    await catalog.refresh();
    expect(catalog.randomGif()).toBe(URLS[0]);
    await catalog.refresh();
    expect(catalog.randomGif()).toBe(URLS[0]);
  });
});
