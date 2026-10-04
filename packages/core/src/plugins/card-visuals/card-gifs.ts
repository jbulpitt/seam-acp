/**
 * Curated GIF catalog for the simple status-card thumbnail.
 *
 * The plugin job refreshes `SIMPLE_CARD_GIF_MANIFEST_URL`. The render
 * path only calls {@link CardGifCatalog.randomGif} — never the network.
 *
 * Cloudflare on r2.dev returns HTTP 403 error 1010 to default/scripted
 * User-Agents, so every fetch sends a browser UA.
 */
import type { Logger } from "../../lib/logger.js";

export const DEFAULT_GIF_MANIFEST_URL =
  "https://pub-d6ab0677dbbb4895a9db45bc6ba2ad08.r2.dev/manifest.json";

/** Chrome-like UA so r2.dev/Cloudflare does not 403 the catalog fetch. */
export const CARD_GIF_BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export const DEFAULT_GIF_REFRESH_MS = 10 * 60 * 1000;

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface CardGifCatalogOpts {
  url: string;
  logger: Pick<Logger, "warn">;
  fetchImpl?: FetchLike;
  random?: () => number;
}

export class CardGifCatalog {
  private readonly url: string;
  private readonly logger: Pick<Logger, "warn">;
  private readonly fetchImpl: FetchLike;
  private readonly random: () => number;
  private urls: string[] = [];

  constructor(opts: CardGifCatalogOpts) {
    this.url = opts.url;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.random = opts.random ?? Math.random;
  }

  /** One HTTPS GIF URL, or null if the catalog is empty / never loaded. */
  randomGif(): string | null {
    if (this.urls.length === 0) return null;
    const i = Math.floor(this.random() * this.urls.length);
    return this.urls[Math.min(i, this.urls.length - 1)] ?? null;
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    try {
      const res = await this.fetchImpl(this.url, {
        headers: { "user-agent": CARD_GIF_BROWSER_UA, accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status, url: this.url }, "card-gif manifest fetch failed");
        return;
      }
      const parsed = parseGifManifest(await res.json());
      if (parsed.length === 0) {
        this.logger.warn({ url: this.url }, "card-gif manifest had no usable URLs");
        this.urls = [];
        return;
      }
      this.urls = parsed;
    } catch (err) {
      this.logger.warn({ err, url: this.url }, "card-gif manifest fetch/parse failed");
    }
  }
}

export function parseGifManifest(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const gifs = (raw as { gifs?: unknown }).gifs;
  if (!Array.isArray(gifs)) return [];
  return gifs.filter(
    (u): u is string => typeof u === "string" && /^https?:\/\//i.test(u.trim())
  ).map((u) => u.trim());
}

async function defaultFetch(
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const res = await fetch(url, { headers: init?.headers, signal: init?.signal });
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
  };
}
