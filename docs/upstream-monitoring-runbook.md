# Upstream Monitoring Runbook

> **Purpose**: Systematic process for gathering, analyzing, and reporting on technical changelogs, feature updates, and policy changes across all AI coding tools that seam-acp integrates with.
>
> **Cadence**: Weekly sweep (recommended: Monday), with ad-hoc checks when a major release is announced.
>
> **Last updated**: 2026-09-02 (daily sweep)
>
> **⚠️ AGENT CONSTRAINT — READ-ONLY / REPORTING MODE**: Agents executing this runbook must **never** modify seam-acp source files, run `npm run redeploy`, apply patches, or make any code changes during a monitoring sweep. All code work is tracked via GitHub issues and implemented in **separate, explicitly tasked sessions**. Your job during a sweep is to **find, classify, and file or update GitHub issues** — not to implement fixes.

---

## Table of Contents

1. [Sources to Monitor](#1-sources-to-monitor)
2. [What to Look For](#2-what-to-look-for)
3. [Execution Checklist](#3-execution-checklist)
4. [Analysis Framework](#4-analysis-framework)
5. [Reaction Playbooks](#5-reaction-playbooks-seam-acp-specific)
6. [Report Template](#6-report-template)
7. [Self-Update Process](#7-self-update-process)

---

## Cold start — read these first

If you are an agent with no prior context about this project, read the following
before running any procedure in this runbook:

> **⚠️ STOP — NO CODE CHANGES.** You are in monitoring/reporting mode. Do not
> modify any source file, run `npm run redeploy`, or apply any patch during this
> sweep. All implementation work flows through GitHub issues. See §3 Phase 4 and
> §4 Angle 4 for the exact decision tree.

> **⚠️ ENVIRONMENT: agy inside seam-acp (Discord bot) — NO SUBAGENTS.**
> If you are running as an `agy` agent bridged through seam-acp (i.e. you were
> triggered by a Discord message), each of your turns runs as a one-shot
> `agy -p <prompt>` process. The process **exits when your turn ends**. The
> `invoke_subagent` tool will appear to succeed — subagents will be spawned —
> but they will be orphaned and killed as soon as the turn ends, and their
> responses will never arrive. **Do not use `invoke_subagent` in this
> environment.** Instead, perform all research **inline** within a single turn
> using `read_url_content`, `search_web`, and `run_command` directly. The sweep
> will be slower (sequential instead of parallel) but reliable. See §3 Phase 1
> for the full checklist of URLs to fetch.

1. **[AGENTS.md](../AGENTS.md)** — what seam-acp is, project structure, critical
   rules (never `pm2 restart`, always `npm run redeploy`), output formatting
   constraints (no markdown tables in Discord).
2. **Key source files** — skim these to understand what's deployed:
   - `.env` — all agent config: default models, model pickers, profile bindings
   - `src/agents/profiles/` — one file per agent integration:
     - `agy.ts` — Google Antigravity CLI (in-process ACP bridge, gRPC discovery)
     - `claude.ts` — Anthropic Claude Code (via `claude-agent-acp` wrapper)
     - `copilot.ts` — GitHub Copilot CLI (`copilot --acp`)
   - `src/platforms/discord/` — Discord adapter, orchestrator, slash commands, renderer
   - `src/config.ts` — env var validation, model lists
   - `src/core/` — session store, streaming, routing (shared across agents)
3. **Agent-specific runbooks** (when the sweep touches that agent):
   - Claude: [`model-management-runbook.md`](model-management-runbook.md) —
     the authoritative process for model/effort changes. Has its own cold-start
     section, §0 mental model, and JSONL verification procedures.
   - agy/Copilot: no separate runbook yet — the integration points in §1 below
     are the primary reference.
4. **The integration-points blocks** under each §1 subsection — these list the
   exact env vars, binary paths, config files, session storage locations, and
   profile source files for each agent. They are the map between upstream changes
   and seam-acp code.

---

## 1. Sources to Monitor

### 1.1 Google — Antigravity CLI (agy)

> **Antigravity CLI (`agy`)** is Google's official replacement for the Gemini CLI. It is a Go-native binary (not npm-based). seam-acp has a dedicated `agy` profile ([`agy.ts`](../src/agents/profiles/agy.ts)) that bridges agy into ACP in-process since agy doesn't speak ACP natively. **This is the only actively monitored Google agent integration.**

> **⚠️ Gemini CLI is deprecated.** The npm-based `@google/gemini-cli` is being sunset (June 18, 2026). It is no longer actively monitored in this runbook. The legacy `gemini.ts` profile has **already been removed** from `src/agents/profiles/` (as of the 2026-06-15 sweep); only stale doc references remain (see §5.5 and the README). The `agy` profile below is the live Google integration.

| Source | URL | What It Covers | Feed |
|---|---|---|---|
| Antigravity CLI GitHub | https://github.com/google-antigravity/antigravity-cli | Source, issues, PRs | [Atom](https://github.com/google-antigravity/antigravity-cli/releases.atom) |
| Antigravity CLI Changelog | https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md | Detailed per-version changelog | — |
| Gemini API Changelog | https://ai.google.dev/gemini-api/docs/changelog | Model + API changelog (models power agy) | — |
| Google AI Blog | https://blog.google/technology/ai/ | Major model & platform announcements | [RSS](https://blog.google/rss) |
| Google Developers Blog | https://developers.googleblog.com/ | Developer-facing updates | [Atom](https://developers.googleblog.com/atom.xml) |
| Google DeepMind Blog | https://deepmind.google/discover/blog/ | Research, model releases | — |
| Google AI Pricing | https://ai.google.dev/gemini-api/docs/pricing | Billing, rate limits, quotas | — |
| Google AI Studio | https://aistudio.google.com/ | Manage keys, billing, usage | — |
| Google Cloud Status | https://status.cloud.google.com/ | Service health | — |

**seam-acp integration points**:
- CLI binary: `agy` (env: `AGY_CLI_PATH`, checks `~/.local/bin/agy` first)
- **Not a real ACP server** — agy doesn't speak ACP natively
- Uses in-process `AgentSideConnection` with PassThrough streams to fake an ACP child process
- Spawns real `agy -p <prompt>` subprocess per turn, discovers its local gRPC/Connect language server
- Model catalog fetched from agy's language server (`GetAvailableModels` Connect endpoint)
- Model stored in `~/.gemini/antigravity-cli/settings.json`
- ACP→cascade mapping in `<dataDir>/agy-sessions.json`
- Conversations stored as `.db` files in `~/.gemini/antigravity-cli/conversations/`
- Transcripts in `~/.gemini/antigravity-cli/brain/<cascadeId>/.system_generated/logs/transcript.jsonl`
- Effort is baked into model choice (no separate knob) — picker suppressed
- Profile source: [`agy.ts`](../src/agents/profiles/agy.ts) (1699 lines — largest profile)
- Latest agy as of 2026-09-02 sweep: **1.1.24** (Go binary; conversation format is now `.db` SQLite as of agy 1.0.4 — `agy.ts` handles both `.db`/`.pb`; critical fix in 1.1.1: `agy -p` no longer hangs in subprocess/non-TTY — resolves #29; new `--agent` flag added; request-review mode from 1.1.0 verified non-blocking via #31; 1.1.3: headless soft-deny for permission tools + MCP server hang timeouts + Linux keyring bypass for headless/PM2 hosts; 1.1.4: headless `-p` now honors full `settings.json` policies; 1.1.5: stable user-facing model slugs accepted by `--model` + `--effort` flag + `/effort` command + redesigned `/model` picker; 1.1.6: Custom Agents (Markdown format) + default temp dir read access in headless; 1.1.7: compound-command permission prompts fix, disabled-plugin hook fix, MCP OAuth fix, `/btw` fix, `-p` eligibility-check ordering fix; 1.1.8: `--output-format` flag in `-p` mode (`text`/`json`/`stream-json`), typed NDJSON `stream-json` event stream, `--json-schema` flag, `copyOnSelect` setting; assessed for agy.ts integration in #42; 1.1.9: slash-command and skill expansion in `-p` mode — prompts starting with `/` resolved as skills/commands; `--disable-slash-commands` to opt out — ⚠️ may affect seam-acp if Discord users send `/`-prefixed prompts, assessed in #47; 1.1.10 (2026-08-03): Business/WIF/ADC sign-in for enterprise; non-blocking advisory banner for concurrent sessions; `.git` sandbox now read-only; hook ordering fix; `schedule` tool accepts bare JSON numbers; **fix: `--model`/`--effort` flags were silently ignored in `-p` runs** (seam-acp benefits); forced-continuation deadlock fix; MCP process leak fixes; 1.1.11 (2026-08-07): Vim editing mode; non-interactive print-mode for `/usage`/`/quota`/`/credits`/`/model`/`/effort`/`/skills`; allowlist security fix; 1.1.12 (2026-08-11): `disable-slash-command: true` SKILL.md frontmatter (mitigation for #47); `agy models/agents --output-format json/stream-json`; non-interactive print-mode for `/permissions`/`/hooks`/`/help`/`/changelog`/`/config`; keyring timeout 1s→5s (headless/PM2 fix); `config.json` atomic write; 1.1.13 (2026-08-14): `GEMINI_API_KEY` direct auth support; **fixed trajectory truncation** destroying long conversation history; **fixed unbounded on-disk conversation DB growth** for wake-woken sessions; **fixed transcript corruption** during context compaction; `define_subagent` path-traversal security fix; 1.1.14 (2026-08-18): faster enterprise sign-in; OAuth client ID metadata docs for MCP; scrollable `/context` panel; `inheritCustomizations` switch; outside-workspace access now read-only; 1.1.15 (2026-08-19): **`--input-format stream-json`** in print mode (persistent session driver); `rules:` key in agent frontmatter; plugin `rules.json` support; **fixed non-ASCII stream corruption** (Discord CJK/emoji sessions); tracked in #81; 1.1.16 (2026-08-20): `mcp` subcommands (add/remove/list/enable/disable) for managing `mcp_config.json`; improved `@` file path completion (ripgrep-backed); `/effort` fixed for Gemini 3.6/3.7 Flash on API key auth; `settings.json` write safety fix; `read_resource` binary content fix; WIF hourly sign-out fix; no seam-acp code changes; 1.1.17 (2026-08-20): execution harness consolidated onto single path (more consistent tool/hook/prompt behavior); fixed `/teamwork-preview` and some slash commands disappearing; fixed `Enter` not opening background task in Vim insert mode; fixed Ogg audio/video MIME type (`application/ogg` → correct type); no seam-acp code changes required; 1.1.18 (2026-08-22): added project-name support for `--project` (previously only ID worked); `item.rename`/`item.delete` keybindings for conversation picker (f2/f4 rebindable on keyboards without function keys); improved `@` file path completion with typo-tolerant fallback; improved audio attachment recognition (wav/mp3/m4a/aac/flac/opus); improved keystroke responsiveness on Windows; **fixed `-p` mode exiting exit-0 with empty response when agent state stream dropped mid-run — now exits non-zero** (seam-acp: verify turn-failure path in agy.ts; #42 updated); fixed valueless `--print` flag swallowing next flag; fixed `/btw` expanded card pushing footer off-screen; fixed `/resume` opening in wrong workspace; fixed text styling after file link; fixed stray characters from periodic input-mode re-arming on non-multiplexer terminals; 1.1.19 (2026-08-22): fixed `--remote-control` refusing to start when port taken (now dynamically takes a free OS port); added `AGY_CLI_HIDE_LOGO` env var (suppresses startup ASCII banner art while keeping version/account header); added `AGY_CLI_DISABLE_ESCAPE_SEQUENCE_OPTIMIZATIONS` (bypasses renderer dirty-rectangle diffing); 1.1.20 (2026-08-25): added skill icons/branding support (`metadata.icon` in `SKILL.md`), improved `@` file autocompletion to include empty dirs, automatic workspace-scoped read access in review mode, skip recursive submodule worktree scans in Git repo inspection, fixed print mode (`-p`) treating benign tool execution errors and permission denials as fatal run failures with non-zero exit codes, fixed `settings.json` unparsed config overwrite on startup, fixed `/skills`/`/plugins`/`/agents`/`/hooks` without explicit agent, fixed CJK draft jitter, fixed idle conversation spinner animation CPU wakeup; 1.1.21 (2026-08-26): added `/voice` dictation (`f5`/`/voice`) and `mic-serve` SSH mic forwarding, exposed unrounded session `cost` in status line data model, embedded `ripgrep` binary for uniform code search, auto-approval of MCP tools and page reads in `always-proceed` mode, script runner allow-always granularity pinning script names, automatic conversation titles on creation, improved ADC error reporting for MCP, fixed agent state stream stalling on invalid UTF-8 in tool results/diffs, fixed corrupted non-ASCII/CJK file edits from offset splicing, fixed false file-write failures, fixed configured skill/plugin precedence; 1.1.22 (2026-08-27): added `/model <name>` argument that switches to a model by name, slug or label and saves it as default in one step with ghost text matching, improved `/effort` hint to complete typed text, coalesced bursts of filesystem events into a single rescan for conversations producing many artifacts, fixed selectable reasoning effort for Gemini 3.1 Pro and Gemini 3.5 Flash on Gemini API key auth, fixed interface redrawing continuously when tasks panel or subagent detail panel open with nothing running (settles at ~10% CPU vs ~32%), fixed running subagent's elapsed timer freezing when parent waiting, fixed HTTP 502 Bad Gateway from model endpoint ending run instead of retrying with backoff, fixed `self` subagent launched without recorded config drifting from parent, fixed Windows file deletion sharing violations with backoff retry, fixed headless daemon printing `Open in your browser: http://localhost:<port>` line in startup banner; 1.1.23 (2026-09-01): `/model <name>` autocompletion with `Tab`, subagent trajectory streaming optimization, hook panic catching, proactive OAuth token refresh 5m before expiry, MCP Windows UTF-8 BOM parsing; **1.1.24** (2026-09-02): improved `/mcp` panel navigation, deduplicated `/agents` picker entries, fixed tool init & agent startup in deleted working directories, `FD_CLOEXEC` on preserved pipes in headless mode, tolerant `mcp_config.json` comment/trailing comma parsing, conversation deletion orphaned annotation cleanup, `/btw` side-question goal loop fix; installed and current as of 2026-09-02 sweep)

### 1.2 Anthropic — Claude Code

> **⚠️ Agent readability:** The SPA pages on `docs.anthropic.com`,
> `platform.claude.com`, and `code.claude.com` return unusable HTML via HTTP
> fetch. **Always use the `.md` suffix** (e.g. `overview.md` instead of
> `overview`) — these return clean, agent-readable markdown. The `npmjs.com`
> website returns 403 to non-browser agents; use the registry API instead.
>
> **Discovery indexes** (list every available `.md` page):
> - https://platform.claude.com/docs/llms.txt
> - https://code.claude.com/docs/llms.txt

| Source | URL | What It Covers | Feed | Agent? |
|---|---|---|---|---|
| Claude Code GitHub Releases | https://github.com/anthropics/claude-code/releases | Version changelogs | [Atom](https://github.com/anthropics/claude-code/releases.atom) | ⚠️ use Atom |
| Claude Code GitHub Repo | https://github.com/anthropics/claude-code | Issues, PRs, discussions | — | ✅ |
| Claude Code CHANGELOG.md | https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md | Detailed per-version notes | — | ✅ raw md |
| Claude Code Docs Overview | https://code.claude.com/docs/en/overview.md | Official documentation | — | ✅ .md |
| Claude Code Docs Changelog | https://code.claude.com/docs/en/changelog.md | Official docs changelog | — | ✅ .md |
| Claude Code Model Config | https://code.claude.com/docs/en/model-config.md | Model configuration reference | — | ✅ .md |
| npm: `@anthropic-ai/claude-code` | https://www.npmjs.com/package/@anthropic-ai/claude-code | Auth CLI versions (npm install deprecated — use `curl` or brew) | [API](https://registry.npmjs.org/@anthropic-ai/claude-code) | ❌ 403; use API |
| claude-agent-acp GitHub | https://github.com/agentclientprotocol/claude-agent-acp | ACP adapter source | [Atom](https://github.com/agentclientprotocol/claude-agent-acp/releases.atom) | ✅ |
| claude-agent-acp CHANGELOG | https://github.com/agentclientprotocol/claude-agent-acp/blob/main/CHANGELOG.md | Auto-generated by release-please | — | ✅ raw md |
| npm: `@agentclientprotocol/claude-agent-acp` | https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp | ACP adapter versions | [API](https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp) | ❌ 403; use API |
| Anthropic API Models | https://platform.claude.com/docs/en/about-claude/models/overview.md | Model specs, deprecations | — | ✅ .md |
| Anthropic News/Blog | https://www.anthropic.com/news | Model releases, company news | — | ⚠️ partial |
| Anthropic Engineering Blog | https://www.anthropic.com/engineering | Technical deep dives | — | ⚠️ partial |
| Anthropic Release Notes | https://platform.claude.com/docs/en/release-notes/system-prompts.md | System prompts, release notes | — | ✅ .md |
| Anthropic Status Page | https://status.anthropic.com/ | Incidents, maintenance | Email/SMS subscribe | ✅ |
| Anthropic Pricing | https://platform.claude.com/docs/en/about-claude/pricing.md | Detailed per-model pricing | — | ✅ .md |

**seam-acp integration points**:
- CLI binary: `claude-agent-acp` (env: `CLAUDE_CLI_PATH`)
- Config dir: `CLAUDE_CONFIG_DIR=<dir>` (default: `~/.claude`)
- Default model: `CLAUDE_DEFAULT_MODEL` (currently `default` → latest Opus @ 1M on Max)
- Model picker: `CLAUDE_MODELS` env var — **curated, JSONL-verified entries only**; now **bare full IDs** (e.g. `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`) plus the `default` alias. **No `[1m]` suffix** — it was retired at claude-agent-acp 0.54.1. All picker rows were live-verified on 2026-09-02 through Seam's `ANTHROPIC_MODEL` forwarding; `default` resolves to `claude-opus-5` at 1M. **`claude-opus-5`** (GA 2026-07-24, **$5/$25 MTok** — confirmed correct by Anthropic models page 2026-07-31 (Claude Code 2.1.219 release notes showing $10/$50 were incorrect), 1M ctx, adaptive thinking, effort defaults to `high`, knowledge cutoff May 2026) is now the recommended Opus model. New models `claude-fable-5` (GA June 2026, $10/$50 MTok, 1M ctx, adaptive thinking always-on) tracked in #30. **`claude-opus-4-1` retired August 5, 2026** — confirmed absent from deployed config as of 2026-08-02 sweep; #38 and #11 closed. **`claude-sonnet-5`** ($2/$10 MTok — **pricing now permanent** as of 2026-08-15; previously announced increase to $3/$15 on Sept 1, 2026 cancelled; 1M ctx, adaptive thinking) tracked in #32.
- Fast mode: `configId: "fast_mode"` via `setSessionConfigOption` is available since 0.54.0 but not yet surfaced in seam-acp (tracked in #37).
- Model selection RPC: `setSessionConfigOption({ sessionId, configId: "model", value })` (ACP schema v1.16.0 dropped the dedicated `models` field; selection is now a `"model"` `SessionConfigSelect`). The old `unstable_setSessionModel` RPC is gone.
- Context window: declared per-model in the `CLAUDE_CONTEXT_WINDOWS` table in `claude.ts`, resolved by `getClaudeContextWindow(modelId)` and stamped onto every picker entry's `contextLimit` (orchestrator `staticModels[].contextLimit → modelContextFloor` seed). The agent also reports the true window at runtime via ACP `UsageUpdate.size`. The `[1m]` suffix is **no longer load-bearing**.
- Effort injection: `_meta.claudeCode.options.effort`; verify the applied value in JSONL's top-level `effort` field
- Valid effort levels: `low`, `medium`, `high`, `xhigh`, `max` (bounded by bundled SDK's `EffortLevel` type; `ultra` NOT available)
- Adaptive thinking (Opus 4.6+): `_meta.claudeCode.options.thinking = { type: "adaptive", display: "summarized" | "omitted" }`
- Identity: reads `~/.claude/.credentials.json` or `~/.claude/credentials.json`
- Usage: `https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20` header
- Session storage: JSONL files at `~/.claude/projects/<slug>/<sessionId>.jsonl`
- **Account caveat**: a raw wrapper session can reject un-advertised full IDs. Seam forwards canonical IDs through `ANTHROPIC_MODEL`; preserve this path and re-run the JSONL matrix after upgrades.
- **No patch script.** The former `scripts/patch-claude-agent-acp.mjs` (`npm run patch-acp`) was **retired and deleted** at 0.54.1 — the resolver now exact-matches advertised full IDs before fuzzy-matching, so the bypass is unnecessary; its anchor no longer exists.
- Profile source: [`claude.ts`](../packages/adapters/src/profiles/claude.ts)
- Update process: [`model-management-runbook.md`](model-management-runbook.md) (authoritative)

> **✅ PATCH RETIRED — we run unpatched.** As of 2026-09-02 we
> run `claude-agent-acp` **0.73.0** with **ACP SDK 1.4.0** (workspace manifests pin
> `@agentclientprotocol/sdk` `^1.4.0`). The former local resolver patch
> (`scripts/patch-claude-agent-acp.mjs` / `npm run patch-acp`) has been **deleted**.
> Any older instruction to "run `patch-acp`" or "re-apply the patch after a global
> update" is now WRONG. Why it's gone: ACP schema v1.16.0 removed the dedicated
> `models` field — model selection is now a `"model"` `SessionConfigSelect` set via
> `setSessionConfigOption({ configId: "model", value })`; the old
> `unstable_setSessionModel` RPC (the patch's anchor) no longer exists. In 0.54.1
> `setSessionConfigOption` **exact-matches the requested value against the agent's
> advertised model list BEFORE calling `resolveModelPreference`**, so an advertised
> full canonical ID resolves to itself and the fuzzy resolver is only a fallback
> for aliases — the exact behavior the patch used to force, now upstream (on top of
> v0.42.0's "prevent cross-family matching"). The `[1m]` suffix is likewise retired
> (bare full IDs now; window comes from `CLAUDE_CONTEXT_WINDOWS` in `claude.ts`).
>
> **Account caveat (covered):** a raw wrapper session can still reject an
> un-advertised full ID. Seam forwards canonical IDs via `ANTHROPIC_MODEL`, and
> the complete picker matrix passed JSONL + raw `/context` verification on
> 2026-09-02. Keep that forwarding and re-run the probe after every upgrade.
>
> Note: old `AcpClient`/`ClientSideConnection` were deprecated since SDK 0.27.0 and
> may be removed in a future major (see MIGRATION_0.26_0.27.md) — track on future
> sweeps.

### 1.3 GitHub Copilot

#### Copilot CLI

| Source | URL | What It Covers | Feed |
|---|---|---|---|
| Copilot CLI GitHub Repo | https://github.com/github/copilot-cli | Source + releases | [Atom](https://github.com/github/copilot-cli/releases.atom) |
| Copilot CLI CHANGELOG | https://github.com/github/copilot-cli/blob/main/CHANGELOG.md | Chronological changes | — |
| npm: `@github/copilot` | https://www.npmjs.com/package/@github/copilot | Current official package | [API](https://registry.npmjs.org/@github/copilot) |
| In-CLI changelog | Run `/changelog` inside the CLI | Built-in command | — |
| GitHub Copilot Docs | https://docs.github.com/en/copilot | Official documentation | [LLM API](https://docs.github.com/api/article/body?pathname=/en/copilot) |
| Copilot CLI Docs | https://docs.github.com/en/copilot/how-tos/use-copilot-for-common-tasks/use-copilot-in-the-cli | CLI-specific docs | [LLM API](https://docs.github.com/api/article/body?pathname=/en/copilot/how-tos/use-copilot-for-common-tasks/use-copilot-in-the-cli) |
| GitHub Blog | https://github.blog/ | Major announcements | [RSS](https://github.blog/feed/) |
| GitHub Changelog | https://github.blog/changelog/ | Feature updates, changes | [RSS](https://github.blog/changelog/feed/) |

> Old package `@githubnext/github-copilot-cli` is **deprecated**.

**seam-acp integration points**:
- CLI binary: `copilot --acp` (env: `COPILOT_CLI_PATH`)
- Multi-account: `COPILOT_PROFILES` env var — each profile gets OAuth token injected via `COPILOT_GITHUB_TOKEN` env var (read from `<configDir>/config.json`). No `--config-dir` CLI flag — uses env var workaround.
- Default model: `DEFAULT_MODEL` env var (e.g., `gpt-5.4`)
- Model picker: `COPILOT_MODELS` env var
- Effort: via ACP `setSessionConfigOption` with `configId: "reasoning_effort"` (levels: `low`, `medium`, `high`)
- MCP injection: Copilot ignores `mcpServers` on ACP `session/new` — only loads from `~/.copilot/mcp-config.json` or `--additional-mcp-config`. seam-acp translates its `McpServer[]` to Copilot's JSON shape and injects at spawn.
- Identity: reads `<configDir>/config.json` → `lastLoggedInUser.login`
- Quota: `https://api.github.com/copilot_internal/user`
- Session storage: SQLite at `<configDir>/session-store.db`
- Profile source: [`copilot.ts`](../src/agents/profiles/copilot.ts) (450 lines)

#### Copilot in VS Code

| Source | URL | What It Covers | Feed |
|---|---|---|---|
| VS Code Release Notes | https://code.visualstudio.com/updates | Monthly release notes (Copilot sections) | — |
| Copilot Extension | https://marketplace.visualstudio.com/items?itemName=GitHub.copilot | Extension changelog | — |
| Copilot Chat Extension | https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat | Chat changelog | — |
| Copilot Chat Extension Repo | https://github.com/microsoft/vscode-copilot-chat | Extension source | [Atom](https://github.com/microsoft/vscode-copilot-chat/releases.atom) |
| VS Code Blog | https://code.visualstudio.com/blogs | Feature deep-dives | — |
| Copilot Feature Changelog | https://github.blog/changelog/ | Filter for "Copilot" entries across all Copilot features | [RSS](https://github.blog/changelog/feed/) |

> **Note**: VS Code Copilot changes don't directly affect seam-acp code, but they reveal feature direction, new models, and API capabilities that may later appear in the CLI.

#### Copilot Coding Agent (Cloud)

| Source | URL | What It Covers | Feed |
|---|---|---|---|
| Coding Agent Docs | https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent | Official docs (path reorganized) | [LLM API](https://docs.github.com/api/article/body?pathname=/en/copilot/concepts/agents/cloud-agent/about-cloud-agent) |
| GitHub Blog | https://github.blog/ | Announcements | [RSS](https://github.blog/feed/) |
| GitHub Changelog | https://github.blog/changelog/ | Feature rollouts | [RSS](https://github.blog/changelog/feed/) |
| GitHub Next | https://githubnext.com/ | Previews, experiments | — |
| GitHub Community Announcements | https://github.com/orgs/community/discussions/categories/announcements | FAQ updates, billing transition info | — |

> **Note**: The coding agent runs in GitHub's cloud, not locally. Relevant for understanding feature parity, model availability, and GitHub's strategic direction. Setup is via `.github/workflows/copilot-setup-steps.yml` per repo.

### 1.4 Discord

| Source | URL | What It Covers | Feed | Agent? |
|---|---|---|---|---|
| Discord Developer Changelog | https://docs.discord.com/developers/change-log.md | API changes, new features, deprecations | — | ✅ .md |
| Discord API Reference | https://docs.discord.com/developers/reference.md | REST/Gateway API reference | — | ✅ .md |
| Discord Bots Guide | https://docs.discord.com/developers/guides/bots.md | Bot development guide | — | ✅ .md |
| Discord Webhooks | https://docs.discord.com/developers/platform/webhooks.md | Webhook API | — | ✅ .md |
| Discord Server/Channel Mgmt | https://docs.discord.com/developers/platform/server-and-channel-management.md | Server & channel API | — | ✅ .md |

> **Agent readability:** Discord docs use the same `.md` suffix convention as
> Anthropic — all URLs above return clean markdown. Discovery index:
> https://docs.discord.com/llms.txt

**seam-acp integration points**:
- Library: `discord.js` v14 (`package.json`)
- Platform adapter: `src/platforms/discord/adapter.ts` — Discord client setup, event handlers
- Orchestrator: `src/platforms/discord/orchestrator.ts` — message routing, thread management, streaming to Discord
- Slash commands: `src/platforms/discord/commands.ts` — `/seam` command tree
- Renderer: `src/platforms/discord/renderer.ts` — markdown → Discord message formatting
- Config: `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_CHANNEL_IDS`, `DISCORD_DEV_GUILD_ID`, `DISCORD_NOTIFICATIONS_CHANNEL_ID`
- **Key concern**: Discord API version deprecations, Gateway intent changes, message content intent, rate limit policy changes, webhook format changes

#### Privileged-intent operations

The Discord adapter currently requests `Guilds`, `GuildMessages`,
`MessageContent`, and `GuildVoiceStates`. Of those, only `MessageContent` is a
privileged intent; `GuildMessages` is a standard intent.

Discord's June 10, 2026 policy uses the number of users who can access an app,
not its server count. An app accessible to fewer than 10,000 users can continue
using a privileged intent after enabling it in the Developer Portal and does
not enter the review or annual-reapplication process. Once an app reaches
10,000 accessible users, it must apply for privileged-intent access. An app
whose access was granted through that review must reapply once per year.

For this private deployment there is currently no reviewed approval anniversary
to schedule. If its accessible audience approaches 10,000 users:

1. Apply for `MessageContent` access in the Discord Developer Portal before the
   threshold is crossed.
2. Record the approval date and responsible owner in the operations calendar.
3. Schedule an annual reminder far enough ahead of the approval anniversary to
   complete reapplication without an access gap.
4. During each Discord monitoring sweep, confirm the audience remains below the
   threshold or that the reminder and approval are current.

Sources: [Discord's June 10, 2026 policy
announcement](https://docs.discord.com/developers/change-log#changes-to-privileged-intent-access-for-discord-apps)
and the [Gateway intent reference](https://docs.discord.com/developers/events/gateway#privileged-intents).

### 1.5 Agent Client Protocol (ACP)

| Source | URL | What It Covers | Feed |
|---|---|---|---|
| Official Site | https://agentclientprotocol.com/ | Spec, documentation | — |
| Updates Page | https://agentclientprotocol.com/updates | Protocol stability updates | [RSS](https://agentclientprotocol.com/updates/rss.xml) |
| GitHub Repo (monorepo) | https://github.com/agentclientprotocol/agent-client-protocol | Spec + Rust/schema impl (e.g. `schema-v1.13.7`). **No longer tracks npm SDK versions** as of 2026-06-16. | [Atom](https://github.com/agentclientprotocol/agent-client-protocol/releases.atom) |
| GitHub Repo (TS SDK) | https://github.com/agentclientprotocol/typescript-sdk | **The npm `@agentclientprotocol/sdk` package** — releases + CHANGELOG live here as of 2026-06-16 (split out of the monorepo) | [Atom](https://github.com/agentclientprotocol/typescript-sdk/releases.atom) |
| npm: `@agentclientprotocol/sdk` | https://www.npmjs.com/package/@agentclientprotocol/sdk | SDK versions (changelog now in the `typescript-sdk` repo) | [API](https://registry.npmjs.org/@agentclientprotocol/sdk) |
| Yarn: `@agentclientprotocol/sdk` | https://yarnpkg.com/package/@agentclientprotocol/sdk | Also has changelog visibility | — |

**seam-acp integration points**:
- Current version: `^1.1.0` (in `package.json`) — upgraded from `^0.22.1` on 2026-07-01, tracking the v1.0.0 GA line (schema v1.16.0)
- Used by: [`agent-runtime.ts`](../src/agents/agent-runtime.ts) — `AcpClient` / `ClientSideConnection` is the core protocol client (both deprecated since 0.27.0; migrate before the next SDK major)
- Also used by: [`agy.ts`](../src/agents/profiles/agy.ts) — `AgentSideConnection` for in-process ACP bridge
- Key types: `ContentBlock`, `McpServer`, `PromptCapabilities`, `RequestError`, `ndJsonStream`, `PROTOCOL_VERSION`
- Communication: nd-JSON over stdio for all agents (except agy which fakes it in-process)
- Timeouts: `START_TIMEOUT_MS` = 45s (initialize), `NEW_SESSION_TIMEOUT_MS` = 45s (session/new)

> **⚠️ IMPORTANT**: The ACP SDK is the foundational dependency. A major version bump here could require changes across the entire agent layer — every agent profile plus the runtime.

### 1.6 Remote Agent Infrastructure

| Source | URL | What It Covers | Feed |
|---|---|---|---|
| Cloudflare Tunnel Docs | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/ | Tunnel setup, changes | — |
| Cloudflare Status | https://www.cloudflarestatus.com/ | Service health | — |

**seam-acp integration points**:
- WebSocket bridge: `scripts/remote-agent-bridge.mjs` (37KB)
- Config: `REMOTE_COPILOT_PROFILES` env var (`id:port:token` server mode, `id:wss://url:token` client mode)
- Hardcoded models in `config.ts` as `REMOTE_MAC_MODELS`
- Tunnel URL publishing: `TUNNEL_GIST_ID` env var (GitHub Gist)
- Profile source: [`remote.ts`](../src/agents/profiles/remote.ts) (470 lines)

### 1.7 Opencode / LM Studio (local models)

> **Opencode** (`opencode acp`, from [sst/opencode](https://github.com/sst/opencode)) is the
> CLI behind seam-acp's **"LM Studio 🦙"** agent. seam-acp uses it to expose
> **local** LM Studio models (not a hosted provider) over ACP. It was added
> after the original runbook was written and is now a first-class integration.

| Source | URL | What It Covers | Feed |
|---|---|---|---|
| opencode site / docs | https://opencode.ai/ | Docs, config schema (`https://opencode.ai/config.json`) | — |
| opencode GitHub repo | https://github.com/anomalyco/opencode | Source, issues, releases (repo moved from sst/opencode as of 2026-06-18 sweep) | [Atom](https://github.com/anomalyco/opencode/releases.atom) |
| npm: `opencode-ai` | https://registry.npmjs.org/opencode-ai | Versions (latest: 1.17.8 at 2026-06-18 sweep) | [API](https://registry.npmjs.org/opencode-ai) |
| LM Studio | https://lmstudio.ai/ | Local model server (the model source) | — |

**seam-acp integration points**:
- CLI binary: `opencode acp` (env: `OPENCODE_CLI_PATH`, default `opencode` on PATH)
- Enable flag: `OPENCODE_ENABLED` env var
- opencode reads its **global** config at `~/.config/opencode/opencode.json` — seam-acp **writes a custom LM Studio provider block** into it (opencode ≤1.15.x does NOT auto-discover models for a custom provider)
- **Capability flags are load-bearing**: each model must declare `modalities` (vision) or opencode silently strips image attachments before sending to a vision model
- Model IDs are `<prefix>/<rawId>` (e.g. `lmstudio-remote/google/gemma-4-26b-a4b`)
- MCP entries managed under the config's `mcp` key; `{env:VAR}` substitution supported
- Profile source: [`opencode.ts`](../src/agents/profiles/opencode.ts) (249 lines)

> **Watch for**: opencode config-schema changes (`opencode.json` shape, the
> per-model capability/`modalities` fields), changes to `opencode acp`, and
> whether opencode adds auto-discovery for custom providers (would let seam-acp
> stop writing the provider block itself).

### 1.8 Billing & Pricing (All Providers)

| Provider | URL | Notes |
|---|---|---|
| Google AI / Gemini API | https://ai.google.dev/gemini-api/docs/pricing | Per-1M-token pricing; free tier available; mandatory spending caps since Apr 2026; prepaid billing for new accounts |
| Google AI Studio Console | https://aistudio.google.com/ | Manage keys, billing, usage |
| Google Cloud Vertex AI | https://cloud.google.com/vertex-ai/pricing | Enterprise pricing |
| Anthropic | https://www.anthropic.com/pricing | Plan tiers, token costs |
| Anthropic (detailed) | https://docs.anthropic.com/en/docs/about-claude/pricing | Per-model token pricing; prompt caching 90% discount; batch 50% discount |
| Anthropic Console | https://console.anthropic.com/ | Manage billing, usage, payment methods |
| GitHub Copilot | https://github.com/features/copilot | Transitioned to AI Credits (1 credit = $0.01) as of Jun 1, 2026; tiers: Free/Pro/Pro+/Max/Business/Enterprise; unlimited completions; agentic usage is token-based |
| GitHub Copilot Billing Docs | https://docs.github.com/en/copilot/managing-copilot/managing-copilot-as-an-individual-subscriber/managing-your-copilot-plan-and-billing | Detailed billing management |

> **Recent billing changes to track**:
> - **GitHub**: Transitioned to AI Credits model (Jun 1, 2026). 1 credit = $0.01. Agentic usage is token-based.
> - **Anthropic**: Agent SDK usage separated from Pro/Max subscriptions as of Jun 15, 2026.
> - **Google**: Mandatory spending caps since Apr 2026. Prepaid billing for new accounts.

---

## 2. What to Look For

When scanning each source, categorize findings into these buckets:

### 2.1 New Features
- New CLI flags, commands, or modes
- New models added to a provider
- New ACP protocol capabilities (new message types, fields)
- New MCP server integrations or tool types
- New streaming behaviors or content block types
- New agy Connect/gRPC endpoints or event types

### 2.2 Breaking Changes
- Removed or renamed CLI flags (especially `--acp`, `--config-dir`, `--additional-mcp-config`)
- Changed default behaviors
- ACP protocol version bumps with incompatible changes
- npm package renames, scope changes, or install method changes (e.g., Claude Code moved to `curl` install)
- Authentication flow changes
- Minimum Node.js version bumps
- agy conversation file format changes (e.g., `.pb` → `.db` transition)
- Session storage format changes

### 2.3 Policy Changes
- Terms of service updates
- Data handling / privacy policy changes
- Usage policy changes (what agents can/can't do)
- API rate limit changes
- Content filtering changes

### 2.4 Model Releases
- New model versions (e.g., `claude-opus-4.6` → `claude-opus-5.0`)
- Model deprecations and sunset dates
- Model ID format changes
- Context window changes
- Capability changes (vision, tool use, adaptive thinking, etc.)
- Effort level changes (new levels added/removed)

### 2.5 Major Company News
- Acquisitions, partnerships, leadership changes
- Platform shutdowns or major pivots (e.g., Gemini CLI deprecation)
- Open-source releases relevant to coding agents
- Competitor launches that affect the landscape

### 2.6 Billing Updates
- Price changes (per-token, per-seat, per-request, per-credit)
- New plan tiers or plan restructuring
- Free tier changes
- Rate limit or quota changes
- New billing models (e.g., AI Credits, per-task pricing)
- Spending cap requirements

---

## 3. Execution Checklist

Use this checklist for each monitoring sweep. Copy it into your report and check off items as you go.

### Phase 1: Gather

```markdown
### Gather Checklist

#### Google / Antigravity CLI (agy)
- [ ] Check [Antigravity CLI releases](https://github.com/google-antigravity/antigravity-cli/releases) — last checked version: **1.1.24** (2026-09-02 sweep; installed = latest; 1.1.24: `/mcp` panel navigation, deduplicated `/agents` picker entries, fixed tool init & agent startup in deleted working directories, `FD_CLOEXEC` on preserved pipes in headless mode, tolerant `mcp_config.json` comment/trailing comma parsing, conversation deletion orphaned annotation cleanup, `/btw` side-question goal loop fix; #42 updated)
- [ ] Check [Antigravity CLI CHANGELOG](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)
- [ ] Check [Gemini API release notes](https://ai.google.dev/gemini-api/docs/changelog) (models shared with agy; agentic video understanding GA Sep 1)
- [ ] Scan [Google AI Blog](https://blog.google/technology/ai/) for announcements
- [ ] Check [Google AI pricing](https://ai.google.dev/gemini-api/docs/pricing) for changes

#### Anthropic / Claude Code
- [ ] Check [Claude Code releases](https://github.com/anthropics/claude-code/releases) — last checked version: **2.1.258** (2026-09-02 sweep; installed 2.1.258 = latest; 2.1.258: Monterey launch fix, scheduled/remote session permission fix; 2.1.257: Claude Fable 5.1 default, timeFormat/timeZone, auto-mode containment escape, subagent model force, session-only effort)
- [ ] Check [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [ ] Check [Claude Code docs changelog](https://docs.anthropic.com/en/docs/claude-code/changelog)
- [ ] Check [claude-agent-acp releases](https://github.com/agentclientprotocol/claude-agent-acp/releases) — last checked version: **0.73.0** (2026-09-02; installed 0.73.0 and validated via #39)
- [ ] Check [claude-agent-acp CHANGELOG](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/CHANGELOG.md)
- [ ] Scan [Anthropic News](https://www.anthropic.com/news) for announcements (Claude Fable 5.1 GA)
- [ ] Check [Anthropic platform release notes](https://docs.anthropic.com/en/release-notes)
- [ ] Check [Anthropic models page](https://docs.anthropic.com/en/docs/about-claude/models) for new/deprecated models
- [ ] Check [Anthropic pricing](https://www.anthropic.com/pricing) for changes
- [ ] Check [Anthropic status](https://status.anthropic.com/) for ongoing incidents

#### GitHub / Copilot
- [ ] Check [Copilot CLI releases](https://github.com/github/copilot-cli/releases) — last checked version: **1.0.82 stable GA / 1.0.83-2 pre-release** (2026-09-02 sweep; installed 1.0.81 = stable current; 1.0.83-2 pre-release: custom agent model fallback lists, `claude-fable-5.1` support, Linux proxy sandbox egress; upcoming billing/policy changes on Sep 28 and Oct 1)
- [ ] Check [Copilot CLI CHANGELOG](https://github.com/github/copilot-cli/blob/main/CHANGELOG.md)
- [ ] Scan [GitHub Changelog](https://github.blog/changelog/) for Copilot entries (Claude Fable 5.1 GA in Copilot, Copilot code review PR approvals)
- [ ] Scan [GitHub Blog](https://github.blog/) for Copilot announcements
- [ ] Check [VS Code release notes](https://code.visualstudio.com/updates) (Copilot sections)
- [ ] Check [Copilot feature changelog](https://github.blog/changelog/) (filter for Copilot entries)
- [ ] Check [Copilot pricing](https://github.com/features/copilot) for changes
- [ ] Check [Coding Agent docs](https://docs.github.com/en/copilot/using-github-copilot/using-copilot-coding-agent) for updates
- [ ] Check [GitHub Community Announcements](https://github.com/orgs/community/discussions/categories/announcements) for billing/policy updates

#### Opencode / LM Studio
- [ ] Check [opencode releases](https://github.com/anomalyco/opencode/releases) and npm [`opencode-ai`](https://registry.npmjs.org/opencode-ai/latest) — last checked version: **1.18.26** (2026-09-02 sweep; installed 1.15.13, upgrade tracked in #12; 1.18.26: Claude 5 stale thinking block fix, Bedrock GPT-5.6 reasoning fix, apply_patch metadata fix; #12 updated)
- [ ] Check [opencode config schema](https://opencode.ai/config.json) for shape changes (esp. per-model `modalities`/capability fields)
- [ ] Check for `opencode acp` subcommand changes or custom-provider auto-discovery

#### ACP Protocol
- [ ] Check [ACP SDK npm](https://registry.npmjs.org/@agentclientprotocol/sdk) — current pinned: `^1.4.0`, installed: 1.4.0, latest: **1.4.0** (installed in workspace; #28 closed)
- [ ] Check [ACP monorepo releases](https://github.com/agentclientprotocol/agent-client-protocol/releases) for spec/schema changes (`schema-v*` tags; Schema v1.21.0 & Schema v2.0.0-alpha.3 released 2026-08-20)
- [ ] Check [ACP updates page](https://agentclientprotocol.com/updates)
- [ ] Check [ACP v2 Draft status](https://agentclientprotocol.com/protocol/v2/overview) — **v2.0.0-alpha.3 schema shipped in monorepo (2026-08-20); SDK 1.4.0 enforces v2 lifecycle; tracked in #41; monitor for RC; no seam-acp implementation until stable** | ACP v1 Elicitation stabilized in SDK 1.4.0 — tracked in #45
- [ ] Scan [ACP repo issues](https://github.com/agentclientprotocol/agent-client-protocol/issues) for breaking change discussions
```

### Phase 2: Analyze

For each finding from Phase 1, run it through the [Analysis Framework](#4-analysis-framework) below.

### Phase 3: Report

Write up findings using the [Report Template](#6-report-template).

### Phase 4: Act

**Never make code changes during the sweep.** For each finding, follow the decision tree in [§4 Angle 4](#angle-4-upgrade-action-decision-tree). The outcome is always one of:

- A plain report entry (no seam-acp code changes needed)
- A mention of an existing GitHub issue that already covers the finding
- An update to an existing GitHub issue with new scope or version details
- A new, detailed GitHub issue (written so another agent can implement it autonomously)

Use the [Reaction Playbooks](#5-reaction-playbooks-seam-acp-specific) for common scenarios. Link all issue numbers in the report.

---

## 4. Analysis Framework

Every finding should be analyzed from three angles:

### Angle 1: Impact on seam-acp

| Question | Details |
|---|---|
| **Code changes needed?** | Does this require modifying any agent profile, the runtime, the config, or the platform layer? Which files? |
| **New capabilities to adopt?** | Is there a new feature we should expose (new model, new mode, new CLI flag)? |
| **Policy impact?** | Does a policy change affect how we spawn agents, store data, or handle permissions? |
| **Deadline?** | Is there a deprecation date, sunset timeline, or required-by date? |
| **Model-resolution impact?** | Does this change how `claude-agent-acp` selects models (the `"model"` config option, `resolveModelPreference`, advertised `availableModels`, exact-match-before-fuzzy order)? The local patch was retired at 0.54.1 — a regression here would be handled in `claude.ts` (e.g. `ANTHROPIC_MODEL` forwarding) or a freshly re-derived patch, per the model-management runbook, NOT by "re-applying patch-acp" (that script no longer exists). |
| **Config changes?** | Do we need to update `.env.example`, model picker env vars, or defaults? |
| **Session storage?** | Does this change session file formats, paths, or storage mechanisms? |

**Key files to consider**:
- Agent profiles: `packages/adapters/src/profiles/{copilot,claude,agy,opencode,remote}.ts` (`gemini.ts` has been removed)
- Runtime: `packages/core/src/agents/agent-runtime.ts`
- Config: `packages/core/src/config.ts`
- Claude model/context config: `packages/adapters/src/profiles/claude.ts` (`CLAUDE_CONTEXT_WINDOWS`, `getClaudeContextWindow`) — replaces the retired `scripts/patch-claude-agent-acp.mjs`
- Model management: `docs/model-management-runbook.md`
- Session management: `src/agents/session-manager.ts`

### Angle 2: Impact on development in general

| Question | Details |
|---|---|
| **Workflow changes?** | Does this change how developers use the tool day-to-day? |
| **New capabilities?** | What new things can developers do that they couldn't before? |
| **Migration needed?** | Is there a migration path developers need to follow? |
| **Ecosystem effects?** | Does this affect other tools, extensions, or workflows? |

### Angle 3: Interesting for developers in the space

| Question | Details |
|---|---|
| **Trend signal?** | Does this indicate a broader trend in AI coding tools? |
| **Competitive move?** | Is this a response to or differentiation from a competitor? |
| **Research relevance?** | Does this connect to interesting research or novel capabilities? |
| **Community impact?** | How is the developer community reacting? |

### Angle 4: Upgrade Action Decision Tree

Every finding that involves a potential version upgrade, a behavioral change, or a newly identified seam-acp requirement must be processed through this decision tree. **Never make code changes during the sweep.**

**Step 1 — Does this finding require seam-acp code changes?**

Use the Angle 1 checklist above. If **no** (purely informational, billing note, general industry trend, model that's already handled dynamically by agy's live catalog, etc.):
→ **Add to report as normal. Stop here — no further action required.**

If **yes** (new CLI flag, changed API behavior, new model needing registration, ACP type changes, model-selection/`setSessionConfigOption` behavior change, config schema change, session storage format change, etc.):
→ **Continue to Step 2.**

**Step 2 — Check the GitHub Issues list for seam-acp.**

Search [https://github.com/jbulpitt/seam-acp/issues](https://github.com/jbulpitt/seam-acp/issues) for an existing issue covering this upgrade. Search by:
- Package/tool name (e.g., `claude-agent-acp`, `opencode`, `ACP SDK`, `copilot`)
- Version number(s) involved
- Symptom or behavior keyword (e.g., `model resolver`, `resolveModelPreference`, `modalities`, `EffortLevel`)

**Step 3a — Issue exists AND already covers this specific version and change?**
→ Mention the issue number in the report. Stop here — no further action required.
*Example report note*: "Tracked in #42 — no new scope identified."

**Step 3b — Issue exists but this finding adds new scope, version details, or edge cases?**
→ **Update the existing GitHub issue** — be additive, preserve original content, and append a clearly dated update block (e.g., `**Update 2026-06-22 (sweep):**`). Mention the issue number and the update in the report.
*Example report note*: "Updated #42 with new scope from claude-agent-acp 0.50.0 changelog."

**Step 3c — No issue exists?**
→ **Create a new, detailed GitHub issue** following the Issue Writing Guidelines below. Link the new issue number in the report.

---

**Issue Writing Guidelines (Step 3c)**

The goal is an issue detailed enough that another agent can autonomously implement the change. Every issue must include:

1. **Title** — Clear and specific. Include the package name and version if applicable.
   *Example*: `Upgrade claude-agent-acp to ≥0.55.0 and re-verify model selection via setSessionConfigOption`

2. **Context** — Why this change is needed. Link to the upstream changelog, release notes, GitHub release, or commit. Include the relevant excerpt or quote so the implementer doesn't have to re-find it.

3. **Affected files** — List the specific seam-acp source files that will likely need changes. Reference the integration points from §1 and the key files in §4 Angle 1. Be specific about file paths.

4. **Proposed changes** — Step-by-step description of what needs to happen. Be concrete:
   - Name specific env vars, function names, config keys, file paths
   - Reference the relevant reaction playbook (§5.x) or runbook section
   - If it involves Claude model selection or context windows, reference [`model-management-runbook.md`](model-management-runbook.md) and the specific sections (the local resolver patch was retired at 0.54.1 — do NOT reintroduce "run patch-acp")
   - If it involves new model IDs, describe the verification steps (JSONL probe, status card check, and the account caveat — confirm the ID is advertised or `setSessionConfigOption` will reject it)

5. **Research notes** — Anything discovered during the sweep that helps the implementer: relevant upstream commits, potential gotchas, related issues, prior art, links to spec/schema changes.

6. **Acceptance criteria (AC)** — A concrete checklist the implementer can tick off to confirm the work is complete. Examples:
   - `[ ] Model selection via setSessionConfigOption verified (no "Invalid value for config option model" rejection)`
   - `[ ] JSONL ground truth confirms correct model (not self-report)`
   - `[ ] Status card shows expected model + effort after restart`
   - `[ ] npm run typecheck passes`
   - `[ ] npm run build passes`
   - `[ ] Live Discord session confirms expected behavior`

7. **Priority / deadline** — Note if there is a deprecation date, sunset date, or if the change is actively breaking current functionality. Flag as blocking if appropriate.

---

## 5. Reaction Playbooks (seam-acp-specific)

### 5.0 GitHub Issue Workflow (Quick Reference)

> **This section is a quick reference.** The full decision tree and issue-writing guidelines are in [§4 Angle 4](#angle-4-upgrade-action-decision-tree).

**Rule**: Never make code changes during a monitoring sweep.

For every finding, ask: does this require seam-acp code changes?

- **No** → add to report as normal. Done.
- **Yes** → search [GitHub Issues](https://github.com/jbulpitt/seam-acp/issues).
  - **Issue exists, exact scope covered** → mention issue # in report. Done.
  - **Issue exists, needs updates** → append a dated update block to the issue. Mention issue # and update in report.
  - **No issue exists** → write a detailed new issue (see §4 Angle 4 for guidelines). Mention new issue # in report.

When writing a new issue, always include:
- Upstream source (changelog URL, release URL, or commit)
- Affected files in seam-acp with specific paths
- Step-by-step proposed changes with concrete function/env var names
- Acceptance criteria checklist
- Deadline or urgency signal if applicable
- Enough detail that another agent can implement autonomously

### 5.1 New model released by any provider

1. **Identify the model ID** exactly as the provider specifies it.
2. **For Claude models**: Follow [`model-management-runbook.md`](model-management-runbook.md) §4 (probe against JSONL) before adding the **bare full ID** to `CLAUDE_MODELS` (no `[1m]` suffix). Add its native context window to `CLAUDE_CONTEXT_WINDOWS` in `claude.ts` (or confirm the `claudeContextWindowFamily` heuristic covers it). Confirm the ID is advertised — an un-advertised full ID is REJECTED by 0.54.1's `setSessionConfigOption` (account caveat). Check if it supports adaptive thinking.
3. **For Gemini models** (legacy — deprecated): No longer actively maintained. If still using Gemini CLI, test with `gemini --acp`.
4. **For Copilot models**: Test with `copilot --acp` that the model is available. Add to `COPILOT_MODELS` in `.env`.
5. **For Antigravity models**: Models are fetched dynamically from agy's language server — usually no code change needed. If the model naming convention changes, update `AGY_MODELS` or the model catalog logic in [`agy.ts`](../src/agents/profiles/agy.ts).
6. Update `.env.example` with the new model entry.
7. Consider updating `*_DEFAULT_MODEL` if the new model is a clear upgrade.
8. Update `REMOTE_MAC_MODELS` in `config.ts` if the model should be available for remote profiles.

### 5.2 `claude-agent-acp` or `@anthropic-ai/claude-code` updated

> **⚠️ CAUTION**: This is the highest-risk update. Follow every step. See also [`model-management-runbook.md`](model-management-runbook.md) for the authoritative end-to-end process.

1. **Read the changelog** for both packages before updating — check both GitHub releases and CHANGELOG.md.
2. **Check model-selection behavior** — the local resolver patch was **retired at 0.54.1** (there is no `patch-acp` script anymore). Model selection is now the `"model"` `SessionConfigSelect` set via `setSessionConfigOption`, and 0.54.1 exact-matches advertised full IDs before fuzzy-matching. Watch the changelog for any change to `setSessionConfigOption`, `resolveModelPreference`, the exact-match-before-fuzzy order, or advertised `availableModels` — a regression here is the highest-risk change.
3. **Update the packages**: `npm i -g @agentclientprotocol/claude-agent-acp@latest @anthropic-ai/claude-code@latest`, and bump `@agentclientprotocol/sdk` in `package.json` if it moved (`npm install`).
4. **Confirm pristine**: a clean install should report PRISTINE (we no longer patch — a MODIFIED result means unexpected tampering). Do NOT run any patch step.
5. **Verify model selection**: Follow [`model-management-runbook.md`](model-management-runbook.md) §4 — probe every picker entry against JSONL ground truth and confirm none is rejected with `Invalid value for config option model` (account caveat). **Never trust model self-reports.**
6. **Test a session**: Start a Claude session via Discord, confirm the status card shows the correct resolved model and effort.
7. **Check for new features**: Look for new CLI flags, env vars, or ACP capabilities.
8. **Check `EffortLevel` type**: If the bundled SDK's `EffortLevel` enum changed, update effort handling in [`claude.ts`](../src/agents/profiles/claude.ts).
9. **Check adaptive thinking**: If thinking display options changed, update the `_meta.claudeCode.options.thinking` logic.
10. **If a full ID gets rejected**: the old `query.setModel(fullId)` escape hatch is gone — forward the model via `ANTHROPIC_MODEL` in the `claude.ts` spawn env, or re-derive a fresh patch against the new version (per the model-management runbook). Do this in a separately tasked session, not during a sweep.

### 5.3 ACP SDK version bump

1. Check the [TS SDK releases](https://github.com/agentclientprotocol/typescript-sdk/releases) (npm package changelog, split out of the monorepo 2026-06-16), the [ACP monorepo releases](https://github.com/agentclientprotocol/agent-client-protocol/releases) (spec/`schema-v*` tags), and the [updates page](https://agentclientprotocol.com/updates) for breaking changes.
2. Review the diff of protocol types (especially `AcpClient`/`ClientSideConnection` constructor, session methods, event types).
3. Update `package.json`: `npm install @agentclientprotocol/sdk@latest`
4. Run `npm run typecheck` — type errors reveal breaking changes.
5. Run `npm test`.
6. Test each agent profile (Copilot, Gemini, Claude, agy) with a real session.
7. Pay special attention to agy's `AgentSideConnection` usage — it uses the SDK's server-side API which may have different breaking changes.

### 5.4 Antigravity CLI (agy) updated

1. Check [releases](https://github.com/google-antigravity/antigravity-cli/releases) and [CHANGELOG](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md).
2. Check for gRPC/Connect endpoint changes (especially `GetAvailableModels`, `StreamAgentStateUpdates`).
3. Check for conversation file format changes (previously `.pb` → `.db`).
4. Check for new CLI flags or changes to `-p`, `--conversation`, `--add-dir`, `--dangerously-skip-permissions`.
5. Check for new step types or metadata fields in streaming events.
6. Update agy binary (it's a Go binary, not npm — check install instructions).
7. Test an agy session via Discord, verify model catalog loads and streaming works.

### 5.5 Gemini CLI deprecation & removal

> **Status (2026-06-15)**: Gemini CLI (`@google/gemini-cli`) service sunsets **June 18, 2026**. Antigravity CLI (`agy`) is Google's official replacement. The `gemini.ts` profile has **already been removed** from `src/agents/profiles/` — this playbook is now a **cleanup checklist for the remaining stale references**.

Remaining cleanup:

1. ✅ `src/agents/profiles/gemini.ts` — already removed.
2. ✅ Confirm Gemini env vars are gone from `src/config.ts`: `GEMINI_CLI_PATH`, `GEMINI_DEFAULT_MODEL`, `GEMINI_MODELS`, `GEMINI_PROFILES` (all absent; one stale comment on line 128 fixed in 2026-06-19 sweep).
3. ✅ Remove Gemini entries from `.env.example` (verify — env vars absent from config.ts schema confirms they were removed).
4. ✅ **Update `README.md`** — Gemini env var rows, install instructions, multi-account section, and profile mention all removed in 2026-06-19 sweep.
5. ✅ Run `npm run typecheck && npm test && npm run build` — done in 2026-06-19 sweep; only 3 pre-existing type errors (unrelated to Gemini cleanup).
6. ✅ Grep this runbook for any remaining `gemini.ts` / Gemini-CLI references — done in 2026-06-19 sweep. Remaining references are appropriate historical/contextual mentions (§1.1 deprecation notice, §4 note, §5.5 history). No further removal needed.

### 5.6 Copilot CLI updated


1. Check [releases](https://github.com/github/copilot-cli/releases) and [CHANGELOG](https://github.com/github/copilot-cli/blob/main/CHANGELOG.md).
2. Check for `--acp` flag changes.
3. Check for `COPILOT_GITHUB_TOKEN` env var handling changes.
4. Check for `--additional-mcp-config` flag changes.
5. Check for `reasoning_effort` config option changes.
6. Update the CLI: `npm i -g @github/copilot@latest` (or brew).
7. Test a Copilot session via Discord.

### 5.7 Breaking change with a deadline

1. Document the deadline prominently in the report.
2. Create a tracking issue/task with the deadline.
3. Assess migration effort (hours/days).
4. Schedule the migration work with buffer before the deadline.
5. After migrating, verify on a test session before deploying.

### 5.8 Billing/pricing change

1. Document the change and effective date.
2. Calculate impact on current usage patterns.
3. Evaluate whether to switch default models or providers.
4. Update any cost guidance in project docs.
5. For GitHub AI Credits: check if agentic usage metering changed.
6. For Anthropic: check if agent SDK billing separation affects our usage.

### 5.9 Opencode (sst/opencode) updated

1. Check [releases](https://github.com/sst/opencode/releases.atom) and npm [`opencode-ai`](https://registry.npmjs.org/opencode-ai).
2. Check for changes to the `opencode acp` subcommand.
3. **Check the config schema** (`https://opencode.ai/config.json`) — seam-acp writes a custom provider block into `~/.config/opencode/opencode.json`; a schema change (esp. the per-model `modalities`/capability fields) can silently break vision (images stripped). See [`opencode.ts`](../src/agents/profiles/opencode.ts).
4. Check whether opencode added **auto-discovery for custom providers** — if so, seam-acp could stop writing the provider block.
5. Test an "LM Studio 🦙" session via Discord; confirm models load and an image attachment reaches a vision model.

---

## 6. Report Template

Use this template for each monitoring sweep. Save reports as `docs/upstream-reports/YYYY-MM-DD.md`.

```markdown
# Upstream Monitoring Report — YYYY-MM-DD

**Sweep performed by**: [agent / person]
**Period covered**: [date range]

## Summary

<!-- 1-3 sentence overview of the most important findings -->

## Action Items

| # | Finding | Severity | Deadline | Status |
|---|---|---|---|---|
| 1 | ... | 🔴 critical / 🟡 moderate / 🟢 low | YYYY-MM-DD or N/A | ⬜ todo / ✅ done |

## Detailed Findings

### Google / Antigravity CLI (agy)

#### New in this period
<!-- List findings with analysis from all 3 angles -->

#### seam-acp impact
<!-- Specific code/config changes needed -->

<!-- Gemini CLI (legacy) — deprecated, no longer tracked. See §5.5 for removal plan. -->

### Anthropic / Claude Code

#### New in this period

#### seam-acp impact

### GitHub / Copilot

#### New in this period

#### seam-acp impact

### ACP Protocol

#### New in this period

#### seam-acp impact

### Billing & Pricing

#### Changes

### General Industry / Ecosystem

#### Notable developments

## Version Snapshot

Record current versions at time of sweep:

| Package / Tool | Version | Last Updated |
|---|---|---|
| `agy` (Antigravity CLI) | | |
| `@google/gemini-cli` (⚠️ removed — profile gone, service sunsets 2026-06-18) | | |
| `@anthropic-ai/claude-code` | | |
| `@agentclientprotocol/claude-agent-acp` | | |
| `copilot` CLI (`@github/copilot`) | | |
| `opencode` (`opencode-ai`, LM Studio profile) | | |
| `@agentclientprotocol/sdk` | | |
| `discord.js` | | |
| Claude resolver patch | RETIRED at 0.54.1 (no patch) | |

## Previous Report

[Link to previous report](./YYYY-MM-DD.md)
```

---

## 7. Self-Update Process

This runbook must evolve as the ecosystem changes. Here's how to keep it current.

### When to update this runbook

- **New tool integration**: When seam-acp adds a new agent profile or platform adapter, add its sources to §1 and a reaction playbook to §5.
- **Source URL changed**: If a changelog URL moves or a new one is discovered, update §1.
- **New analysis question**: If a monitoring sweep reveals a new class of concern, add it to §4.
- **New reaction pattern**: If you handle an upstream change in a novel way, codify it in §5.
- **Structural changes to seam-acp**: If key files are renamed, moved, or the architecture changes, update the "integration points" in §1 and file references in §4.
- **New platform adapter**: When Slack, Google Chat, or MS Teams adapters are added (see `docs/integration-*.md` plans), add their sources and integration points.
- **After every monitoring sweep**: If any checklist items were confusing, incomplete, or missing, update the checklist.

### How to update

1. Edit this file directly: [`upstream-monitoring-runbook.md`](upstream-monitoring-runbook.md).
2. Update the `Last updated` date at the top.
3. If adding a new tool/source, follow this pattern:
   - Add a subsection under §1 with the source table and integration points
   - Add gather checklist items to §3
   - Add a reaction playbook to §5 if the tool has non-trivial update procedures
   - Add a row to the Version Snapshot table in §6
4. Commit with a message like: `docs: update upstream monitoring runbook — add [tool name]`

### Quarterly review

Every quarter, do a meta-review:
- Are all source URLs still valid? (Click each one.)
- Are there new sources we should be watching? (Check if any provider launched a new blog, changelog, or status page.)
- Are the "seam-acp integration points" still accurate? (Cross-reference with actual source files.)
- Are the reaction playbooks still correct? (Re-read each against current code.)
- Has the analysis framework missed anything in recent sweeps?
- Are the file references (line counts, file names) still accurate? Run: `wc -l src/agents/profiles/*.ts src/agents/agent-runtime.ts src/config.ts`

### Automation opportunities

For teams wanting to reduce manual effort, these are automatable:

| Task | How |
|---|---|
| Check npm for new versions | `npm outdated -g` for CLIs; `npm outdated` for SDK deps; or hit `https://registry.npmjs.org/<pkg>/latest` |
| Check GitHub releases | Poll the `.atom` feeds listed in §1 with any RSS reader or script |
| Version snapshot | Script that runs `npm ls @agentclientprotocol/sdk`, `npm list -g @anthropic-ai/claude-code --depth=0`, etc. |
| Diff detection | `git log --oneline` on watched repos between sweep dates |
| Report scaffolding | Script that copies the §6 template, fills in today's date, and pre-populates the version snapshot |
| Model-selection verification | Run the `model-management-runbook.md` §4 JSONL probe on a schedule; flag any picker entry that resolves wrong or is rejected with `Invalid value for config option model` (there is no patch to verify anymore — the resolver patch was retired at 0.54.1) |

---

## Appendix A: Quick-Reference Commands

```bash
# ── Check installed CLI versions ──
copilot --version
agy --version 2>/dev/null || echo "check ~/.local/bin/agy"
claude --version
claude-agent-acp --version 2>/dev/null || echo "no --version flag; check npm"
# gemini --version  # DEPRECATED — Gemini CLI sunset June 18, 2026

# ── Check npm package versions (global CLIs) ──
npm list -g @anthropic-ai/claude-code --depth=0
npm list -g @agentclientprotocol/claude-agent-acp --depth=0
npm list -g @github/copilot --depth=0
# npm list -g @google/gemini-cli --depth=0  # DEPRECATED

# ── Check project dependency versions ──
cd /home/ubuntu/Projects/seam-acp
npm ls @agentclientprotocol/sdk
npm ls discord.js

# ── Check for outdated project deps ──
npm outdated

# ── Check for outdated global CLIs ──
npm outdated -g

# ── Fetch latest version from npm registry (no install) ──
npm view @agentclientprotocol/sdk version
npm view @anthropic-ai/claude-code version
npm view @agentclientprotocol/claude-agent-acp version
npm view @github/copilot version
# npm view @google/gemini-cli version  # DEPRECATED

# ── Claude resolver patch: RETIRED at 0.54.1 — there is no patch-acp script. ──
# Model selection is verified via the model-management-runbook §4 JSONL probe, not
# by re-applying a patch. A clean claude-agent-acp install should stay PRISTINE.

# ── Validate the build after any dependency update ──
npm run typecheck
npm test
npm run build

# ── Diagnostic/probe scripts ──
node scripts/claude-thinking-probe.mjs    # Test thinking output for Claude models
node scripts/agy-acp-probe.mjs           # End-to-end smoke test for agy ACP
node scripts/agy-stream-probe.mjs        # Test agy streaming translation
```

## Appendix B: RSS/Atom Feed URLs

For use with RSS readers, cron-based fetchers, or monitoring scripts:

```
# GitHub Releases (Atom)
https://github.com/google-antigravity/antigravity-cli/releases.atom
# https://github.com/google-gemini/gemini-cli/releases.atom  # DEPRECATED
https://github.com/anthropics/claude-code/releases.atom
https://github.com/agentclientprotocol/claude-agent-acp/releases.atom
https://github.com/agentclientprotocol/agent-client-protocol/releases.atom
https://github.com/github/copilot-cli/releases.atom
https://github.com/microsoft/vscode-copilot-chat/releases.atom

# GitHub Blog & Changelog (RSS)
https://github.blog/feed/
https://github.blog/changelog/feed/

# Google (RSS/Atom)
https://blog.google/rss
https://developers.googleblog.com/atom.xml

# Anthropic Status (Atom)
https://status.anthropic.com/history.atom

# npm Registry API (JSON — poll for version changes)
https://registry.npmjs.org/@agentclientprotocol/sdk
https://registry.npmjs.org/@anthropic-ai/claude-code
https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp
# https://registry.npmjs.org/@google/gemini-cli  # DEPRECATED
https://registry.npmjs.org/@github/copilot
```

## Appendix C: Related seam-acp Documentation

- [`model-management-runbook.md`](model-management-runbook.md) — Authoritative Claude model management process
- [`remote-agent.md`](remote-agent.md) — Remote agent setup via WebSocket bridge
- [`premium-compaction-design.md`](premium-compaction-design.md) — Compaction system design
- [`durable-jobs-plan.md`](durable-jobs-plan.md) — Durable jobs feature plan
- [`scheduled-prompts-plan.md`](scheduled-prompts-plan.md) — Scheduled prompts feature plan
- [`integration-slack.md`](integration-slack.md) — Slack adapter plan
- [`integration-google-chat.md`](integration-google-chat.md) — Google Chat adapter plan
- [`integration-ms-teams.md`](integration-ms-teams.md) — MS Teams adapter plan
