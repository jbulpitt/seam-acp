import * as dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const ModelsListSchema = z
  .string()
  .default("")
  .transform((v) => {
    const out: Array<{ modelId: string; name: string }> = [];
    for (const entry of v.split(",").map((s) => s.trim()).filter(Boolean)) {
      const idx = entry.indexOf(":");
      if (idx > 0 && idx < entry.length - 1) {
        out.push({ modelId: entry.slice(0, idx).trim(), name: entry.slice(idx + 1).trim() });
      } else {
        out.push({ modelId: entry, name: entry });
      }
    }
    return out.length > 0 ? out : undefined;
  });

const Schema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_ALLOWED_USER_IDS: z
    .string()
    .min(1, "DISCORD_ALLOWED_USER_IDS is required")
    .transform((v) => {
      const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.some((id) => !/^\d+$/.test(id))) {
        throw new Error("DISCORD_ALLOWED_USER_IDS must be comma-separated numeric Discord user IDs");
      }
      return new Set(ids);
    }),
  /**
   * Optional comma-separated list of parent channel IDs the bot is allowed to
   * operate in. When set, the bot only responds in threads whose parent channel
   * is in this list. When unset (default), all channels are allowed.
   */
  DISCORD_ALLOWED_CHANNEL_IDS: z
    .string()
    .default("")
    .transform((v) => {
      const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.some((id) => !/^\d+$/.test(id))) {
        throw new Error("DISCORD_ALLOWED_CHANNEL_IDS must be comma-separated numeric Discord channel IDs");
      }
      return ids.length > 0 ? new Set(ids) : undefined;
    }),
  DISCORD_DEV_GUILD_ID: z
    .string()
    .regex(/^\d+$/)
    .optional(),

  REPOS_ROOT: z.string().min(1, "REPOS_ROOT is required"),
  DATA_DIR: z.string().default("./data"),
  /**
   * Comma-separated list of absolute directories the `/seam attach`
   * slash command is allowed to read from. REPOS_ROOT is always
   * implicitly allowed. Defaults to empty (only REPOS_ROOT).
   */
  ATTACH_ROOTS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => path.resolve(p))
    ),

  /**
   * Comma-separated list of repo names mapped to an emoji for display, e.g. "seam-acp:🧵,core:📦"
   */
  REPO_EMOJIS: z
    .string()
    .default("")
    .transform((v) => {
      const map = new Map<string, string>();
      for (const entry of v.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = entry.indexOf(":");
        if (idx <= 0) continue;
        const repo = entry.slice(0, idx).trim();
        const emoji = entry.slice(idx + 1).trim();
        map.set(repo, emoji);
      }
      return map;
    }),


  DEFAULT_AGENT: z.string().default("copilot"),
  DEFAULT_MODEL: z.string().default("gpt-5.4"),
  COPILOT_CLI_PATH: z.string().optional(),
  /**
   * Comma-separated list of additional Copilot profiles, each of the form
   * `id:/abs/path/to/config-dir`. Each entry registers a separate agent
   * profile with `--config-dir` pointed at its own directory, giving
   * fully-isolated auth / MCP / sessions. Lets a single bot serve multiple
   * GitHub accounts. Example:
   *   COPILOT_PROFILES=work:/Users/me/.copilot-work,personal:/Users/me/.copilot-personal
   * Each id must be unique and not collide with built-in profile ids
   * (`copilot`, `gemini`).
   */
  COPILOT_PROFILES: z
    .string()
    .default("")
    .transform((v) => {
      const out: Array<{ id: string; configDir: string }> = [];
      for (const entry of v.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = entry.indexOf(":");
        if (idx <= 0 || idx === entry.length - 1) {
          throw new Error(
            `COPILOT_PROFILES entry must be 'id:/abs/path' (got '${entry}')`
          );
        }
        const id = entry.slice(0, idx).trim();
        const dir = path.resolve(entry.slice(idx + 1).trim());
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
          throw new Error(
            `COPILOT_PROFILES id '${id}' must be alphanumeric (dashes allowed)`
          );
        }
        out.push({ id, configDir: dir });
      }
      return out;
    }),
  COPILOT_MODELS: ModelsListSchema,

  /** Path to the `claude-agent-acp` binary. Defaults to looking it up on PATH. */
  CLAUDE_CLI_PATH: z.string().optional(),
  /** Per-agent model override for the Claude profile. */
  CLAUDE_DEFAULT_MODEL: z.string().default("claude-sonnet-4.5"),
  /**
   * Optional fixed extended-thinking budget, forwarded as the (deprecated)
   * `MAX_THINKING_TOKENS` env var. Default 0 = unset, which is what you want:
   * modern models think on their own — Sonnet 4.6 / Haiku 4.5 stream thinking by
   * default, and adaptive models (Opus 4.6+) decide their own budget and ignore
   * this (their visibility is governed by CLAUDE_THINKING_DISPLAY). Set > 0 only
   * to cap/force a budget on an older model that needs it. (Verified: with this
   * unset, Sonnet/Haiku still emit thinking and Opus summarized-display works.)
   */
  CLAUDE_MAX_THINKING_TOKENS: z.coerce.number().int().min(0).max(64000).default(0),
  /**
   * How adaptive-thinking models (Opus 4.6+) surface their reasoning. These
   * models default to "omitted" — their thinking never reaches the status panel.
   * "summarized" makes them stream a readable summary instead. Applied via
   * `_meta.claudeCode.options.thinking.display`; Sonnet/Haiku ignore it (they
   * stream thinking via the token-budget path regardless).
   */
  CLAUDE_THINKING_DISPLAY: z.enum(["summarized", "omitted"]).default("summarized"),
  /**
   * Context token threshold to trigger compaction. Set to 0 to disable.
   * If <= 1.0, treated as a fraction of the model's context window.
   */
  CLAUDE_COMPACTION_TOKEN_THRESHOLD: z.coerce.number().min(0).default(0.8),
  /**
   * Context-usage fraction (0–1) at which agy auto-compacts. agy has no
   * built-in auto-compaction, so seam-acp watches its `usage_update` events
   * and runs the same /compact flow at end-of-turn once usage crosses this.
   * Set to 0 to disable.
   */
  AGY_AUTO_COMPACT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  /**
   * Comma-separated list of remote profile ids (without the `copilot-remote-`
   * prefix) whose host has network restrictions that block Discord. For these
   * profiles, attachments are downloaded server-side and written to the
   * agent's filesystem via the bridge's `writeAttachment` cmd; the LLM gets a
   * local path in the prompt instead of a Discord URL.
   */
  REMOTE_DISCORD_RESTRICTED_PROFILES: z
    .string()
    .default("")
    .transform((v) => new Set(v.split(",").map((s) => s.trim()).filter(Boolean))),
  /** Raw Google AI Studio API key for /seam image. Leave empty and set
   *  GOOGLE_AI_STUDIO_API_KEY_FILE instead to read from a file. */
  GOOGLE_AI_STUDIO_API_KEY: z.string().default(""),
  /** Path to a file whose first non-empty line is the Google AI Studio key. */
  GOOGLE_AI_STUDIO_API_KEY_FILE: z.string().default(""),
  /** Black Forest Labs API key for FLUX 2 models in /seam image. */
  BFL_API_KEY: z.string().default(""),
  /**
   * Model used to generate compaction summaries (auto + manual `/compact`).
   * Picked per-agent. Should be a high-context model with strong summarization
   * — the session's own model may be too small to fit a near-full transcript
   * (e.g. Sonnet 200K compacting at 80% leaves no headroom for the response).
   */
  AGY_COMPACTION_MODEL: z.string().default("Gemini 3.1 Pro (High)"),
  // "default" resolves to the latest Opus @ 1M; the bare "opus[1m]" alias
  // mis-resolves to the credit-gated sonnet[1m] in claude-agent-acp 0.39.
  CLAUDE_COMPACTION_MODEL: z.string().default("default"),
  COPILOT_COMPACTION_MODEL: z.string().default("gpt-5.5"),
  /**
   * Same shape as COPILOT_PROFILES — register additional Claude profiles
   * each pinned to its own --config-dir (auth / settings). Format:
   *   id1:/abs/dir1,id2:/abs/dir2
   * Each becomes an agent profile named `claude-<id>` in /seam agent.
   */
  CLAUDE_PROFILES: z
    .string()
    .default("")
    .transform((v) => {
      const out: Array<{ id: string; configDir: string }> = [];
      for (const entry of v.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = entry.indexOf(":");
        if (idx <= 0 || idx === entry.length - 1) {
          throw new Error(
            `CLAUDE_PROFILES entry must be 'id:/abs/path' (got '${entry}')`
          );
        }
        const id = entry.slice(0, idx).trim();
        const dir = path.resolve(entry.slice(idx + 1).trim());
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
          throw new Error(
            `CLAUDE_PROFILES id '${id}' must be alphanumeric (dashes allowed)`
          );
        }
        out.push({ id, configDir: dir });
      }
      return out;
    }),

  CLAUDE_MODELS: ModelsListSchema,

  /** Path to the `agy` (Antigravity) binary. Defaults to `~/.local/bin/agy` if present, else `agy` on PATH. */
  AGY_CLI_PATH: z.string().optional(),
  /** Cosmetic model id reported by the Antigravity profile. */
  AGY_DEFAULT_MODEL: z.string().default("antigravity"),
  AGY_MODELS: ModelsListSchema,

  /**
   * Comma-separated list of remote Copilot profiles. Each entry registers an
   * agent profile named `copilot-remote-<id>` that pipes ACP over a WebSocket
   * to a bridge script running on the remote machine.
   *
   * Two modes are supported, distinguished by the format:
   *
   * **Server mode** (seam-acp hosts the WS server; bridge dials in):
   *   `id:port:token`
   *   Example: `mac:9999:mysecrettoken`
   *   Run on the remote machine:
   *     `node scripts/remote-agent-bridge.mjs wss://<seam-acp-host>:9999 mysecrettoken`
   *
   * **Client mode** (bridge hosts the WS server; seam-acp dials out):
   *   `id:wss://url:token`   (url starts with ws:// or wss://)
   *   Example: `mac:wss://random.trycloudflare.com:mysecrettoken`
   *   Run on the remote machine:
   *     `node scripts/remote-agent-bridge.mjs --server 9999 mysecrettoken`
   *   Then expose with: `cloudflared tunnel --url ws://localhost:9999`
   *
   * Multiple entries are comma-separated. Token may contain colons in server
   * mode; in client mode the token must not contain colons (it is split on the
   * last colon after the URL).
   */
  REMOTE_COPILOT_PROFILES: z
    .string()
    .default("")
    .transform((v) => {
      const out: Array<
        | { id: string; mode: "server"; wsPort: number; token: string; defaultModel?: string }
        | { id: string; mode: "client"; wsUrl: string; token: string; defaultModel?: string }
      > = [];
      for (const entry of v.split(",").map((s) => s.trim()).filter(Boolean)) {
        const first = entry.indexOf(":");
        if (first <= 0) {
          throw new Error(
            `REMOTE_COPILOT_PROFILES entry must be 'id:port:token' or 'id:wsUrl:token' (got '${entry}')`
          );
        }
        const id = entry.slice(0, first).trim();
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
          throw new Error(
            `REMOTE_COPILOT_PROFILES id '${id}' must be alphanumeric (dashes allowed)`
          );
        }
        const rest = entry.slice(first + 1);

        if (rest.startsWith("ws://") || rest.startsWith("wss://")) {
          // Client mode: id:wsUrl:token — split on last colon for token.
          const lastColon = rest.lastIndexOf(":");
          if (lastColon <= "wss://".length || lastColon === rest.length - 1) {
            throw new Error(
              `REMOTE_COPILOT_PROFILES client entry must be 'id:wsUrl:token' (got '${entry}')`
            );
          }
          const wsUrl = rest.slice(0, lastColon);
          const tokenAndModel = rest.slice(lastColon + 1);
          const [token, defaultModel] = tokenAndModel.split("@");
          out.push({ id, mode: "client", wsUrl, token: token!, defaultModel });
        } else {
          // Server mode: id:port:token — token may contain colons.
          const second = rest.indexOf(":");
          if (second <= 0 || second === rest.length - 1) {
            throw new Error(
              `REMOTE_COPILOT_PROFILES server entry must be 'id:port:token' (got '${entry}')`
            );
          }
          const portStr = rest.slice(0, second).trim();
          const tokenAndModel = rest.slice(second + 1);
          const [token, defaultModel] = tokenAndModel.split("@");
          const wsPort = Number(portStr);
          if (!Number.isInteger(wsPort) || wsPort < 1 || wsPort > 65535) {
            throw new Error(
              `REMOTE_COPILOT_PROFILES port '${portStr}' must be a valid port number`
            );
          }
          out.push({ id, mode: "server", wsPort, token: token!, defaultModel });
        }
      }
      return out;
    }),

  TURN_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(604800).default(900),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * Bot-wide default permission policy for new sessions.
   * - "always": auto-approve every request (yolo)
   * - "ask": prompt the user in Discord; deny on timeout (recommended)
   * - "deny": auto-deny every request
   *
   * For backward compat, `DEFAULT_AUTO_APPROVE=true` (legacy var) overrides
   * this to "always" when set; `false` is ignored.
   */
  DEFAULT_PERMISSION_POLICY: z
    .enum(["always", "ask", "deny"])
    .default("ask"),
  /**
   * @deprecated Use DEFAULT_PERMISSION_POLICY instead. When `true`, forces
   * the bot-wide default to "always" (auto-approve everything for new
   * sessions). When `false`, has no effect.
   */
  DEFAULT_AUTO_APPROVE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * Optional Discord channel/thread id where bot lifecycle notifications
   * (startup, restart pending) are posted. When unset, no notifications are
   * sent.
   */
  DISCORD_NOTIFICATIONS_CHANNEL_ID: z
    .string()
    .regex(/^\d+$/, "DISCORD_NOTIFICATIONS_CHANNEL_ID must be a numeric Discord channel id")
    .optional(),

  /**
   * Optional path to a JSON file that pre-configures specific Discord parent
   * channels with locked or default agent / model / cwd. When unset, the
   * feature is inactive. See PresetsFileSchema below for the shape.
   */
  CHANNEL_PRESETS_FILE: z.string().optional(),

  /**
   * Optional GitHub Gist ID used to publish the current Cloudflare quick-tunnel
   * WebSocket URL on startup. When set, seam-acp writes the current wss://
   * URL from data/tunnel-url.txt to the gist so remote bridge scripts can
   * discover the endpoint without a stable hostname. Requires `gh` CLI to be
   * authenticated. The gist is also re-published whenever the tunnel URL file
   * changes (i.e. after an independent cloudflared restart).
   */
  TUNNEL_GIST_ID: z.string().optional(),

  /**
   * Controls the `/seam new` and `/seam init` thread initialization flow.
   * - "repo":  (default) only show the repo picker
   * - "full":  after repo selection, also present an agent picker and a
   *            model picker in sequence so the user can configure the
   *            session before sending their first message
   */
  NEW_THREAD_WIZARD: z.enum(["repo", "full"]).default("repo"),
});

const PresetFieldSchema = <T extends z.ZodType>(value: T) =>
  z.object({ value, locked: z.boolean().optional().default(false) });

const PresetsFileSchema = z.record(
  z.string().regex(/^\d+$/, "preset key must be a numeric Discord channel id"),
  z.object({
    agent: PresetFieldSchema(z.string().min(1)).optional(),
    model: PresetFieldSchema(z.string().min(1)).optional(),
    cwd: PresetFieldSchema(z.string().min(1)).optional(),
  })
);

export type ChannelPresetField<T> = { value: T; locked: boolean };
export type ChannelPreset = {
  agent?: ChannelPresetField<string>;
  model?: ChannelPresetField<string>;
  cwd?: ChannelPresetField<string>;
};

export type Config = z.infer<typeof Schema> & {
  channelPresets: Map<string, ChannelPreset>;
};

export function loadConfig(): Config {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  const reposRoot = path.resolve(cfg.REPOS_ROOT);
  if (!fs.existsSync(reposRoot) || !fs.statSync(reposRoot).isDirectory()) {
    throw new Error(
      `REPOS_ROOT does not exist or is not a directory: ${reposRoot}\n` +
        `Set REPOS_ROOT in your .env to a real folder containing your repos ` +
        `(e.g. REPOS_ROOT=${path.join(process.env.HOME ?? "", "Projects")}).`
    );
  }
  cfg.REPOS_ROOT = reposRoot;

  const channelPresets = loadChannelPresets(cfg.CHANNEL_PRESETS_FILE);
  return { ...cfg, channelPresets };
}

function loadChannelPresets(file: string | undefined): Map<string, ChannelPreset> {
  const out = new Map<string, ChannelPreset>();
  if (!file) return out;
  const abs = path.resolve(file);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(
      `CHANNEL_PRESETS_FILE could not be read: ${abs} (${(err as Error).message})`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `CHANNEL_PRESETS_FILE is not valid JSON: ${abs} (${(err as Error).message})`
    );
  }
  const result = PresetsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid CHANNEL_PRESETS_FILE (${abs}):\n${issues}`);
  }
  for (const [channelId, preset] of Object.entries(result.data)) {
    if (!preset) continue;
    const normalized: ChannelPreset = {};
    if (preset.agent) normalized.agent = preset.agent;
    if (preset.model) normalized.model = preset.model;
    if (preset.cwd) normalized.cwd = { ...preset.cwd, value: path.resolve(preset.cwd.value) };
    out.set(channelId, normalized);
  }
  return out;
}

export const REMOTE_MAC_MODELS = [
  { modelId: "claude-opus-4.6", name: "Claude Opus 4.6", contextLimit: 200_000 },
  { modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextLimit: 200_000 },
  { modelId: "gpt-5.2-codex", name: "GPT-5.2-Codex", contextLimit: 400_000 },
  { modelId: "gpt-5.3-codex", name: "GPT-5.3-Codex", contextLimit: 400_000 },
  { modelId: "gpt-5.4", name: "GPT-5.4", contextLimit: 400_000 },
  { modelId: "gpt-5-mini", name: "GPT-5 mini", contextLimit: 192_000 },
  { modelId: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", contextLimit: 200_000 },
  { modelId: "claude-opus-4.5", name: "Claude Opus 4.5", contextLimit: 200_000 },
  { modelId: "claude-haiku-4.5", name: "Claude Haiku 4.5", contextLimit: 200_000 },
  { modelId: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
  { modelId: "gpt-3.5-turbo", name: "GPT 3.5 Turbo" }
];
