/**
 * P0 (#58): hot-reload of `data/channel-presets.json`.
 *
 * `loadConfig()` reads the presets file exactly once at boot, so today every
 * hand-edit to a rider / lock needs a full `npm run redeploy`. This module
 * re-reads the file on change and swaps the in-memory maps WITHOUT a restart.
 *
 * Two properties matter and both are load-bearing:
 *
 *  1. **Atomic + validated.** We parse + `PresetsFileSchema`-validate into brand
 *     new maps first (via `buildChannelPresetMaps`, the same path `loadConfig`
 *     uses). Only on success do we mutate the live maps. On ANY failure the live
 *     maps are left untouched — the process keeps serving the previous good
 *     config. A bad edit never becomes an outage (D7 / the boot-breaking-write
 *     risk in #58).
 *
 *  2. **Visible to every holder.** `SessionRouter` and the `Orchestrator` each
 *     captured a reference to the SAME `Map` objects created in `loadConfig`
 *     (`config.channelPresets` / `config.threadPresets`). Re-pointing a local
 *     variable would not reach them. So we mutate the existing maps IN PLACE
 *     (`clear()` + repopulate) — every holder of the reference observes the new
 *     config on its next per-turn `resolveChannelPreset` read, with no wiring.
 *
 * The swap is a single synchronous block with no `await` in the middle, and
 * `resolveChannelPreset` reads synchronously, so no turn can ever observe a
 * half-applied map.
 */
import fs from "node:fs";
import path from "node:path";
import { buildChannelPresetMaps } from "../config.js";
import type { BridgeHostConfig, ChannelPreset, ThreadPreset } from "../config.js";
import type { Logger } from "../lib/logger.js";

/** The live preset maps shared by SessionRouter and the orchestrator. */
export interface PresetMaps {
  channelPresets: Map<string, ChannelPreset>;
  threadPresets: Map<string, ThreadPreset>;
  bridgePresets: Map<string, BridgeHostConfig>;
}

export interface ReloadResult {
  ok: boolean;
  /** Populated with the failure message when `ok` is false. */
  error?: string;
}

function applyInPlace<V>(live: Map<string, V>, next: Map<string, V>): void {
  live.clear();
  for (const [k, v] of next) live.set(k, v);
}

/**
 * Re-read `file`, validate it, and atomically swap the contents of the live
 * `target` maps in place. On failure the maps are untouched and the previous
 * good config is kept (logged loudly). Safe to call with `file` undefined
 * (no-op success — clears nothing, since the feature is simply inactive).
 */
export function reloadChannelPresets(
  target: PresetMaps,
  file: string | undefined,
  logger: Logger
): ReloadResult {
  let next: PresetMaps;
  try {
    next = buildChannelPresetMaps(file);
  } catch (err) {
    const error = (err as Error).message;
    logger.error(
      { err, file },
      "channel-presets hot-reload rejected; keeping previous good config"
    );
    return { ok: false, error };
  }
  // Atomic in-place swap — no await between the two applies, so a concurrent
  // per-turn read sees either the full old maps or the full new maps.
  applyInPlace(target.channelPresets, next.channelPresets);
  applyInPlace(target.threadPresets, next.threadPresets);
  if (!target.bridgePresets) {
    (target as PresetMaps).bridgePresets = new Map();
  }
  applyInPlace(target.bridgePresets, next.bridgePresets);
  logger.info(
    {
      file,
      channels: target.channelPresets.size,
      threads: target.threadPresets.size,
      bridges: target.bridgePresets.size,
    },
    "channel-presets hot-reloaded"
  );
  return { ok: true };
}

/**
 * Watch `file` and hot-reload the `target` maps on change. Returns a stop
 * function. We watch the containing DIRECTORY (not the file inode) because many
 * editors save via rename/replace, which detaches an inode-level `fs.watch`.
 * Reloads are debounced to coalesce the multi-event bursts a single save emits.
 * If watching cannot be established the feature degrades to inactive rather than
 * crashing the process.
 */
export function watchChannelPresets(
  file: string,
  target: PresetMaps,
  logger: Logger,
  debounceMs = 150
): () => void {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(dir, (_event, filename) => {
      // Directory watch fires for every file in the dir; only react to ours.
      if (filename && path.basename(filename.toString()) !== base) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        reloadChannelPresets(target, abs, logger);
      }, debounceMs);
    });
  } catch (err) {
    logger.warn(
      { err, dir },
      "could not watch channel-presets directory; hot-reload disabled"
    );
    return () => {};
  }
  logger.info({ file: abs }, "watching channel-presets for hot-reload");
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
