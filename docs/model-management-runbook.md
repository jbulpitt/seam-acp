# Model Management Runbook

A repeatable, **empirical** process for keeping the Claude model selection in
seam-acp correct. The governing principle of this document: **never trust a
model's self-report, an alias name, a label, or an assumption. Verify against
JSONL ground truth.** Every claim about "what model is running" or "what context
window is active" must be proven by reading the API's own output, not by asking
the model or trusting the string we passed in.

This exists because the `claude-agent-acp` wrapper historically reimplemented
model-alias resolution in a way that was **inconsistent and silently wrong** for
some inputs (e.g. `opus` has resolved to a different family; a full ID could fuzzy-
match to the wrong model). **As of claude-agent-acp 0.54.1 that resolver was fixed
structurally** (see below) and the local patch we used to carry has been
**retired and deleted**. We still verify every entry against JSONL ground truth —
the discipline is unchanged even though the workaround is gone.

The current validated stack is **claude-agent-acp 0.73.0 + ACP SDK 1.4.0**. On
this stack, the wrapper's `default` resolves to **Claude Opus 5 with a 1M
window**. Full canonical IDs remain forwarded through `ANTHROPIC_MODEL` by the
Seam Claude profile so account-specific advertised-model gaps cannot silently
redirect them.

**Model selection is now an ACP session config option.** Since ACP schema v1.16.0
(shipped in SDK 1.x) the dedicated `models` field was removed from session
responses; model selection is exposed as a `SessionConfigSelect` whose
`id`/`category` is `"model"`, and switching models uses
`setSessionConfigOption({ sessionId, configId: "model", value })`. The old
`unstable_setSessionModel` RPC is gone. In 0.54.1, `setSessionConfigOption` for
the model option **exact-matches the requested value against the agent's
advertised model list BEFORE calling `resolveModelPreference`** — so a full
canonical ID (e.g. `claude-opus-4-8`) that is advertised resolves to itself, and
the fuzzy resolver is only a fallback for aliases. This is the structural fix (on
top of v0.42.0's "prevent cross-family matching") that made the local patch
unnecessary.

---

## Cold start — read these first

If you are an agent with no prior context about this project, read the following
before running any procedure in this runbook:

1. **[AGENTS.md](../AGENTS.md)** — what seam-acp is, project structure, critical
   rules (never `pm2 restart`, always `npm run redeploy`), and the Claude model
   management warning that points here.
2. **§0 below** ("Mental model") — the data-flow diagram showing where model
   strings travel and where they can break. This is the conceptual foundation for
   every other section.
3. **Current state** — skim these files to understand what's deployed right now:
   - `.env` — `CLAUDE_DEFAULT_MODEL` and `CLAUDE_MODELS` (the picker values, now
     bare full IDs plus the `default` alias — no `[1m]` suffix)
   - `packages/adapters/src/profiles/claude.ts` — the `CLAUDE_CONTEXT_WINDOWS` table +
     `getClaudeContextWindow()` (compaction threshold + `contextLimit` seed),
     `withClaudeContextLimits()` (stamps every picker entry's `contextLimit`), and
     `newSessionMeta()` (how `_meta` is built)
   - `packages/core/src/config.ts` — env var validation, `REMOTE_MAC_MODELS` (remote Copilot
     agent, separate ID format)
   - **No patch script.** The former `scripts/patch-claude-agent-acp.mjs` and the
     `npm run patch-acp` script were retired at 0.54.1 and no longer exist.
4. **The "Current verified picture" table** above — the last-known-good mapping
   of picker values → API models → context windows. Treat it as stale if any
   version has changed since the date shown.

## Current verified picture (last updated 2026-09-02, claude-agent-acp 0.73.0 + ACP SDK 1.4.0, no patch)

This table is the *output* of the §4 process, kept here as a quick reference.
**It is not a substitute for re-running §4 after any update** — treat it as stale
the moment you touch versions. Model IDs are now **bare** (no `[1m]` suffix); each
model's native window comes from the `CLAUDE_CONTEXT_WINDOWS` table in
`claude.ts`, and the agent also reports the true window at runtime via
`UsageUpdate.size`.

| Picker value | Resolves to (JSONL) | Window | Mechanism |
|---|---|---|---|
| `default` ⭐ | claude-opus-5 (auto-rolls) | 1M | alias (Max → latest Opus) |
| `claude-fable-5-1` | claude-fable-5-1 | 1M | full ID (`ANTHROPIC_MODEL` + exact-match) |
| `claude-opus-5` | claude-opus-5 | 1M | full ID (`ANTHROPIC_MODEL` + exact-match) |
| `claude-opus-4-8` | claude-opus-4-8 | 1M | full ID (`ANTHROPIC_MODEL` + exact-match) |
| `claude-opus-4-7` | claude-opus-4-7 | 1M | full ID (`ANTHROPIC_MODEL` + exact-match) |
| `claude-fable-5` | claude-fable-5 | 1M | full ID (`ANTHROPIC_MODEL` + exact-match) |
| `claude-sonnet-5` | claude-sonnet-5 | 1M | full ID (`ANTHROPIC_MODEL` + exact-match) |

**Account caveat (covered, but keep testing):** a raw 0.73.0 wrapper session on
this account still rejects some full IDs that are absent from its advertised
list. Seam deliberately forwards a selected canonical ID through
`ANTHROPIC_MODEL`, which adds it to the wrapper's available list and selects it.
The 2026-09-02 probe verified every picker row above through that actual Seam
mechanism. Do not remove the forwarding merely because `default` works.

**Never put in the picker** (verified to resolve wrong historically):
`opus`, `best` → resolve to a non-Opus family. Do not add aliases that fuzzy-match.

Two non-obvious truths this table encodes:
1. **The `[1m]` suffix is not part of Seam.** Model IDs are bare;
   the JSONL model id (`claude-opus-4-8`) matches what you passed. Each model's
   native window is declared in the `CLAUDE_CONTEXT_WINDOWS` table in `claude.ts`,
   resolved by `getClaudeContextWindow(modelId)` and stamped onto every picker
   entry (`contextLimit`) by `withClaudeContextLimits` — so the orchestrator's
   `staticModels[].contextLimit → modelContextFloor` path seeds the window on
   turn 1, and the agent's runtime `UsageUpdate.size` refines it.
2. **Every model admitted to this picker has a native 1M window.** Legacy 200K
   choices were removed on 2026-09-02, so the picker does not need window
   variants or window labels.

---

## 0. Mental model — where things can break

```
seam-acp .env (CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL)
   │  the model string you chose (bare full ID or `default`)
   ▼
seam-acp DB (sessions.config_json → cfg.model)
   │  setSessionConfigOption(configId:"model", value:cfg.model) on every
   │  newSession AND loadSession
   ▼
claude-agent-acp 0.73.0  ← exact-matches the value against the agent's
   │                        advertised model list FIRST; a full canonical ID
   │                        that IS advertised resolves to itself.
   │                        resolveModelPreference() is now only a fuzzy
   │                        FALLBACK for aliases. CAVEAT: an un-advertised full
   │                        ID can be REJECTED (see account caveat, §5).
   ▼
Claude Code CLI  ← resolves correctly on its own
   ▼
Anthropic API  → writes entry.message.model into the JSONL = GROUND TRUTH
```

Two independent things must both be right:
1. **Which model actually runs** — `entry.message.model` in the JSONL.
2. **Which context window is active** — `usage_update.size` (the agent reports
   the true window at runtime, sourced from the API's `modelUsage.contextWindow`),
   AND the compaction threshold seam-acp computes from the `CLAUDE_CONTEXT_WINDOWS`
   table via `getClaudeContextWindow()` in `packages/adapters/src/profiles/claude.ts`.

A model can run correctly but get a wrong compaction threshold if its window is
missing from `CLAUDE_CONTEXT_WINDOWS` (falls through to the conservative 200K
default). Check both.

---

## 1. Pull the latest version info

```bash
# Installed versions
claude --version
node -p "require(process.env.HOME + '/.nvm/versions/node/' + process.version + '/lib/node_modules/@agentclientprotocol/claude-agent-acp/package.json').version"

# Latest published versions
npm view @anthropic-ai/claude-code version
npm view @agentclientprotocol/claude-agent-acp version

# Full version history for the wrapper (to see how many releases you're behind)
npm view @agentclientprotocol/claude-agent-acp versions --json
```

If either is behind, **do not update yet** — read the changelogs first (§2).

---

## 2. Read the changelogs and report findings

Sources:
- Claude Code CLI changelog: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- claude-agent-acp changelog: https://github.com/agentclientprotocol/claude-agent-acp/blob/main/CHANGELOG.md
- Version detection (JSON): https://registry.npmjs.org/@anthropic-ai/claude-code (check `dist-tags.latest`)
  and https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp
- Model/platform docs: https://platform.claude.com/docs/en/about-claude/models/overview.md
- Model config / effort docs: https://code.claude.com/docs/en/model-config.md
- Claude Code overview: https://code.claude.com/docs/en/overview.md
- Claude Code changelog: https://code.claude.com/docs/en/changelog.md
- Pricing: https://platform.claude.com/docs/en/about-claude/pricing.md
- System prompts / release notes: https://platform.claude.com/docs/en/release-notes/system-prompts.md

> **Agent readability:** All sources above return **clean markdown** suitable for
> agent-driven scanning. The Anthropic docs sites (platform.claude.com,
> code.claude.com) serve raw markdown when the URL ends in `.md` — the SPA pages
> (without `.md`) are NOT readable via HTTP fetch. Always use the `.md` suffix.
>
> **Discovery indexes** (list every available `.md` page):
> - https://platform.claude.com/docs/llms.txt
> - https://code.claude.com/docs/llms.txt

For the version range between **installed** and **latest**, scan for and
explicitly report on each of these categories:

| Category | What to look for | Why it matters here |
|---|---|---|
| **New models** | New Opus/Sonnet/Haiku versions, new full IDs | The picker (`CLAUDE_MODELS`) must be updated AND re-verified |
| **Model config option / resolver** | changes to the `"model"` `SessionConfigSelect`, `setSessionConfigOption`, `resolveModelPreference`, advertised `availableModels`, or the exact-match-before-fuzzy order | Highest-risk category: this is how models are selected in 1.x. A regression here can reject full IDs or re-introduce cross-family fuzzy matching. |
| **Effort defaults** | New default effort per model, new tiers (`xhigh`, `max`, `ultra`) | Unset effort uses the model default; a default change silently alters behavior |
| **Context window** | new model windows, 1M support, auto-upgrade rules | Drives compaction threshold (`CLAUDE_CONTEXT_WINDOWS`) and cost |
| **Compaction** | auto-compact thresholds, `compactionControl` shape | We pass `compactionTokenThreshold`; the API contract could change |
| **ACP protocol** | new `_meta` fields, `UsageUpdate` shape, config-option semantics, schema version bumps | Our `getUsage`/status-card and model-selection plumbing depend on these |
| **Tool signatures** | new params on built-in tools (e.g. image aspect ratio) | Could unlock features currently worked around |

**Deliverable**: a short written report, one bullet per relevant change, each
tagged with an action: `NO-OP`, `RE-VERIFY MODELS`, `UPDATE PICKER`,
`UPDATE CODE`, or `INVESTIGATE`.

---

## 3. Update safely

```bash
npm install -g @anthropic-ai/claude-code@latest @agentclientprotocol/claude-agent-acp@latest

# Confirm
claude --version
node -p "require(process.env.HOME + '/.nvm/versions/node/' + process.version + '/lib/node_modules/@agentclientprotocol/claude-agent-acp/package.json').version"
```

- The binaries are looked up on PATH and spawned fresh per session, so a
  seam-acp restart is **not strictly required** — new turns pick up the new
  version. Run `npm run redeploy` if you want every runtime cycled immediately.
- **Confirm the freshly-installed package is pristine.** We no longer patch the
  package, so a clean install should always report PRISTINE — a MODIFIED result
  now means something else tampered with it and should be investigated. Run:
  ```bash
  cd /tmp && npm pack @agentclientprotocol/claude-agent-acp@$(npm view @agentclientprotocol/claude-agent-acp version) >/dev/null 2>&1
  tar xzf agentclientprotocol-claude-agent-acp-*.tgz
  PKG=$(npm root -g)/@agentclientprotocol/claude-agent-acp
  diff -rq /tmp/package/dist "$PKG/dist" && echo "PRISTINE" || echo "MODIFIED — investigate"
  ```
- Also bump the `@agentclientprotocol/sdk` dependency in both workspace manifests
  if the SDK moved (we currently pin `^1.4.0`); run `npm install`, `npm run typecheck`, and
  `npm run build`.

**After ANY update, treat every model entry as unverified until §4 passes.**
Model-resolution behavior has regressed across releases before.

## 3a. Local resolver patch — RETIRED at 0.54.1 (do not re-apply)

**There is no patch anymore.** The former local patch
(`scripts/patch-claude-agent-acp.mjs` / `npm run patch-acp`) has been **deleted**.
Any older instruction to "run `npm run patch-acp`" or "re-apply the patch after a
global update" is now WRONG.

**Why it's gone.** The patch existed to work around a resolver in the old
`unstable_setSessionModel` RPC that fuzzy-matched full IDs to the wrong model. In
0.54.1 that RPC no longer exists (model selection is now
`setSessionConfigOption({ configId: "model", value })`), and the config-option
handler **exact-matches the requested value against the agent's advertised model
list BEFORE calling `resolveModelPreference`**. So an advertised full canonical ID
resolves to itself and the fuzzy resolver is only a fallback for aliases — the
exact behavior the patch used to force, now upstream. The patch's anchor
(`resolveModelPreference` inside `unstable_setSessionModel`) is also simply gone,
and a global `npm i -g` would wipe any local edit anyway. Nothing to re-apply,
nothing to re-derive on a routine update.

**Current escape hatch is part of the profile.** An un-advertised full ID can be
rejected with `Invalid value for config option model` in a raw wrapper session.
The Seam Claude profile therefore forwards canonical selected IDs via
`ANTHROPIC_MODEL` (adds the ID to `availableModels` + selects it). Preserve and
re-test this behavior whenever the wrapper changes.

---

## 4. Prove what's actually happening (the core probe)

This is the heart of the runbook. It bypasses everything and reads the API's own
output via JSONL + the ACP `usage_update` stream. **Self-reporting ("what model
are you?") is NOT acceptable evidence — models report themselves wrong.**

Save as `/tmp/probe-models.mjs`:

```javascript
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

// Edit this list to whatever you need to verify (bare full IDs — no `[1m]`):
const MODELS = [
  "default",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-fable-5",
  "claude-sonnet-5",
];

async function probe(modelId) {
  const child = spawn("claude-agent-acp", [], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = ""; let nextId = 1; const pending = new Map(); const notes = [];
  child.stdout.on("data", d => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === "session/update") notes.push(m.params);
    }
  });
  child.stderr.on("data", () => {});
  const call = (method, params) => { const id = nextId++; return new Promise(r => { pending.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }); };

  await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: false } });
  const s = await call("session/new", { cwd: "/tmp", mcpServers: [] });
  const sid = s.result.sessionId;
  // Model selection is a session config option, not the old
  // unstable_setSessionModel RPC. An un-advertised full ID may be REJECTED here
  // with `Invalid value for config option model` — capture that instead of hanging.
  const setRes = await call("session/set_config_option", { sessionId: sid, configId: "model", value: modelId });
  const setModelError = setRes.error ? setRes.error.message : null;
  notes.length = 0;
  await call("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "ok" }] });

  // Wait for clean exit so the JSONL is fully flushed before we read it.
  const exit = new Promise(r => child.once("exit", r));
  child.stdin.end();
  await Promise.race([exit, new Promise(r => setTimeout(r, 6000))]);

  // GROUND TRUTH: the API-written model id in the JSONL.
  let apiModel = "NONE";
  try {
    const dir = path.join(os.homedir(), ".claude", "projects", "-tmp");
    const lines = (await fsp.readFile(path.join(dir, `${sid}.jsonl`), "utf8")).split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const e = JSON.parse(lines[i]);
      if (e.type === "assistant" && e.message?.model) { apiModel = e.message.model; break; }
    }
  } catch {}

  // Active context window from the ACP usage stream (sourced from API modelUsage).
  const sizes = [...new Set(notes.filter(n => n.update?.sessionUpdate === "usage_update").map(n => n.update.size))];
  const window = Math.max(0, ...sizes) >= 1_000_000 ? "1M" : (Math.max(0, ...sizes) / 1000) + "K";
  return { requested: modelId, apiModel, window, allSizes: sizes, setModelError };
}

for (const m of MODELS) {
  const r = await probe(m);
  const err = r.setModelError ? "  ⚠ set_config_option REJECTED: " + r.setModelError : "";
  console.log(r.requested.padEnd(24), "→ API:", String(r.apiModel).padEnd(24), "window:", r.window, " sizes:", r.allSizes.join(",") + err);
}
```

Run it:
```bash
timeout 300 node /tmp/probe-models.mjs 2>/dev/null
```

**How to read the output — a model entry is VERIFIED only if ALL hold:**
1. `set_config_option` was NOT rejected (no `⚠ ... REJECTED` on the line). A
   rejection with `Invalid value for config option model` means the full ID is
   not advertised on this account and cannot be selected as-is — see the account
   caveat in §5 for the fix.
2. `API model` matches the model you intended (e.g. `default` → `claude-opus-5`,
   NOT a different family).
3. `window` matches the expected model capability, AND `getClaudeContextWindow`
   returns the same value for that ID (§6). A 1M model whose ID is missing from
   `CLAUDE_CONTEXT_WINDOWS` would seed a
   200K compaction threshold.
4. `sizes` shows the expected window; a 1M model typically shows `200000,1000000`
   (the agent's runtime `UsageUpdate.size` overwriting the 200K default — see §4a).

### 4a. Cross-check the window with the raw CLI (authoritative)

The ACP `usage_update.size` is **not always authoritative**. claude-agent-acp
starts every session at `DEFAULT_CONTEXT_WINDOW = 200000` and only overwrites it
when the API's `modelUsage.contextWindow` comes back. If that overwrite doesn't
fire (some turns), `size` stays at the **200K default guess** — which looks
identical to a model that's genuinely 200K. Tell them apart by the `sizes`
column: a real 1M model shows `200000,1000000` (overwrite fired); a value that
only ever shows `200000` is **unproven** — it could be a 1M model whose overwrite
never fired.

To get the real window independent of the wrapper, ask the **raw Claude Code
CLI**, which computes the window from genuine model metadata:

```bash
for m in claude-fable-5-1 claude-opus-5 claude-opus-4-8 claude-opus-4-7 claude-fable-5 claude-sonnet-5; do
  echo "=== $m ==="
  timeout 40 claude --model "$m" -p "/context" 2>/dev/null | grep -iE "Model:|Tokens:"
done
```

`/context` prints e.g. `**Tokens:** 23.6k / 200k (12%)` — the denominator is the
authoritative window. **A window claim is only proven when the raw CLI `/context`
agrees with it.**

**Known traps to re-confirm every time:**
- `opus`, `best` → fuzzy-resolve to a **different family**. Never put an alias
  that fuzzy-matches in the picker; use the bare full ID or `default`.
- **Raw un-advertised full IDs may be REJECTED** by `setSessionConfigOption`.
  The Seam profile's `ANTHROPIC_MODEL` forwarding is required for the full-ID
  picker rows and must be active in the probe.
- A 1M model whose window is **missing from `CLAUDE_CONTEXT_WINDOWS`** makes seam-acp
  compute a **200K compaction threshold** → premature compaction. Add it to the
  table (§6). The `[1m]` suffix is retired and does NOT influence this — the table
  is the single source of truth.
- `default` → correct model + 1M window; `getClaudeContextWindow` special-cases it
  to 1M (it does — verify §6).

---

## 5. Update the list of model choices

The picker is `CLAUDE_MODELS` in `.env`, comma-separated `modelId:Label` pairs.
`CLAUDE_DEFAULT_MODEL` is the model new threads start on.

Rules (enforced by §4 evidence, not by intuition):
- **Bare full IDs only — no `[1m]` suffix.** The suffix is retired; window is a
  property of the model, declared in `CLAUDE_CONTEXT_WINDOWS` (§6), not the string.
  Current picker: `claude-fable-5-1`, `claude-opus-5`, `claude-opus-4-8`,
  `claude-opus-4-7`, `claude-fable-5`, and `claude-sonnet-5`, plus the
  `default` alias.
- **One entry per model.** No trap variants, no redundant pairs.
- **`default`** → the auto-rolling "latest Opus @ 1M" entry (Max tier); the proven
  path (always advertised).
- **Full IDs are subject to the account caveat.** A raw session may reject an
  un-advertised full ID. Seam's profile forwards canonical full IDs through
  `ANTHROPIC_MODEL`; §4 must exercise that path and confirm both JSONL model and
  context window before a new row is admitted.
- Do not add fuzzy-matching aliases like `opus`/`best`.
- Label format: `Name` (+ `⭐` for the recommended default). All admitted models
  are native 1M, so context-window labels are intentionally omitted.

After editing `.env`, **re-run §4** for every entry you added or changed. Then
update the compaction table if needed (§6) and deploy:
```bash
npm run redeploy
```

If you removed or renamed a model that existing sessions point at, migrate the
DB (§9).

---

## 6. Verify the compaction threshold (the silent trap)

`getClaudeContextWindow(modelId)` in `packages/adapters/src/profiles/claude.ts` decides the
window used to compute the auto-compaction threshold (`newSessionMeta`), and — via
`withClaudeContextLimits` — the `contextLimit` stamped on every picker entry (the
orchestrator's `staticModels[].contextLimit → modelContextFloor` seed). If it
returns 200K for a model that's actually 1M, Claude Code compacts at
`0.8 × 200K = 160K` and throws away 840K of usable context. (The agent also
reports the true window at runtime via `UsageUpdate.size`, which refines the
display once a turn completes — but the compaction threshold is computed up front
from this table, so the table must be right.)

The window is resolved by an **exact-match table** (`CLAUDE_CONTEXT_WINDOWS`) and
a `default` → 1M special case. Unknown models conservatively fall back to 200K.
For **every** model in `CLAUDE_MODELS`, confirm `getClaudeContextWindow`
returns the same window §4 proved — call the real exported function so the check
can't drift from the implementation:

```bash
node -e '
require("tsx/cjs");
const { getClaudeContextWindow } = require("./packages/adapters/src/profiles/claude.ts");
for (const m of ["default","claude-fable-5-1","claude-opus-5","claude-opus-4-8","claude-opus-4-7","claude-fable-5","claude-sonnet-5"]) {
  console.log(m.padEnd(24), "→ compaction window:", getClaudeContextWindow(m));
}
' 2>/dev/null || echo "(no tsx loader? import from the built dist/ instead, or read CLAUDE_CONTEXT_WINDOWS directly)"
```

Each line must equal the §4 `window`. If a 1M model shows 200K here, **add it to
the `CLAUDE_CONTEXT_WINDOWS` table** in `claude.ts`, rebuild, and re-run.

---

## 7. Test NEW sessions apply the model correctly

The orchestrator calls `AgentRuntime.setModel(cfg.model)` after `newSession`
(which now issues `setSessionConfigOption({ configId: "model", value })` under
the hood — the old `unstable_setSessionModel` RPC is gone). To prove a fresh
thread runs the intended model:

1. Create a new Discord thread (or `/seam new`) and set the model via `/seam model`.
2. Send one real message.
3. **Read the status card** — the Model field shows the *resolved* API model id
   (we capture `entry.message.model`, timestamp-filtered to the current turn).
   It must read e.g. `claude-opus-5 (default)`, never an older or different family.
4. Cross-check from the server against the JSONL directly:
   ```bash
   # slug = cwd with / → - ; find the newest assistant model for that session id
   SID=<acp_session_id_from_db>
   SLUG=$(echo "<cwd>" | sed 's#/#-#g')
   node -e '
   const fs=require("fs"),p=process.env.HOME+"/.claude/projects/'"$SLUG"'/'"$SID"'.jsonl";
   const L=fs.readFileSync(p,"utf8").split("\n").filter(Boolean);
   for(let i=L.length-1;i>=0;i--){const e=JSON.parse(L[i]);if(e.type==="assistant"&&e.message?.model){console.log("API model:",e.message.model);break;}}
   '
   ```

The status card and the JSONL must agree, and both must match what you set.

---

## 8. Test RESUMED sessions keep the model

This is the historically fragile path: `loadSession` must re-apply the model
(Claude Code does not persist the per-session model across subprocess restarts).
The fix lives in `AgentRuntime.loadSession` (re-applies `opts.model` via
`setModel`). To prove it still works:

1. On an existing thread with a known non-default model set, run one turn and
   confirm the resolved model on the card.
2. Force a runtime restart so the next turn goes through `loadSession`:
   `npm run redeploy` (drains turns, then restarts), or `/seam abort` then a new
   message, or just wait for an idle eviction.
3. Send another message. The status card's resolved model MUST be unchanged.
4. If it reverted to the default, `loadSession` is not re-applying — inspect
   `AgentRuntime.loadSession` and the `setModel` call (now the config-option RPC).
   Note: if the model was rejected as un-advertised (account caveat, §5), the turn
   may fall back to `default` here too — check the runtime logs for
   `Invalid value for config option model`.

**Shared-session caveat:** the seam-acp dev thread (`bdf3a481-…`) shares its
JSONL with the interactive Claude Code session you talk to. `getUsage` filters
JSONL entries by `newerThanMs = turnStartedAt` to avoid reading the interactive
session's entries. When verifying by hand, always timestamp-filter or use a
dedicated test thread that nothing else writes to.

---

## 9. Confirm existing sessions keep working (migrations)

When you change `CLAUDE_MODELS` (rename/remove a value) or fix a resolver bug,
existing rows in `sessions.config_json` may still point at a stale/broken model.

Audit:
```bash
node -e '
const D=require("./node_modules/better-sqlite3");
const db=new D("./data/seam.db",{readonly:true});
for(const r of db.prepare("SELECT id,config_json FROM sessions WHERE agent_id LIKE ?").all("%claude%")){
  console.log(r.id.slice(-19), "→", JSON.parse(r.config_json||"{}").model);
}
db.close();
'
```

Migrate any broken/removed values to a verified one (adjust the `broken` list and
target):
```bash
node -e '
const D=require("./node_modules/better-sqlite3");
const db=new D("./data/seam.db");
// Removed picker values should migrate to the always-advertised proven path.
const broken=["opus","best","claude-opus-4-6","claude-sonnet-4-6","claude-haiku-4-5"];
const target="default";
let n=0;
for(const r of db.prepare("SELECT id,config_json FROM sessions WHERE agent_id LIKE ?").all("%claude%")){
  const c=JSON.parse(r.config_json||"{}");
  if(broken.includes(c.model)){
    c.model=target; delete c.lastContextUsage;
    db.prepare("UPDATE sessions SET config_json=?,updated_utc=? WHERE id=?")
      .run(JSON.stringify(c,null,2),new Date().toISOString(),r.id);
    console.log("migrated",r.id.slice(-19),"→",target); n++;
  }
}
console.log("migrated",n,"sessions"); db.close();
'
```

**Migration safety notes:**
- Do migrations while the process is **stopped/restarting** so a concurrent
  `persistConfig` write can't race and re-stamp the old value. (A live request
  has rewritten a just-migrated row before — confirm with §9 audit after deploy.)
- Always clear `lastContextUsage` when changing the model — it was measured under
  the old model and would seed the panel with a mismatched window.
- After `npm run redeploy`, re-run the audit to confirm nothing reverted.

If code changes (not just config) are needed for old sessions to keep working,
verify the resume path (§8) on a real pre-existing thread before considering it
done — a clean build is not proof.

---

## 10. Definition of done

A model-management change is complete only when:
- [ ] Versions pulled and changelogs reported with tagged actions (§1–§2)
- [ ] Update applied; package confirmed pristine on the fresh install (§3)
- [ ] No patch to re-apply — the local resolver patch was retired at 0.54.1 (§3a).
      A MODIFIED pristine check now means unexpected tampering, not our patch.
- [ ] §4 probe shows every picker entry resolves to the intended API model +
      window AND `set_config_option` was NOT rejected (account caveat, §5)
- [ ] §4a raw-CLI `/context` cross-check agrees with every window claim
- [ ] §6 confirms the compaction window matches for every entry
- [ ] §7 a new session shows the correct resolved model on the card AND in JSONL
- [ ] §8 a resumed session keeps its model across a runtime restart
- [ ] §9 DB audited; no session points at a broken/removed model; no post-deploy revert
- [ ] §11 if effort touched: valid levels verified in JSONL `effort` ground truth
- [ ] The status card shows the resolved API model id + effort on every turn (regression alarm)

The status card's resolved-model + effort display is the standing safety net: if
any of the above silently regresses later, it shows up there on the very next
turn instead of costing you days of wrong-model / wrong-effort work.

---

## 11. Reasoning effort

Effort (`low|medium|high|xhigh|max`) has two supported upstream paths in
claude-agent-acp 0.73.0: the wrapper's `effort` session config option and the SDK
query option named `effort`. Seam uses the query option so the stored thread
configuration is applied identically to new and resumed sessions.

**The one working injection point (pure seam-acp, no wrapper patch):**
`_meta.claudeCode.options.effort` at `session/new`. The wrapper spreads
`sessionMeta.claudeCode.options` straight into the SDK query `Options`, and the
SDK has an `effort` field. seam-acp builds
this in `claude.ts` `newSessionMeta(model, effort)`, alongside `compactionControl`.
The value is threaded from `cfg.reasoningEffort` through `session-router` →
`AgentRuntime.newSession`/`loadSession` → `newSessionMeta`. `/seam effort` saves
it and invalidates the runtime so the next turn rebuilds the session with the new
effort baked into `_meta`.

**Why this path and not a wrapper patch:** it's our own code and survives every
wrapper update untouched. (The model path is also patch-free now — the local
resolver patch was retired at 0.54.1, §3a — so neither model nor effort needs any
re-apply step after an update.)

**Verification (the deterministic test):** create a session with each valid
effort via `_meta`, run a real prompt, then read the newest assistant JSONL entry.
The top-level `effort` field is the applied value after model support and account
policy are resolved:

```javascript
// session/new with _meta: { claudeCode: { options: { effort: "<value>" } } }
// session/prompt ...
// ~/.claude/projects/<cwd>/<sessionId>.jsonl:
//   { type: "assistant", message: { model: "claude-opus-5", ... }, effort: "xhigh" }
```
(Run the full probe in `/tmp/probe-effort-final.mjs` — see git history of this
work, or reconstruct from the snippet above.)

**Valid levels are bounded by the bundled SDK, not the wrapper.** The SDK's
`EffortLevel` type is the source of truth:
```bash
SDK=$(npm root -g)/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk
grep -n "EffortLevel =" "$SDK/sdk.d.ts"
```
As of SDK 0.3.257 (bundled inside claude-agent-acp 0.73.0):
`'low' | 'medium' | 'high' | 'xhigh' | 'max'`.
**`ultra` is NOT in the SDK** (even latest) — it appears to be interactive-CLI
branding, not exposed programmatically. The SDK is *bundled inside*
claude-agent-acp, so it can't be updated independently; `ultra` arrives only when
a new wrapper bundles a new SDK that adds it. Keep `/seam effort` choices in sync
with `EffortLevel` (`packages/core/src/platforms/discord/commands.ts`).

**Unsupported-but-valid levels** (e.g. `xhigh` on a model that tops out at `high`)
fall back to the highest supported level per Claude Code's documented behavior.
Do not use a bogus string as a wiring oracle: SDK 0.3.257 no longer rejects one
at `session/new`; the JSONL `effort` field is the authoritative check.

---

## 12. Fast mode (#37)

**Fast is a serving mode for the model you already selected.** It is not another
model, not an effort level, and there are no synthetic `-fast` slugs. It trades
cost efficiency for latency and it **spends usage credits outside subscription
limits** — the only dimension in this runbook that can cost real money per turn.

Seam therefore exposes it as its own explicit, opt-in, per-thread
**session-start** setting. Default off. It never rides along on a model pick.

### 12.1 API surface

- **ACP config id:** `fast` (not `fast_mode`).
- **Shape:** a `select`, values **`on` / `off`** (not `true` / `false`), with
  `currentValue` reported on the session.
- **Applied with:** `setSessionConfigOption({ sessionId, configId: "fast", value })`.
- **Environment kill switch:** `CLAUDE_CODE_DISABLE_FAST_MODE=1`. When set the
  wrapper **omits the option entirely** — there is no "present but disabled"
  state to detect.

### 12.2 Eligible models — never infer from the slug

Fast support is a property of the **live session's `configOptions`**, not of the
string you asked for. Verified 2026-09-03 with the zero-token probe
(`node scripts/claude-fast-mode-probe.mjs --clean-env`, claude-agent-acp 0.73.0):

- `claude-opus-5` — resolved to `opus[1m]`; **advertises** `fast`
  (`select`, `[on|off]`, current `off`); `set on` ✓ and `set off` ✓.
- `claude-opus-4-8` — resolved to itself; **advertises** `fast`, same shape,
  both values accepted.
- `claude-sonnet-5` — resolved to `sonnet`; **does not advertise** `fast`
  (config ids: `mode, model, effort`).
- `default` — **an alias, resolved by the wrapper at session start.** It has
  been observed **both ways**: advertising `fast` when it resolved to Opus 5,
  and not advertising it when it resolved to `sonnet` (the 2026-09-03 runs).
  This is the single most important reason nothing in the code may key Fast off
  a slug. Ask the session, every time.
- `CLAUDE_CODE_DISABLE_FAST_MODE=1` + `claude-opus-5` — **does not advertise**
  `fast`. The kill switch is indistinguishable from an ineligible model at the
  protocol level, which is why Seam checks the env var separately so it can give
  an *actionable* refusal instead of "this model doesn't support Fast".

> **Run the probe from a clean shell.** Invoked from inside a Claude Code
> session it inherits `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` /
> `CLAUDE_CODE_*`, which pm2 never sets. `--clean-env` strips them. The probe
> also prints the **resolved** model, without which an alias result proves
> nothing — that omission is exactly what produced a contradictory reading the
> first time this was measured.

### 12.3 Cost and reset semantics

Enabling Fast **inside an established conversation may charge the whole
accumulated context at Fast rates.** Seam therefore refuses to apply Fast to a
session that already has history:

- `fastMode` is applied **only in `AgentRuntime.newSession`**, never in
  `loadSession`. A resumed session is *observed* (its advertised `currentValue`
  is read) but never re-set.
- Changing the setting **forces a fresh ACP session** before it applies:
  `detectSessionReset` returns `resetReason: "fast-mode-switch"`, the config
  editor's Save clears the stored `acpSessionId`, and `configure_thread` forges
  a replacement session.
- Every confirmation states both facts: context was reset, and Fast bills paid
  usage credits.
- **Off is silent on the wire.** A thread that never asked for Fast issues no
  `set_config_option` at all; `off` is written explicitly only when a session
  came up `on`.
- **An unverifiable enable is discarded, not assumed off.** `applied` is read
  back from the echoed `configOptions` (a resolved RPC is not proof — upstream
  carries a `fast_mode_disabled_reason` for toggles that snap back). If the
  response echoes nothing, the state is `null` (undetermined), **not** `off`:
  the session may genuinely be serving and billing Fast. Both mutation surfaces
  then roll the flag back *and* retire that just-forged session, so the next
  turn starts clean with Fast off. Only a positively observed `off` keeps the
  session. Nothing may claim a session is Fast-free without observing it.
- **A failed retirement is critical, not a warning.** If that retirement itself
  fails, a possibly-billing session is still live: `configure_thread` fails the
  whole call, and the config card turns red with a `🚨` footer instead of a calm
  "Saved". Both name the recovery: `/seam config reset` in that thread before
  the next turn.

### 12.4 Where it lives

- Storage: `channel-presets.json` → `threads.<id>.fastMode` (raw boolean).
  **Thread-only** — a channel-level `fastMode` is rejected by
  `ChannelPresetSchema` so a channel pin can never bill every sibling thread.
- Resolution: `describeConfig().fastMode` (`ResolvedSetting<boolean>`).
- Eligibility: `AgentProfile.fastMode` (Claude only, and only for
  direct-Anthropic backends — a Claude harness pointed at Ollama/Z.ai via
  `ANTHROPIC_BASE_URL` declares none).
- Policy: `packages/core/src/core/fast-mode.ts`; wire constants:
  `packages/adapters/src/fast-mode.ts`.
- Surfaces: `/seam config edit` (Fast button), `configure_thread` MCP
  (`fastMode`), `config_describe`, `threads()`, the confirmation card, the
  status card footer (`⚡ fast …`), and the config audit trail.

### 12.5 Verification boundary — do not spend credits casually

The probe above proves **advertisement and acceptance** and costs nothing.
Proving a completion was actually *served* in Fast mode requires a **paid**
usage-credit turn and inspection of the resulting `fast_mode_state`. Do not run
that without explicit authorization from the account owner; note in any report
which of the two you actually did.
