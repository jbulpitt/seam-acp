import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

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
  GEMINI_CLI_PATH: z.string().optional(),
  /** Per-agent model override for the Gemini profile. */
  GEMINI_DEFAULT_MODEL: z.string().default("gemini-2.5-pro"),
  /**
   * Same shape as COPILOT_PROFILES — register additional Gemini profiles
   * each pinned to its own home directory (auth / settings). Format:
   *   id1:/abs/dir1,id2:/abs/dir2
   * Each becomes an agent profile named `gemini-<id>` in /seam agent.
   * The bot injects `GEMINI_CLI_HOME=<dir>` into the child process env;
   * Gemini CLI resolves all state under `<dir>/.gemini/`.
   */
  GEMINI_PROFILES: z
    .string()
    .default("")
    .transform((v) => {
      const out: Array<{ id: string; configDir: string }> = [];
      for (const entry of v.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = entry.indexOf(":");
        if (idx <= 0 || idx === entry.length - 1) {
          throw new Error(
            `GEMINI_PROFILES entry must be 'id:/abs/path' (got '${entry}')`
          );
        }
        const id = entry.slice(0, idx).trim();
        const dir = path.resolve(entry.slice(idx + 1).trim());
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
          throw new Error(
            `GEMINI_PROFILES id '${id}' must be alphanumeric (dashes allowed)`
          );
        }
        out.push({ id, configDir: dir });
      }
      return out;
    }),

  /** Path to the `claude-agent-acp` binary. Defaults to looking it up on PATH. */
  CLAUDE_CLI_PATH: z.string().optional(),
  /** Per-agent model override for the Claude profile. */
  CLAUDE_DEFAULT_MODEL: z.string().default("claude-sonnet-4.5"),
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

  TURN_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(900),
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
