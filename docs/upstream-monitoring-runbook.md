# Upstream Monitoring Runbook

> **Purpose**: Systematic process for gathering, analyzing, and reporting on technical changelogs, feature updates, and policy changes across all AI coding tools that seam-acp integrates with.
>
> **Cadence**: Weekly sweep (recommended: Monday), with ad-hoc checks when a major release is announced.
>
> **Last updated**: 2026-06-03

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

> **⚠️ Gemini CLI is deprecated.** The npm-based `@google/gemini-cli` is being sunset (June 18, 2026). It is no longer actively monitored in this runbook. seam-acp still ships a legacy [`gemini.ts`](../src/agents/profiles/gemini.ts) profile, but it should be considered for removal. See §5.5 for the deprecation/removal playbook.

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
- Profile source: [`agy.ts`](../src/agents/profiles/agy.ts) (1763 lines — largest profile)

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
- Default model: `CLAUDE_DEFAULT_MODEL` (currently `claude-sonnet-4.5`)
- Model picker: `CLAUDE_MODELS` env var — **curated, JSONL-verified entries only**
- Context window: `[1m]` suffix → 1,000,000 tokens; without → 200,000 tokens. **The `[1m]` suffix is load-bearing** — stripped before API call but drives compaction threshold.
- Effort injection: `_meta.claudeCode.options.effort` (not `set_config_option`, not `reasoningEffort` field)
- Valid effort levels: `low`, `medium`, `high`, `xhigh`, `max` (bounded by bundled SDK's `EffortLevel` type; `ultra` NOT available)
- Adaptive thinking (Opus 4.6+): `_meta.claudeCode.options.thinking = { type: "adaptive", display: "summarized" | "omitted" }`
- Identity: reads `~/.claude/.credentials.json` or `~/.claude/credentials.json`
- Usage: `https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20` header
- Session storage: JSONL files at `~/.claude/projects/<slug>/<sessionId>.jsonl`
- **Critical**: Patch script `scripts/patch-claude-agent-acp.mjs` fixes broken model resolver — wiped by any global npm update
- Profile source: [`claude.ts`](../src/agents/profiles/claude.ts) (823 lines)
- Update process: [`model-management-runbook.md`](model-management-runbook.md) (564 lines, authoritative)

> **⚠️ CAUTION**: The `claude-agent-acp` resolver bug is well-documented: in v0.39, `unstable_setSessionModel` runs ALL model strings through `resolveModelPreference` which fuzzy-matches against a tiny 4-entry curated list. Full Opus IDs find no Opus entry → fuzzy-match to **Sonnet**. The patch (`npm run patch-acp`) makes canonical full IDs bypass the broken resolver. It is **wiped by any global npm update and must be re-applied + re-verified**. See §5.2 and [`model-management-runbook.md`](model-management-runbook.md).

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
- Profile source: [`copilot.ts`](../src/agents/profiles/copilot.ts) (481 lines)

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

### 1.5 Agent Client Protocol (ACP)

| Source | URL | What It Covers | Feed |
|---|---|---|---|
| Official Site | https://agentclientprotocol.com/ | Spec, documentation | — |
| Updates Page | https://agentclientprotocol.com/updates | Protocol stability updates | [RSS](https://agentclientprotocol.com/updates/rss.xml) |
| GitHub Repo | https://github.com/agentclientprotocol/agent-client-protocol | Spec + reference implementations | [Atom](https://github.com/agentclientprotocol/agent-client-protocol/releases.atom) |
| npm: `@agentclientprotocol/sdk` | https://www.npmjs.com/package/@agentclientprotocol/sdk | SDK versions | [API](https://registry.npmjs.org/@agentclientprotocol/sdk) |
| Yarn: `@agentclientprotocol/sdk` | https://yarnpkg.com/package/@agentclientprotocol/sdk | Also has changelog visibility | — |

**seam-acp integration points**:
- Current version: `^0.22.1` (in `package.json`)
- Used by: [`agent-runtime.ts`](../src/agents/agent-runtime.ts) — `AcpClient` / `ClientSideConnection` is the core protocol client
- Also used by: [`agy.ts`](../src/agents/profiles/agy.ts) — `AgentSideConnection` for in-process ACP bridge
- Key types: `ContentBlock`, `McpServer`, `PromptCapabilities`, `RequestError`, `ndJsonStream`, `PROTOCOL_VERSION`
- Communication: nd-JSON over stdio for all agents (except agy which fakes it in-process)
- Timeouts: `START_TIMEOUT_MS` = 45s (initialize), `NEW_SESSION_TIMEOUT_MS` = 45s (session/new)

> **⚠️ IMPORTANT**: The ACP SDK is the foundational dependency. A major version bump here could require changes across the entire agent layer — all four profiles plus the runtime.

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

### 1.7 Billing & Pricing (All Providers)

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
- [ ] Check [Antigravity CLI releases](https://github.com/google-antigravity/antigravity-cli/releases) — last checked version: ___
- [ ] Check [Antigravity CLI CHANGELOG](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)
- [ ] Check [Gemini API release notes](https://ai.google.dev/gemini-api/docs/changelog) (models shared with agy)
- [ ] Scan [Google AI Blog](https://blog.google/technology/ai/) for announcements
- [ ] Check [Google AI pricing](https://ai.google.dev/gemini-api/docs/pricing) for changes

#### Anthropic / Claude Code
- [ ] Check [Claude Code releases](https://github.com/anthropics/claude-code/releases) — last checked version: ___
- [ ] Check [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [ ] Check [Claude Code docs changelog](https://docs.anthropic.com/en/docs/claude-code/changelog)
- [ ] Check [claude-agent-acp releases](https://github.com/agentclientprotocol/claude-agent-acp/releases) — last checked version: ___
- [ ] Check [claude-agent-acp CHANGELOG](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/CHANGELOG.md)
- [ ] Scan [Anthropic News](https://www.anthropic.com/news) for announcements
- [ ] Check [Anthropic platform release notes](https://docs.anthropic.com/en/release-notes)
- [ ] Check [Anthropic models page](https://docs.anthropic.com/en/docs/about-claude/models) for new/deprecated models
- [ ] Check [Anthropic pricing](https://www.anthropic.com/pricing) for changes
- [ ] Check [Anthropic status](https://status.anthropic.com/) for ongoing incidents

#### GitHub / Copilot
- [ ] Check [Copilot CLI releases](https://github.com/github/copilot-cli/releases) — last checked version: ___
- [ ] Check [Copilot CLI CHANGELOG](https://github.com/github/copilot-cli/blob/main/CHANGELOG.md)
- [ ] Scan [GitHub Changelog](https://github.blog/changelog/) for Copilot entries
- [ ] Scan [GitHub Blog](https://github.blog/) for Copilot announcements
- [ ] Check [VS Code release notes](https://code.visualstudio.com/updates) (Copilot sections)
- [ ] Check [Copilot feature changelog](https://github.blog/changelog/) (filter for Copilot entries)
- [ ] Check [Copilot pricing](https://github.com/features/copilot) for changes
- [ ] Check [Coding Agent docs](https://docs.github.com/en/copilot/using-github-copilot/using-copilot-coding-agent) for updates
- [ ] Check [GitHub Community Announcements](https://github.com/orgs/community/discussions/categories/announcements) for billing/policy updates

#### ACP Protocol
- [ ] Check [ACP SDK npm](https://www.npmjs.com/package/@agentclientprotocol/sdk) — current pinned: `^0.22.1`, latest: ___
- [ ] Check [ACP repo releases](https://github.com/agentclientprotocol/agent-client-protocol/releases) for spec changes
- [ ] Check [ACP updates page](https://agentclientprotocol.com/updates)
- [ ] Scan [ACP repo issues](https://github.com/agentclientprotocol/agent-client-protocol/issues) for breaking change discussions
```

### Phase 2: Analyze

For each finding from Phase 1, run it through the [Analysis Framework](#4-analysis-framework) below.

### Phase 3: Report

Write up findings using the [Report Template](#6-report-template).

### Phase 4: Act

For any item tagged `action-required`, create a task or issue and link it in the report. Use the [Reaction Playbooks](#5-reaction-playbooks-seam-acp-specific) for common scenarios.

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
| **Patch impact?** | Does this affect the Claude `patch-claude-agent-acp.mjs` script? |
| **Config changes?** | Do we need to update `.env.example`, model picker env vars, or defaults? |
| **Session storage?** | Does this change session file formats, paths, or storage mechanisms? |

**Key files to consider**:
- Agent profiles: `src/agents/profiles/{copilot,claude,agy,remote}.ts` (plus deprecated `gemini.ts`)
- Runtime: `src/agents/agent-runtime.ts`
- Config: `src/config.ts`
- Patch: `scripts/patch-claude-agent-acp.mjs`
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

---

## 5. Reaction Playbooks (seam-acp-specific)

### 5.1 New model released by any provider

1. **Identify the model ID** exactly as the provider specifies it.
2. **For Claude models**: Follow [`model-management-runbook.md`](model-management-runbook.md) §4 (probe against JSONL) before adding to `CLAUDE_MODELS`. Check if it supports `[1m]` context window. Check if it supports adaptive thinking.
3. **For Gemini models** (legacy — deprecated): No longer actively maintained. If still using Gemini CLI, test with `gemini --acp`.
4. **For Copilot models**: Test with `copilot --acp` that the model is available. Add to `COPILOT_MODELS` in `.env`.
5. **For Antigravity models**: Models are fetched dynamically from agy's language server — usually no code change needed. If the model naming convention changes, update `AGY_MODELS` or the model catalog logic in [`agy.ts`](../src/agents/profiles/agy.ts).
6. Update `.env.example` with the new model entry.
7. Consider updating `*_DEFAULT_MODEL` if the new model is a clear upgrade.
8. Update `REMOTE_MAC_MODELS` in `config.ts` if the model should be available for remote profiles.

### 5.2 `claude-agent-acp` or `@anthropic-ai/claude-code` updated

> **⚠️ CAUTION**: This is the highest-risk update. Follow every step. See also [`model-management-runbook.md`](model-management-runbook.md) for the authoritative end-to-end process.

1. **Read the changelog** for both packages before updating — check both GitHub releases and CHANGELOG.md.
2. **Check the `resolveModelPreference` function** — if it changed, the patch may need updating.
3. **Update the package**: `npm i -g @agentclientprotocol/claude-agent-acp@latest`
4. **Re-apply the patch immediately**: `npm run patch-acp`
   - If exit code 1 (anchor not found): upstream changed the resolver — the patch script needs updating.
5. **Verify the patch**: Follow [`model-management-runbook.md`](model-management-runbook.md) §4 — probe against JSONL ground truth. **Never trust model self-reports.**
6. **Test a session**: Start a Claude session via Discord, confirm the status card shows the correct resolved model and effort.
7. **Check for new features**: Look for new CLI flags, env vars, or ACP capabilities.
8. **Check `EffortLevel` type**: If the bundled SDK's `EffortLevel` enum changed, update effort handling in [`claude.ts`](../src/agents/profiles/claude.ts).
9. **Check adaptive thinking**: If thinking display options changed, update the `_meta.claudeCode.options.thinking` logic.

### 5.3 ACP SDK version bump

1. Check the [ACP releases](https://github.com/agentclientprotocol/agent-client-protocol/releases) and [updates page](https://agentclientprotocol.com/updates) for breaking changes.
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

> **Status**: Gemini CLI (`@google/gemini-cli`) is deprecated as of June 18, 2026. Antigravity CLI (`agy`) is Google's official replacement.

The legacy `gemini.ts` profile in seam-acp should be considered for removal. Steps when ready:

1. Confirm no active sessions are using the `gemini` or `gemini-*` agent profiles.
2. Remove `src/agents/profiles/gemini.ts`.
3. Remove Gemini-specific env vars from `src/config.ts`: `GEMINI_CLI_PATH`, `GEMINI_DEFAULT_MODEL`, `GEMINI_MODELS`, `GEMINI_PROFILES`.
4. Remove Gemini entries from `.env.example`.
5. Update `README.md` to remove Gemini CLI setup instructions.
6. Run `npm run typecheck && npm test && npm run build`.
7. Update this runbook to remove remaining Gemini CLI references.

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
| `@google/gemini-cli` (⚠️ deprecated) | | |
| `@anthropic-ai/claude-code` | | |
| `@agentclientprotocol/claude-agent-acp` | | |
| `copilot` CLI (`@github/copilot`) | | |
| `@agentclientprotocol/sdk` | | |
| `discord.js` | | |
| Claude patch applied? | yes/no | |

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
| Patch verification | Run `npm run patch-acp` and check exit code as part of a CI/scheduled job |

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

# ── Re-apply Claude patch after any update ──
npm run patch-acp

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

- [`model-management-runbook.md`](model-management-runbook.md) — Authoritative Claude model management process (564 lines)
- [`remote-agent.md`](remote-agent.md) — Remote agent setup via WebSocket bridge
- [`premium-compaction-design.md`](premium-compaction-design.md) — Compaction system design
- [`durable-jobs-plan.md`](durable-jobs-plan.md) — Durable jobs feature plan
- [`scheduled-prompts-plan.md`](scheduled-prompts-plan.md) — Scheduled prompts feature plan
- [`integration-slack.md`](integration-slack.md) — Slack adapter plan
- [`integration-google-chat.md`](integration-google-chat.md) — Google Chat adapter plan
- [`integration-ms-teams.md`](integration-ms-teams.md) — MS Teams adapter plan
