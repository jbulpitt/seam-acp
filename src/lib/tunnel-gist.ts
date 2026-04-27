/**
 * Publishes the current Cloudflare quick-tunnel WebSocket URL to a GitHub
 * Gist so remote bridge scripts can discover it without needing a stable
 * hostname.
 *
 * The URL is written to data/tunnel-url.txt by scripts/start-cloudflared-quick.sh
 * whenever cloudflared announces a new tunnel. This module watches that file
 * and re-publishes whenever it changes (handles independent cloudflared
 * restarts as well as the initial startup).
 */

import fs from "node:fs";
import type { Logger } from "pino";

/**
 * Read the current tunnel wss:// URL from the data file written by the
 * cloudflared wrapper script. Returns null if the file doesn't exist yet.
 */
function readTunnelUrl(urlFile: string): string | null {
  try {
    return fs.readFileSync(urlFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Push the current URL to the gist. Best-effort: errors are logged, not thrown.
 */
async function pushToGist(
  gistId: string,
  urlFile: string,
  logger: Logger
): Promise<void> {
  const wsUrl = readTunnelUrl(urlFile);
  if (!wsUrl) {
    logger.warn("tunnel-gist: URL file not found or empty — skipping");
    return;
  }

  let ghToken: string;
  try {
    const { execSync } = await import("node:child_process");
    ghToken = execSync("gh auth token", { stdio: ["pipe", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    logger.warn("tunnel-gist: gh auth token failed — skipping gist update");
    return;
  }

  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ghToken}`,
        "Content-Type": "application/json",
        "User-Agent": "seam-acp",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        files: { "tunnel-url.txt": { content: wsUrl } },
      }),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        "tunnel-gist: gist update failed"
      );
      return;
    }
    logger.info({ url: wsUrl }, "tunnel-gist: published tunnel URL to gist");
  } catch (err) {
    logger.warn({ err }, "tunnel-gist: gist update error");
  }
}

/**
 * Start watching the tunnel URL file and publish to the gist whenever it
 * changes. Also does an immediate publish if the file already exists.
 * Returns a cleanup function that stops the watcher.
 */
export function startTunnelGistPublisher(
  gistId: string,
  urlFile: string,
  logger: Logger
): () => void {
  // Publish immediately if the file is already there (normal startup order).
  void pushToGist(gistId, urlFile, logger);

  // Watch the file's parent directory for changes to the URL file so we
  // also catch independent cloudflared restarts.
  const dir = urlFile.substring(0, urlFile.lastIndexOf("/")) || ".";
  const base = urlFile.substring(urlFile.lastIndexOf("/") + 1);

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;

  try {
    watcher = fs.watch(dir, (event, filename) => {
      if (filename !== base) return;
      // Debounce — cloudflared writes the file once but the watcher can
      // fire multiple events in quick succession.
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void pushToGist(gistId, urlFile, logger);
      }, 500);
    });
  } catch (err) {
    logger.warn({ err }, "tunnel-gist: could not watch URL file directory");
  }

  return () => {
    if (debounce) clearTimeout(debounce);
    watcher?.close();
  };
}
