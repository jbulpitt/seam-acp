import * as dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { retiredAgentConfigMessage } from "./core/retired-agents.js";

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
   *
   * IDs only — never resolve names. Discord Channel Obfuscation (#52) can
   * make inaccessible channels appear as `___hidden___` on the Gateway and
   * omits them from GET /guilds/{id}/channels. This allowlist is a static
   * env parse; it must not enumerate the guild channel list.
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
  /**
   * Optional comma-separated list of guild (server) IDs to register the `/seam`
   * slash commands to. Guild-scoped registration is INSTANT (vs ~1h for global),
   * so list every server you want the command menu in and we register to each.
   * Empty/unset → register GLOBALLY (appears in every server the bot is in, with
   * ~1h propagation). A single id still works (backward compatible). The name is
   * kept for compatibility even though it now accepts multiple ids.
   */
  DISCORD_DEV_GUILD_ID: z
    .string()
    .default("")
    .transform((v) => {
      const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.some((id) => !/^\d+$/.test(id))) {
        throw new Error("DISCORD_DEV_GUILD_ID must be comma-separated numeric Discord guild IDs");
      }
      return ids;
    }),

  REPOS_ROOT: z.string().min(1, "REPOS_ROOT is required"),
  DATA_DIR: z.string().default("./data"),
  /**
   * Agent-facing seam-MCP tool surface (#24): one shared in-process HTTP MCP
   * server whose `handoff` / `forward` / `peek` tools are injected per session
   * with an identifying token. Default on; set to "false" to run without it.
   */
  SEAM_MCP_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * Tier-C conversational mutation (#58 P3): allow the seam-MCP `config_propose`
   * tool to write `data/channel-presets.json` (the calling thread's OWN channel
   * preset — agent/model/cwd/effort/rider only). Default OFF, per D4: Tier C is
   * the dangerous half (riders + the lock live in this file). Even when ON the
   * tool can NEVER touch the `locked` flag or another channel (D2/P3), every
   * write round-trips through PresetsFileSchema (D7), and a human still confirms
   * the diff card (D5). Tier A/B mutation (session config + own presets) does not
   * depend on this flag. `.env` mutation is out of scope permanently.
   */
  SEAM_CONFIG_MUTATION_TIER_C_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Agent-defined watches (#60): allow the privileged `command` watch source (a
   * watch whose predicate is an agent-authored command run on an interval).
   * Default OFF (D8) — `file` and `http` watches are always available; only the
   * command executor is gated. Even when ON, a command watch is refused unless
   * its EXACT command string is on WATCH_COMMAND_ALLOWLIST — an agent-supplied
   * string is never shell-evaluated unguarded. This is the flag half of the D8
   * gate; the allowlist is the other half.
   */
  WATCH_COMMAND_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Comma-separated allowlist of EXACT command strings a `command` watch may run
   * (only consulted when WATCH_COMMAND_ENABLED). Exact match, not prefix — a
   * prefix match ("git" allowing "git; rm -rf") is the injection D8 warns about.
   * Empty ⇒ no command is runnable even with the flag on. Commands run argv-style
   * (split on whitespace, no shell), detached from the agent's process group.
   */
  WATCH_COMMAND_ALLOWLIST: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),
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
   * When true, `/seam attach` and `seam-attach` fences may upload ANY readable
   * file on the host, bypassing the REPOS_ROOT / ATTACH_ROOTS confinement.
   * Off by default — only enable on a single-user, fully-trusted instance, since
   * it lets the agent (and anyone who can prompt it) exfiltrate any file the bot
   * process can read.
   */
  ATTACH_ALLOW_ANY_PATH: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

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
   * (`copilot`, `agy`, `claude`).
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
  /** Artificial Analysis Data API key used only by the 12-hour model-value refresh. */
  AA_API_KEY: z.string().default(""),
  /** Fixed standard coding task used to compare per-token model cost (#130). */
  MODEL_VALUE_STD_INPUT_TOKENS: z.coerce.number().int().positive().default(8000),
  MODEL_VALUE_STD_OUTPUT_TOKENS: z.coerce.number().int().positive().default(2000),

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
   * Model used to generate compaction summaries (auto + manual `/compact`).
   * Picked per-agent. Should be a high-context model with strong summarization
   * — the session's own model may be too small to fit a near-full transcript
   * (e.g. Sonnet 200K compacting at 80% leaves no headroom for the response).
   */
  AGY_COMPACTION_MODEL: z.string().default("Claude Opus 4.6 (Thinking)"),
  // "default" resolves to the latest Opus @ 1M on the configured Max account.
  CLAUDE_COMPACTION_MODEL: z.string().default("default"),
  COPILOT_COMPACTION_MODEL: z.string().default("gpt-5.5"),
  /**
   * Same shape as COPILOT_PROFILES — register additional Claude profiles
   * each pinned to its own --config-dir (auth / settings). Format:
   *   id1:/abs/dir1,id2:/abs/dir2
   * Each becomes an agent profile named `claude-<id>` in /seam config agent.
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

  CLAUDE_VERTEX_PROJECT_ID: z.string().optional(),
  CLAUDE_VERTEX_REGION: z.string().default("us-central1"),

  /** Path to the `agy` (Antigravity) binary. Defaults to `~/.local/bin/agy` if present, else `agy` on PATH. */
  AGY_CLI_PATH: z.string().optional(),
  /** Cosmetic model id reported by the Antigravity profile. */
  AGY_DEFAULT_MODEL: z.string().default("antigravity"),
  AGY_MODELS: ModelsListSchema,
  /** Sandboxed Agy model used by the tool-mediated image inspector. */
  AGY_VISION_MODEL: z.string().default("gemini-3.7-flash-high"),

  /**
   * Register the OpenAI Codex agent: `@agentclientprotocol/codex-acp` — a
   * dedicated ACP adapter for the Codex CLI (`@openai/codex`). When enabled,
   * an "OpenAI Codex" profile appears in `/seam config agent`.
   * false → not registered.
   */
  CODEX_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Path to the `codex-acp` binary. Defaults to `codex-acp` on PATH. */
  CODEX_CLI_PATH: z.string().optional(),
  /** Default model id for the Codex profile (e.g. "o3", "gpt-5.5"). */
  CODEX_DEFAULT_MODEL: z.string().default("gpt-5.5"),
  CODEX_MODELS: ModelsListSchema,
  /** Model used for /compact on Codex sessions. Defaults to same as Copilot. */
  CODEX_COMPACTION_MODEL: z.string().default("gpt-5.5"),

  /**
   * Register the xAI Grok Build agent.  The `grok` CLI speaks ACP natively
   * via `grok agent stdio` — no separate adapter is needed.
   * When enabled, a "Grok Build" profile appears in `/seam config agent`.
   * false → not registered.
   */
  GROK_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * Speaker identity (issue #57). When true, each human chat turn carries a
   * harness-stamped speaker name + id into the `<seam-harness>` preamble so the
   * agent can attribute turns across a multi-person thread. Default false is the
   * rollback guarantee: when off, the emitted prompt is byte-identical to before.
   */
  SPEAKER_IDENTITY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * Config-mutation admins (#71). The ids that may propose/apply a config change
   * in a LOCKED channel WITHOUT unlocking, and — locked or not — the ONLY ids
   * allowed to click Apply on a config confirm card. Parsed EXACTLY like
   * DISCORD_ALLOWED_USER_IDS (comma-separated numeric Discord ids), but OPTIONAL:
   *   - Unset / empty ⇒ opt-out, today's behavior byte-for-byte: a locked channel
   *     refuses config_propose for everyone, and Apply falls back to
   *     DISCORD_ALLOWED_USER_IDS. Empty-string is treated as unset, NOT "nobody".
   * The propose gate keys on the harness-stamped SPEAKER id (#57 trust anchor),
   * so with SPEAKER_IDENTITY_ENABLED off a locked channel still refuses everyone
   * (no trustworthy id ⇒ never fail open). This set does NOT permit changing the
   * `locked` flag itself — that stays out-of-band for everyone.
   */
  SEAM_CONFIG_ADMIN_USER_IDS: z
    .string()
    .default("")
    .transform((v) => {
      const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.some((id) => !/^\d+$/.test(id))) {
        throw new Error("SEAM_CONFIG_ADMIN_USER_IDS must be comma-separated numeric Discord user IDs");
      }
      return ids.length > 0 ? (new Set(ids) as ReadonlySet<string>) : undefined;
    }),

  /**
   * Chat-only participants (#74). A RESTRICTION MARKER, not a second allowlist:
   * each id must also appear in DISCORD_ALLOWED_USER_IDS (they can talk to
   * agents) but they can NEVER configure anything — slash config, pickers,
   * Apply, or config_propose. Parsed EXACTLY like SEAM_CONFIG_ADMIN_USER_IDS:
   *   - Unset / empty / whitespace ⇒ undefined (opt-out, NOT "nobody") so
   *     today's behavior is byte-identical until the operator seeds the list.
   * Precedence is admin > participant > operator: an id in BOTH sets is an
   * admin, not a restricted participant (see `isRestrictedParticipant`). The
   * overlap is logged at boot so a privilege bug cannot hide in a silent pick.
   */
  SEAM_PARTICIPANT_USER_IDS: z
    .string()
    .default("")
    .transform((v) => {
      const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.some((id) => !/^\d+$/.test(id))) {
        throw new Error("SEAM_PARTICIPANT_USER_IDS must be comma-separated numeric Discord user IDs");
      }
      return ids.length > 0 ? (new Set(ids) as ReadonlySet<string>) : undefined;
    }),

  /**
   * Mid-turn reply routing (#63). Decides what a bare Discord message typed while
   * a turn is ALREADY active on that thread does:
   *   - "abort" (default): force-abort the running turn and start a fresh one —
   *     today's "the user is the priority interrupt" behavior. Chosen as the
   *     default so this ships DARK: no behavior change until an operator flips it.
   *   - "inbox": route the message into that session's durable inbox (#61)
   *     COOPERATIVELY — the running agent reads it at its next `poll_inbox`, no
   *     cancel, no second turn. This is the June plan's default (option (a) in
   *     #63); gated so it can be proven behind the flag before becoming default.
   * The explicit `/seam steer … now:true` preemptive path is independent of this.
   */
  SEAM_MIDTURN_REPLY_MODE: z.enum(["abort", "inbox"]).default("abort"),

  /**
   * Inbox-awareness preamble (#61). When true, a human chat turn's
   * `<seam-harness>` includes a standing `poll_inbox` bullet — but only if
   * that session actually has seam-mcp attached (#108). Default false
   * ships DARK: the golden preamble stays byte-identical until an operator
   * flips this. Dispatch turns get a harness with seamFences off; the
   * per-handoff `watchFeedback` instruction is still independent and is
   * itself gated on seam-mcp.
   */
  SEAM_INBOX_PREAMBLE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * Optional override map of Discord user id → display name, e.g.
   * "1487094572696867019:Jesse,1534937951044112505:Allie". Takes precedence over
   * the Discord nickname/global-name/username, both to guarantee a clean label
   * (raw display names are often unusable, e.g. "xX_allie_Xx") and — the load-
   * bearing reason — to move the displayed name from user control to admin
   * control (issue #57 D5). Parsed like REPO_EMOJIS (`:101`); ids are numeric so
   * splitting on the first `:` is unambiguous.
   */
  DISCORD_USER_NAMES: z
    .string()
    .default("")
    .transform((v) => {
      const map = new Map<string, string>();
      for (const entry of v.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = entry.indexOf(":");
        if (idx <= 0) continue;
        const id = entry.slice(0, idx).trim();
        const name = entry.slice(idx + 1).trim();
        if (id && name) map.set(id, name);
      }
      return map;
    }),
  /** Path to the `grok` binary. Defaults to `grok` on PATH. */
  GROK_CLI_PATH: z.string().optional(),
  /** Default model id for the Grok profile (e.g. "grok-build-0.1"). */
  GROK_DEFAULT_MODEL: z.string().default("grok-4.6"),
  GROK_MODELS: ModelsListSchema,
  /** Model used for /compact on Grok sessions. */
  GROK_COMPACTION_MODEL: z.string().default("grok-4.5"),
  /** xAI API key.  When set, enables dynamic model discovery at startup via
   *  GET https://api.x.ai/v1/models and is passed to the grok CLI process. */
  GROK_API_KEY: z.string().optional(),

  /**
   * Register the Z.ai (Zhipu) agent — Claude Code (claude-agent-acp) pointed
   * at Z.ai's Anthropic-compatible endpoint (api.z.ai/api/anthropic).
   * Uses GLM models (glm-5.2, glm-4.7, etc.).  false → not registered.
   */
  ZAI_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Z.ai API key (from the Z.ai developer console). */
  ZAI_API_KEY: z.string().optional(),
  /** Default model id for the Z.ai profile (e.g. "glm-5.2"). */
  ZAI_DEFAULT_MODEL: z.string().default("glm-5.2"),
  ZAI_MODELS: ModelsListSchema,
  /** Model used for /compact on Z.ai sessions. */
  ZAI_COMPACTION_MODEL: z.string().default("glm-5.2"),

  /**
   * Register the Ollama Cloud agent — OpenAI Codex (codex-acp) pointed at
   * Ollama's OpenAI-compatible endpoint (https://ollama.com/v1) via a dedicated
   * CODEX_HOME whose config.toml declares an "ollama-cloud" model_provider
   * (wire_api = "responses"). Uses open-weight models hosted on Ollama's cloud
   * infrastructure. Only registered when OLLAMA_CLOUD_ENABLED and
   * OLLAMA_CLOUD_API_KEY are set.
   */
  OLLAMA_CLOUD_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Ollama Cloud API key (from ollama.com account settings). */
  OLLAMA_CLOUD_API_KEY: z.string().optional(),
  /** Path to `ollama-usage`. Defaults to `ollama-usage` on PATH. */
  OLLAMA_USAGE_CLI_PATH: z.string().optional(),
  /**
   * Base URL codex uses for the Ollama Cloud provider. Defaults to the local
   * codex-universal-proxy (chat-completion adaptor), which flattens codex's
   * namespace-wrapped MCP tools into plain function tools so the seam-mcp tools
   * work: codex 0.117+ wraps MCP tools in a `type:"namespace"` that Ollama's
   * OpenAI-compat endpoint silently drops (openai/codex#23186). Point straight
   * at https://ollama.com/v1 only if MCP tools aren't needed for these models.
   */
  OLLAMA_CLOUD_CODEX_BASE_URL: z.string().default("http://127.0.0.1:11436/v1"),
  /** Default model id for Ollama Cloud sessions. */
  OLLAMA_CLOUD_DEFAULT_MODEL: z.string().default("glm-5.3:cloud"),
  OLLAMA_CLOUD_MODELS: ModelsListSchema,
  /** Model used for /compact on Ollama Cloud sessions. */
  OLLAMA_CLOUD_COMPACTION_MODEL: z.string().default("glm-5.3:cloud"),

  // #12: the opencode / LM Studio agent was RETIRED. Its OPENCODE_* keys are
  // gone from this schema. Zod's default object behaviour strips unknown env
  // vars, so a deployment whose .env still sets them boots unchanged — the
  // leftovers are inert, not an error. See core/retired-agents.ts.


  TURN_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(604800).default(900),
  /** Maximum graceful restart drain. On expiry the existing force-restart path
   * takes over so a leaked turn counter can never wedge redeploy indefinitely. */
  RESTART_DRAIN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(3_600_000)
    .default(300_000),
  /** Retire warm, idle ACP process trees after this many seconds while keeping
   * the durable session binding resumable. 0 disables. Default 2 hours. */
  RUNTIME_IDLE_TTL_SECONDS: z.coerce.number().int().min(0).max(604800).default(7200),
  /**
   * How long the agent-quota poller keeps serving an agent's last-known-good
   * snapshot when an upstream read returns "unavailable", instead of flapping
   * the status card to ⚠️. A sustained outage past this still surfaces. 0
   * disables retention (always show the latest read). Default 30 min.
   */
  QUOTA_STALE_RETENTION_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .default(1_800_000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * Google AI Studio key for control-plane Discord voice-note STT (not agy/SSO).
   * Empty = leave audio attachments untranscribed (current behavior).
   */
  SEAM_GEMINI_API_KEY: z.string().default(""),
  /** Speech transport only. Live Help continues to use the Studio API key. */
  SEAM_GEMINI_SPEECH_PROVIDER: z.enum(["developer", "vertex"]).default("developer"),
  /** Vertex/Agent Platform project used when the speech provider is vertex. */
  SEAM_GEMINI_VERTEX_PROJECT_ID: z.string().default(""),
  /** Gemini speech models currently use the Vertex global endpoint. */
  SEAM_GEMINI_VERTEX_LOCATION: z.string().min(1).default("global"),
  /** Gemini model id used for inbound voice-note transcription. */
  SEAM_GEMINI_STT_MODEL: z.string().min(1).default("gemini-3.5-transcribe"),
  /** Vertex model id for unary/voice-note transcription. */
  SEAM_GEMINI_VERTEX_STT_MODEL: z.string().min(1).default("gemini-3.5-transcribe-preview"),
  /** Vertex model id for the Thread Voice bidirectional session. */
  SEAM_GEMINI_VERTEX_LIVE_STT_MODEL: z.string().min(1).default("gemini-3.5-transcribe-live-preview"),
  /**
   * Comma-separated terms that bias Gemini 3.5 Transcribe toward project,
   * product, and proper names. Google supports up to 1,000 entries and
   * recommends keeping the useful set near 100, so normalize and cap here.
   */
  SEAM_GEMINI_STT_CUSTOM_VOCABULARY: z
    .string()
    .default("Seam,seam-acp,Discord,Gemini,Codex,Claude,Grok,Ollama")
    .transform((v) => {
      const seen = new Set<string>();
      const terms: string[] = [];
      for (const raw of v.split(",")) {
        const term = raw.trim();
        const key = term.toLocaleLowerCase();
        if (!term || seen.has(key)) continue;
        seen.add(key);
        terms.push(term);
        if (terms.length === 100) break;
      }
      return terms;
    }),
  /** Gemini TTS model id used for outbound spoken replies. */
  SEAM_GEMINI_TTS_MODEL: z.string().min(1).default("gemini-3.1-flash-tts-preview"),
  /** Prebuilt Gemini TTS voice name (Kore, Puck, …). */
  SEAM_GEMINI_TTS_VOICE: z.string().min(1).default("Kore"),
  /** #92: how long POST /ingest waits for submit_result before 202 + poll.
   *  Default 5 min. Ceiling 30 min. Public Cloudflare POSTs still die ~100s —
   *  microsites should poll GET /ingest/jobs/:id (or POST ?wait=0). */
  SEAM_INGEST_WAIT_MS: z.coerce.number().int().min(0).max(1_800_000).default(300_000),
  SEAM_INGEST_BODY_MAX: z.coerce.number().int().min(1024).max(1_048_576).default(65_536),
  SEAM_INGEST_RATE_PER_MIN: z.coerce.number().int().min(1).max(1000).default(60),
  /**
   * Public origin for minted `POST /ingest` URLs (`create_ingest`). Pages hubs
   * are told to use this host, not the bridge hostname. Empty/unset ⇒ derive
   * from `SEAM_BRIDGE_PUBLIC_URL` / tunnel / loopback (local/dev). Trailing
   * slash is stripped. Example: `https://ingest.runbooksynthesis.com`.
   */
  SEAM_INGEST_PUBLIC_URL: z
    .string()
    .default("")
    .transform((v) => {
      const s = v.trim().replace(/\/+$/, "");
      return s.length > 0 ? s : undefined;
    }),
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
   * Optional Discord thread/channel id for a single editable server-status
   * card (uptime, turns, paired bridges). Edited in place on a 30s tick and
   * on bridge connect/disconnect — no new messages. When unset, no card.
   */
  DISCORD_STATUS_THREAD_ID: z
    .string()
    .regex(/^\d+$/, "DISCORD_STATUS_THREAD_ID must be a numeric Discord channel id")
    .optional(),

  /**
   * Optional Discord thread/channel id for the pinned per-agent quota card.
   * The card is edited after quota refreshes and silently self-bumps every
   * 20 hours so its thread stays visible in Discord navigation.
   */
  DISCORD_AGENT_QUOTA_THREAD_ID: z
    .string()
    .regex(/^\d+$/, "DISCORD_AGENT_QUOTA_THREAD_ID must be a numeric Discord channel id")
    .optional(),

  /**
   * Optional Discord thread/channel id for the pinned model-value rankings
   * card. The card reads only the latest durable #130 snapshot, edits in place
   * after successful refreshes, and silently self-bumps its thread.
   */
  DISCORD_RANKINGS_THREAD_ID: z
    .string()
    .regex(/^\d+$/, "DISCORD_RANKINGS_THREAD_ID must be a numeric Discord channel id")
    .optional(),

  /**
   * Optional path to a JSON file that pre-configures Discord channels and
   * threads with a default agent / model / cwd / effort / preamble rider.
   * Shape: `{ "channels": { "<channelId>": {...} }, "threads": { "<threadId>":
   * {...} } }`. Channel values apply to every thread under that channel;
   * thread values override the channel's per-field (rider stacks instead of
   * overriding). A channel entry's `locked: true` disables all /seam slash
   * commands (except cancel and steer) for that channel and its threads.
   * `cancel scope:all` (bot-wide kill) is NOT exempt. Values
   * are re-resolved from this file on every runtime start — the file is the
   * source of truth regardless of what's stored in the session DB. When
   * unset, the feature is inactive. See PresetsFileSchema below for the
   * exact shape.
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
   * Permanent public WebSocket URL for remote-bridge bootstrap
   * (`/seam bridge add`). Survives reboot — unlike data/tunnel-url.txt,
   * which is overwritten by the Cloudflare *quick* tunnel every start.
   * Example: `wss://seamacp.runbooksynthesis.com/bridge`. Empty/unset ⇒
   * fall back to tunnel-url.txt, then `ws://127.0.0.1:$HEALTH_PORT/bridge`.
   */
  SEAM_BRIDGE_PUBLIC_URL: z
    .string()
    .default("")
    .transform((v) => {
      const s = v.trim();
      return s.length > 0 ? s : undefined;
    }),

  /**
   * How dispatched-turn output (handoffs, forwards, wakes, watches, chain hops,
   * compaction) and report-back / callback delivery render in the target thread.
   * - "messages": (default) traditional plain assistant messages — the worker's
   *               output is streamed live into, and finalized as, ordinary
   *               `sendMessage` chunks, exactly like talking to the bot directly.
   *               Overflow past Discord's limit spills to a file attachment.
   * - "card":     the legacy blue "📨 Dispatch" embed cards / streamed embed
   *               panel. Opt-in escape hatch; behaviour unchanged from before.
   * Does NOT affect /seam slash-command embeds, session-manager cards, config
   * confirm cards, or the scheduled path's own per-schedule outputType.
   */
  SEAM_DISPATCH_OUTPUT_STYLE: z.enum(["messages", "card"]).default("messages"),

  /**
   * Give dispatched turns (handoffs, forwards, wakes, watches, chain hops,
   * compaction, report-backs) the SAME traditional live STATUS PANEL that normal
   * user turns get — thinking output, context-window health, elapsed time, model,
   * tool calls — with the dispatch TYPE in the panel title (e.g. "📨 Handoff",
   * "⏰ Wake"). Default ON.
   *
   * Orthogonal to SEAM_DISPATCH_OUTPUT_STYLE: this flag controls the *status
   * panel* (an extra message posted above the answer), while OUTPUT_STYLE still
   * controls how the answer itself renders (plain messages vs card). When the
   * panel is on it supersedes the slim `▶` start indicator (the panel title
   * carries the dispatch type); set to "false" to restore the `▶` indicator and
   * post no panel.
   */
  SEAM_DISPATCH_STATUS_PANEL: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  /**
   * Auto-resume interrupted turns after a restart (#76): inject "continue"
   * into the same ACP session instead of replaying the original prompt.
   * Default OFF — unconfigured == today's behavior. Markers are still
   * written and reconciled with the flag off (interruption inventory + a
   * truthful ledger); only the auto-resume fire is gated.
   */
  SEAM_TURN_RESUME_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Max age of an interrupted turn (seconds) that auto-resume will re-fire.
   * Mirrors scheduled-prompt `catchupSeconds`. Past this window the turn is
   * marked `abandoned` and a notice is posted rather than resumed. Manual
   * resume from `/seam workflows` still works. Default 7200 (2h).
   */
  SEAM_TURN_RESUME_MAX_AGE_SECONDS: z.coerce.number().int().min(0).max(604800).default(7200),
  /**
   * HTTPS URL of the curated GIF manifest (`{ version, gifs: [url, ...] }`)
   * used by the simple status-card thumbnail mod. Fetched at boot + ~10 min.
   */
  SIMPLE_CARD_GIF_MANIFEST_URL: z
    .string()
    .url()
    .default("https://pub-d6ab0677dbbb4895a9db45bc6ba2ad08.r2.dev/manifest.json"),
});

const PresetFieldSchema = <T extends z.ZodType>(value: T) => z.object({ value });

const numericId = z.string().regex(/^\d+$/, "preset key must be a numeric Discord id");

// Shared value fields for both channel- and thread-level presets. These are
// always applied at runtime (no separate per-field lock) — see
// resolveChannelPreset. Only the channel level additionally carries `locked`,
// which disables /seam commands entirely for that channel and every thread
// under it (see orchestrator.ts handleSlashInteraction). Thread-only flags
// (`detached`, #80) MUST NOT live here — a channel-wide mute is a different
// feature, and a mistaken channel-level key must not silently mute a school
// channel.
const PresetValuesSchema = z.object({
  agent: PresetFieldSchema(z.string().min(1)).optional(),
  model: PresetFieldSchema(z.string().min(1)).optional(),
  role: PresetFieldSchema(z.string().min(1).max(64)).optional(),
  cwd: PresetFieldSchema(z.string().min(1)).optional(),
  // Reasoning effort, e.g. "low"/"medium"/"high"/"xhigh"/"max". Silently
  // ignored at apply time for agents whose profile doesn't support effort
  // (AgentProfile.effort is "none"/unset, or doesn't offer this level).
  effort: PresetFieldSchema(z.string().min(1)).optional(),
  // Extra harness-preamble bullet injected into every turn (see
  // withHarnessPreamble). Channel and thread riders both apply, stacked.
  rider: PresetFieldSchema(z.string().min(1)).optional(),
  // Per-turn status-card layout. Channel value is inherited live at render
  // time; a thread preset or session `/seam config card` still wins.
  statusCardStyle: PresetFieldSchema(z.enum(["full", "simple"])).optional(),
  // Random GIF thumbnail on the simple status card. Channel value is inherited
  // live; a thread preset or session `/seam config gif` still wins.
  simpleCardGif: PresetFieldSchema(z.boolean()).optional(),
  // Either channel or thread true means the namer leaves the thread untouched.
  disableThreadPrefix: PresetFieldSchema(z.boolean()).optional(),
});

const ChannelPresetSchema = PresetValuesSchema.extend({
  locked: z.boolean().optional().default(false),
  // Thread-only (#80). Rejected so a mistaken channel-level `detached` cannot
  // silently mute every thread under a school channel.
  detached: z
    .undefined({
      invalid_type_error:
        "detached is a thread-only flag and cannot be set on a channel",
    })
    .optional(),
  // Thread-only (D10 / #86). Rejected so a channel-wide location cannot
  // silently pin every sibling thread to a remote host.
  location: z
    .undefined({
      invalid_type_error:
        "location is a thread-only binding and cannot be set on a channel",
    })
    .optional(),
  // Thread-only. Rejected so a channel-wide `tts` cannot blast spoken
  // replies into every school thread under a parent.
  tts: z
    .undefined({
      invalid_type_error: "tts is a thread-only flag and cannot be set on a channel",
    })
    .optional(),
  ttsVoice: z
    .undefined({
      invalid_type_error: "ttsVoice is a thread-only setting and cannot be set on a channel",
    })
    .optional(),
  ttsPace: z
    .undefined({
      invalid_type_error: "ttsPace is a thread-only setting and cannot be set on a channel",
    })
    .optional(),
  ttsStyle: z
    .undefined({
      invalid_type_error: "ttsStyle is a thread-only setting and cannot be set on a channel",
    })
    .optional(),
  // Thread-only (#37). Rejected so a channel-wide `fastMode` cannot silently
  // bill every sibling thread against paid usage credits — Fast is a per-thread
  // cost decision that must be opted into where it is paid for.
  fastMode: z
    .undefined({
      invalid_type_error:
        "fastMode is a thread-only setting and cannot be set on a channel",
    })
    .optional(),
});

// Raw boolean on the THREAD entry — NOT wrapped `{value:true}` (that wrapper
// is only for agent/model/cwd/effort/rider). Absent / default false = attached.
// `location` is a raw string (not `{value}`): omit / undefined ⇒ `local` (D10 / #86).
const ThreadPresetSchema = PresetValuesSchema.extend({
  detached: z.boolean().optional().default(false),
  location: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "location must be a slug")
    .optional(),
  tts: z.boolean().optional().default(false),
  ttsVoice: z.string().min(1).max(64).optional(),
  ttsPace: z.enum(["slow", "natural", "fast", "faster"]).optional(),
  ttsStyle: z.enum(["neutral", "warm", "clear"]).optional(),
  // Claude Fast mode (#37): raw boolean, default false — exactly the shape of
  // `detached`/`tts`. The default only materializes in the in-memory map: the
  // Tier-C writer builds its candidate from the RAW file JSON, so an omitted
  // `fastMode` is never serialized back as an explicit `false`.
  // A session-start dimension, so changing it forces a fresh ACP session.
  fastMode: z.boolean().optional().default(false),
});

/** Per-host bridge config (D11 / #86). Token is stored as SHA-256 hex only. */
const bridgeIdKey = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "bridge id must be a slug");

export const BridgeHostSchema = z.object({
  emoji: z.string().min(1).max(16).optional(),
  shortName: z.string().min(1).max(32).optional(),
  workspaceRoot: z.string().min(1).optional(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/, "tokenHash must be sha256 hex"),
  createdUtc: z.string().optional(),
  transport: z.enum(["server", "client"]).optional(),
  url: z.string().min(1).optional(),
});

export type BridgeHostConfig = z.infer<typeof BridgeHostSchema> & { id: string };

// Exported (#58 P3 / D7): the Tier-C mutation path builds a candidate presets
// object and MUST round-trip it through this exact schema before writing the
// file — an invalid channel-presets.json throws in loadConfig() and would fail
// the next boot, so a bad tool call must be rejected, never persisted.
export const PresetsFileSchema = z.object({
  channels: z.record(numericId, ChannelPresetSchema).optional().default({}),
  threads: z.record(numericId, ThreadPresetSchema).optional().default({}),
  /** D11 host config + D8 pairing hashes. Per-thread @location lives on `threads`. */
  bridges: z.record(bridgeIdKey, BridgeHostSchema).optional().default({}),
});

export type ChannelPresetField<T> = { value: T };
export type PresetValues = {
  agent?: ChannelPresetField<string>;
  model?: ChannelPresetField<string>;
  role?: ChannelPresetField<string>;
  cwd?: ChannelPresetField<string>;
  effort?: ChannelPresetField<string>;
  rider?: ChannelPresetField<string>;
  statusCardStyle?: ChannelPresetField<"full" | "simple">;
  simpleCardGif?: ChannelPresetField<boolean>;
  disableThreadPrefix?: ChannelPresetField<boolean>;
};
export type ChannelPreset = PresetValues & { locked: boolean };
export type ThreadPreset = PresetValues & {
  detached?: boolean;
  location?: string;
  /** Claude Fast mode (#37). Thread-only; absent/false = off. */
  fastMode?: boolean;
  tts?: boolean;
  ttsVoice?: string;
  ttsPace?: "slow" | "natural" | "fast" | "faster";
  ttsStyle?: "neutral" | "warm" | "clear";
};

export type Config = z.infer<typeof Schema> & {
  channelPresets: Map<string, ChannelPreset>;
  threadPresets: Map<string, ThreadPreset>;
  bridgePresets: Map<string, BridgeHostConfig>;
};

/**
 * Friendly participant-tier refusal (#74). Ephemeral on the slash surface;
 * returned as the MCP tool error so the agent can relay the same copy. This is
 * a refusal, not a lock and not a Discord permission failure.
 */
export const PARTICIPANT_CONFIG_REFUSAL =
  "🔒 That's an admin setting, so I can't change it from here — ask your seam-acp admin and they can set it up for you. You can keep chatting in this thread normally.";

/**
 * THE participant check (#74). Admin > participant > operator: an id in both
 * sets is NOT restricted. Unset participant (or admin) sets are treated as
 * empty — `undefined` is opt-out, never "nobody".
 */
export function isRestrictedParticipant(
  userId: string,
  participantIds: ReadonlySet<string> | undefined,
  adminIds: ReadonlySet<string> | undefined
): boolean {
  return Boolean(participantIds?.has(userId) && !adminIds?.has(userId));
}

/**
 * Ids allowed to click config pickers / (when the #71 admin set is unset) the
 * config-mutation Apply button: DISCORD_ALLOWED_USER_IDS minus restricted
 * participants. When the participant set is unset this returns the same
 * `DISCORD_ALLOWED_USER_IDS` reference (byte-identical to today).
 */
export function mayConfigureUserIds(
  config: Pick<
    Config,
    "DISCORD_ALLOWED_USER_IDS" | "SEAM_PARTICIPANT_USER_IDS" | "SEAM_CONFIG_ADMIN_USER_IDS"
  >
): ReadonlySet<string> {
  const allowed = config.DISCORD_ALLOWED_USER_IDS;
  const participants = config.SEAM_PARTICIPANT_USER_IDS;
  if (!participants) return allowed;
  const out = new Set<string>();
  for (const id of allowed) {
    if (isRestrictedParticipant(id, participants, config.SEAM_CONFIG_ADMIN_USER_IDS)) continue;
    out.add(id);
  }
  return out;
}

/** Ids listed in BOTH admin and participant sets — admin wins; boot must warn. */
export function adminParticipantOverlapIds(
  config: Pick<Config, "SEAM_CONFIG_ADMIN_USER_IDS" | "SEAM_PARTICIPANT_USER_IDS">
): string[] {
  const admin = config.SEAM_CONFIG_ADMIN_USER_IDS;
  const participants = config.SEAM_PARTICIPANT_USER_IDS;
  if (!admin || !participants) return [];
  return [...participants].filter((id) => admin.has(id)).sort();
}

/**
 * Merge the channel-level and thread-level presets for a given (parentId,
 * threadId) pair — thread values win per-field, channel values fill the
 * rest. `rider` is the one exception: both apply, stacked (channel rider
 * first, then thread rider), since a channel-wide rule ("only your own
 * work") and a thread-specific rule ("this is the reading-log thread")
 * are meant to compose rather than override each other.
 */
export function resolveChannelPreset(
  config: Pick<Config, "channelPresets" | "threadPresets">,
  parentId: string | undefined,
  threadId: string | undefined
): PresetValues & { riders: string[] } {
  const chan = (parentId && config.channelPresets.get(parentId)) || undefined;
  const thread = (threadId && config.threadPresets.get(threadId)) || undefined;
  const riders = [chan?.rider?.value, thread?.rider?.value].filter(
    (v): v is string => !!v
  );
  return {
    agent: thread?.agent ?? chan?.agent,
    model: thread?.model ?? chan?.model,
    role: thread?.role ?? chan?.role,
    cwd: thread?.cwd ?? chan?.cwd,
    effort: thread?.effort ?? chan?.effort,
    riders,
    disableThreadPrefix:
      thread?.disableThreadPrefix?.value === true || chan?.disableThreadPrefix?.value === true
        ? { value: true }
        : undefined,
  };
}

/** Channel and thread opt-outs compose with OR semantics; neither can override
 * the other back to enabled. Session-local opt-out is resolved by the router. */
export function isThreadPrefixDisabled(
  config: Pick<Config, "channelPresets" | "threadPresets">,
  parentId: string | undefined,
  threadId: string | undefined
): boolean {
  return Boolean(
    (parentId && config.channelPresets.get(parentId)?.disableThreadPrefix?.value === true) ||
    (threadId && config.threadPresets.get(threadId)?.disableThreadPrefix?.value === true)
  );
}

/** Is this channel (by parent-channel id) locked — i.e. should /seam slash
 *  commands be refused for it and every thread under it? */
export function isChannelLocked(
  config: Pick<Config, "channelPresets">,
  parentId: string | undefined
): boolean {
  if (!parentId) return false;
  return config.channelPresets.get(parentId)?.locked ?? false;
}

/** Is this thread detached (#80) — allowlisted chat, no bot replies, no
 *  session bind? Missing threadId / missing entry / absent flag all mean
 *  attached (false). Channel-wide detach is not a thing; this only reads
 *  `threads.<id>.detached`. */
export function isThreadDetached(
  config: Pick<Config, "threadPresets">,
  threadId: string | undefined
): boolean {
  if (!threadId) return false;
  return config.threadPresets.get(threadId)?.detached ?? false;
}

/** Outbound TTS for this thread. Default off. Channel-wide TTS is not a thing. */
export function isThreadTtsEnabled(
  config: Pick<Config, "threadPresets">,
  threadId: string | undefined
): boolean {
  if (!threadId) return false;
  return config.threadPresets.get(threadId)?.tts === true;
}

/** Per-thread Gemini TTS voice. Unset ⇒ caller should use the env default. */
export function resolveThreadTtsVoice(
  config: Pick<Config, "threadPresets">,
  threadId: string | undefined
): string | undefined {
  if (!threadId) return undefined;
  const v = config.threadPresets.get(threadId)?.ttsVoice?.trim();
  return v || undefined;
}

export function resolveThreadTtsPace(
  config: Pick<Config, "threadPresets">,
  threadId: string | undefined
): "slow" | "natural" | "fast" | "faster" {
  if (!threadId) return "natural";
  const v = config.threadPresets.get(threadId)?.ttsPace;
  return v === "slow" || v === "fast" || v === "faster" || v === "natural" ? v : "natural";
}

export function resolveThreadTtsStyle(
  config: Pick<Config, "threadPresets">,
  threadId: string | undefined
): "neutral" | "warm" | "clear" {
  if (!threadId) return "neutral";
  const v = config.threadPresets.get(threadId)?.ttsStyle;
  return v === "warm" || v === "clear" || v === "neutral" ? v : "neutral";
}

/** Per-thread host binding (D10 / #86). Omit / undefined / "" ⇒ `"local"`. */
export function resolveThreadLocation(
  config: Pick<Config, "threadPresets"> | { threadPresets?: Map<string, ThreadPreset> | Record<string, ThreadPreset> },
  threadId: string | undefined
): string {
  if (!threadId) return "local";
  const presets = config.threadPresets;
  if (!presets) return "local";
  const entry =
    typeof (presets as Map<string, ThreadPreset>).get === "function"
      ? (presets as Map<string, ThreadPreset>).get(threadId)
      : (presets as Record<string, ThreadPreset>)[threadId];
  const loc = entry?.location;
  return loc && loc.trim().length > 0 ? loc.trim() : "local";
}

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

  // #12: DEFAULT_AGENT naming a RETIRED agent is a configuration error, refused
  // here rather than at the first turn. This is the bot-wide default, so every
  // thread created under it would be stamped with an agent that can never spawn
  // — `ensureSessionRecord` writes `defaultAgentId` into the row, and the
  // failure would only surface later, per-thread, as a turn error. Fail at boot
  // instead, and never silently substitute another agent: which agent replaces
  // a retired default is the operator's decision, not ours.
  const retiredDefault = retiredAgentConfigMessage("DEFAULT_AGENT", cfg.DEFAULT_AGENT);
  if (retiredDefault) {
    throw new Error(
      `Invalid configuration: ${retiredDefault}\n` +
        `Supported agents include copilot, claude, codex, grok, agy.`
    );
  }

  const { channelPresets, threadPresets, bridgePresets } = buildChannelPresetMaps(
    cfg.CHANNEL_PRESETS_FILE
  );
  return { ...cfg, channelPresets, threadPresets, bridgePresets };
}

/**
 * Parse + validate `CHANNEL_PRESETS_FILE` into fresh channel/thread preset maps.
 * Throws on read / JSON / schema failure — callers that must not crash (the P0
 * hot-reloader) catch and keep their previous good maps. Used both at boot
 * (loadConfig) and on every hot-reload swap so the two paths validate
 * identically (D7: single zod schema, never hand-rolled parsing).
 */
export function buildChannelPresetMaps(
  file: string | undefined
): {
  channelPresets: Map<string, ChannelPreset>;
  threadPresets: Map<string, ThreadPreset>;
  bridgePresets: Map<string, BridgeHostConfig>;
} {
  const channelPresets = new Map<string, ChannelPreset>();
  const threadPresets = new Map<string, ThreadPreset>();
  const bridgePresets = new Map<string, BridgeHostConfig>();
  if (!file) return { channelPresets, threadPresets, bridgePresets };
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
  for (const [channelId, preset] of Object.entries(result.data.channels)) {
    const normalized: ChannelPreset = { ...preset };
    if (preset.cwd) normalized.cwd = { value: path.resolve(preset.cwd.value) };
    channelPresets.set(channelId, normalized);
  }
  for (const [threadId, preset] of Object.entries(result.data.threads)) {
    const normalized: ThreadPreset = { ...preset };
    if (preset.cwd) normalized.cwd = { value: path.resolve(preset.cwd.value) };
    threadPresets.set(threadId, normalized);
  }
  for (const [id, host] of Object.entries(result.data.bridges)) {
    const normalized: BridgeHostConfig = { ...host, id };
    if (host.workspaceRoot) {
      normalized.workspaceRoot = path.resolve(host.workspaceRoot);
    }
    bridgePresets.set(id, normalized);
  }
  return { channelPresets, threadPresets, bridgePresets };
}

/** Models for xAI Grok Build.  Context windows from docs.x.ai/developers/models.
 *  GROK_MODELS env var overrides this list when set. */
export const GROK_STATIC_MODELS = [
  { modelId: "grok-4.6",                       name: "Grok 4.6",                   contextLimit: 500_000 },
  { modelId: "grok-4.5",                       name: "Grok 4.5",                   contextLimit: 500_000 },
];

/** Models for Z.ai (Zhipu).  ZAI_MODELS env var overrides this list when set. */
export const ZAI_STATIC_MODELS = [
  { modelId: "glm-5.2",           name: "GLM 5.2",             contextLimit: 1_000_000 },
  { modelId: "glm-5",             name: "GLM 5",               contextLimit: 1_000_000 },
  { modelId: "glm-5v-turbo",      name: "GLM 5V Turbo",        contextLimit: 1_000_000 },
  { modelId: "glm-4.7",           name: "GLM 4.7",             contextLimit: 200_000 },
  { modelId: "glm-4.5-air",       name: "GLM 4.5 Air",         contextLimit: 128_000 },
];

/** Models for Ollama Cloud.  OLLAMA_CLOUD_MODELS env var overrides this list when set.
 *  These are the primary cloud-hosted open-weight models available on ollama.com. */
export const OLLAMA_CLOUD_STATIC_MODELS = [
  { modelId: "glm-5.3:cloud",               name: "GLM 5.3",              contextLimit: 1_000_000, visionMode: "tool" as const },
  { modelId: "glm-5.3-flash:cloud",         name: "GLM 5.3 Flash",        contextLimit: 1_000_000, visionMode: "native" as const },
  { modelId: "qwen3-coder:cloud",           name: "Qwen3 Coder",          contextLimit: 256_000 },
  { modelId: "qwen3.6:cloud",               name: "Qwen3.6",              contextLimit: 256_000 },
  { modelId: "deepseek-v4-pro:cloud",       name: "DeepSeek V4 Pro",      contextLimit: 1_000_000 },
  { modelId: "deepseek-v4-flash:cloud",     name: "DeepSeek V4 Flash",    contextLimit: 512_000 },
  { modelId: "kimi-k3:cloud",               name: "Kimi K3",              contextLimit: 1_000_000 },
  { modelId: "minimax-m3:cloud",            name: "MiniMax M3",           contextLimit: 512_000 },
  { modelId: "gemma4:cloud",                name: "Gemma 4",              contextLimit: 128_000 },
];
