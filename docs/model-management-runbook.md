# Model Management Runbook

A repeatable, **empirical** process for keeping the Claude model selection in
seam-acp correct. The governing principle of this document: **never trust a
model's self-report, an alias name, a label, or an assumption. Verify against
JSONL ground truth.** Every claim about "what model is running" or "what context
window is active" must be proven by reading the API's own output, not by asking
the model or trusting the string we passed in.

This exists because the `claude-agent-acp` wrapper reimplements model-alias
resolution in a way that is **inconsistent and silently wrong** for some inputs
(e.g. `opus[1m]` has resolved to Sonnet; `claude-sonnet-4-6[1m]` silently gives a
200K window). We carry a one-line local patch (`scripts/patch-claude-agent-acp.mjs`,
§3a) that makes full `claude-*` IDs bypass the broken resolver, plus we route
around the still-broken aliases — and we continuously prove the routing with
JSONL probes.

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
   - `.env` — `CLAUDE_DEFAULT_MODEL` and `CLAUDE_MODELS` (the picker values)
   - `src/agents/profiles/claude.ts` — `getClaudeContextWindow()` (compaction
     threshold logic) and `newSessionMeta()` (how `_meta` is built)
   - `src/config.ts` — env var validation, `REMOTE_MAC_MODELS` (remote Copilot
     agent, separate ID format)
   - `scripts/patch-claude-agent-acp.mjs` — the local resolver-bypass patch
4. **The "Current verified picture" table** above — the last-known-good mapping
   of picker values → API models → context windows. Treat it as stale if any
   version has changed since the date shown.

## Current verified picture (last verified 2026-06-01, claude-agent-acp 0.39 + patch)

This table is the *output* of the §4 process, kept here as a quick reference.
**It is not a substitute for re-running §4 after any update** — treat it as stale
the moment you touch versions. "Patch" = requires `npm run patch-acp` applied.

| Picker value | Resolves to (JSONL) | Window | Mechanism |
|---|---|---|---|
| `default` ⭐ | claude-opus-4-8 (auto-rolls) | 1M | alias (Max → latest Opus) |
| `claude-opus-4-8[1m]` | claude-opus-4-8 | 1M | full ID |
| `claude-opus-4-7[1m]` | claude-opus-4-7 | 1M | full ID |
| `claude-opus-4-6[1m]` | claude-opus-4-6 | 1M | full ID (**needs patch**) |
| `claude-opus-4-6` | claude-opus-4-6 | 200K | full ID |
| `sonnet[1m]` | claude-sonnet-4-6 | 1M | alias |
| `sonnet` | claude-sonnet-4-6 | 200K | alias |
| `claude-sonnet-4-6[1m]` | claude-sonnet-4-6 | 1M | full ID (**needs patch**) |
| `claude-sonnet-4-6` | claude-sonnet-4-6 | 200K | full ID |
| `haiku` | claude-haiku-4-5-20251001 | 200K | alias |
| `claude-haiku-4-5` | claude-haiku-4-5-20251001 | 200K | full ID |

**Broken — never put in the picker** (verified to resolve wrong):
`opus`, `opus[1m]`, `best` → Sonnet. Bare `claude-opus-4-8`/`-4-7` → run at 1M
but set a 200K compaction threshold (no `1m` token). Without the patch:
`claude-opus-4-6[1m]` → Sonnet, `claude-sonnet-4-6[1m]` → 200K.

Two non-obvious truths this table encodes:
1. **The `[1m]` suffix is stripped before the API**, so the JSONL model id
   (`claude-opus-4-8`) never shows it. The suffix's real jobs are (a) the
   wrapper's window heuristic and (b) seam-acp's compaction-threshold math
   (`getClaudeContextWindow`). Window correctness depends on the suffix even
   though the API model id doesn't carry it.
2. **Opus 4.7/4.8 are 1M with or without `[1m]` on Max** (auto-upgrade); Opus
   4.6 is 200K unless you pass `[1m]`. So `claude-opus-4-6` and
   `claude-opus-4-6[1m]` are genuinely different windows; the 4.8 pair is not.

---

## 0. Mental model — where things can break

```
seam-acp .env (CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL)
   │  the model string you chose
   ▼
seam-acp DB (sessions.config_json → cfg.model)
   │  setModel(cfg.model) on every newSession AND loadSession
   ▼
claude-agent-acp  ← THE LANDMINE: resolveModelPreference() fuzzy-matches
   │                 your string against a tiny curated list and can pick
   │                 the WRONG model. The [1m] token also drives our
   │                 compaction-threshold math (getClaudeContextWindow).
   ▼
Claude Code CLI  ← resolves correctly on its own; the wrapper is the problem
   ▼
Anthropic API  → writes entry.message.model into the JSONL = GROUND TRUTH
```

Two independent things must both be right:
1. **Which model actually runs** — `entry.message.model` in the JSONL.
2. **Which context window is active** — `usage_update.size` (sourced from the
   API's `modelUsage.contextWindow`), AND the compaction threshold seam-acp
   computes from `getClaudeContextWindow()` in `src/agents/profiles/claude.ts`.

A model can run correctly but get a wrong compaction threshold (the `[1m]`-token
trap). Check both.

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
| **Alias behavior** | "alias", "resolve", "model match", "default" changes | This is exactly what broke `opus[1m]`→Sonnet. Highest-risk category. |
| **Effort defaults** | New default effort per model, new tiers (`xhigh`, `max`, `ultra`) | Unset effort uses the model default; a default change silently alters behavior |
| **Context window** | 1M support, auto-upgrade rules, `[1m]` handling | Drives compaction threshold and cost |
| **Compaction** | auto-compact thresholds, `compactionControl` shape | We pass `compactionTokenThreshold`; the API contract could change |
| **ACP protocol** | new `_meta` fields, `usage_update` shape, `set_model` semantics | Our `getUsage`/status-card plumbing depends on these |
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
- **Confirm the freshly-installed package is pristine** (a clean baseline before
  we apply our patch — §3a). Run this immediately after the `npm i -g`, BEFORE
  patching:
  ```bash
  cd /tmp && npm pack @agentclientprotocol/claude-agent-acp@$(npm view @agentclientprotocol/claude-agent-acp version) >/dev/null 2>&1
  tar xzf agentclientprotocol-claude-agent-acp-*.tgz
  PKG=$(npm root -g)/@agentclientprotocol/claude-agent-acp
  diff -rq /tmp/package/dist "$PKG/dist" && echo "PRISTINE" || echo "MODIFIED — investigate"
  ```

**After ANY update, treat every model entry as unverified until §4 passes.**
Model-resolution behavior has regressed across patch releases before.

## 3a. Re-apply the local resolver patch (REQUIRED after every update)

We carry one local patch to `claude-agent-acp` (`scripts/patch-claude-agent-acp.mjs`).
A global `npm i -g` overwrites the package and **wipes the patch**, so it must be
re-applied after every update.

**What it fixes:** in 0.39, `unstable_setSessionModel` runs every model string
through `resolveModelPreference` against a 4-entry curated list. Full Opus IDs
find no Opus entry and fuzzy-match to Sonnet (e.g. `claude-opus-4-6[1m]` → Sonnet;
`claude-sonnet-4-6[1m]` → silently 200K). The patch makes canonical full IDs
(`/^claude-…(\[1m\])?$/`) **bypass** the resolver and pass straight to
`query.setModel`, which handles them correctly (the raw CLI proves it). Aliases
are untouched. Result: every full ID resolves to exactly itself at the right
window, and Opus 4.6 @ 1M becomes available.

```bash
npm run patch-acp     # idempotent; safe to run anytime
```

- Exit 0 + "already patched" → nothing to do.
- Exit 0 + "applied" → patch went in; **re-verify with §4 before trusting it**.
- Exit 1 + "ANCHOR NOT FOUND" → upstream moved the code. Open
  `scripts/patch-claude-agent-acp.mjs`, re-derive the bypass against the new
  `unstable_setSessionModel`, update ANCHOR/REPLACEMENT, re-run, re-verify.

**Decision record (why we patch despite the maintenance cost):** the patch is a
one-line, exactly-anchored bypass — cheap to re-apply and re-derive. It buys two
things we genuinely want: (1) zero model-resolution ambiguity — every full ID
does exactly what it says; (2) Opus 4.6 @ 1M, which is otherwise unreachable
through the wrapper. The alternative (route around with only the handful of
full IDs that happen to resolve correctly) leaves traps in the picker and no 4.6
1M. Verification work (§4) is required either way, so the patch's only marginal
cost is the re-apply step — which `npm run patch-acp` makes trivial.

**Note:** once patched, the §3 pristine check will (correctly) report MODIFIED.
That's expected. Run the pristine check only on the fresh install, before
`patch-acp`.

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

// Edit this list to whatever you need to verify:
const MODELS = [
  "default",
  "claude-opus-4-8[1m]",
  "claude-opus-4-7[1m]",
  "claude-opus-4-6",
  "sonnet",
  "sonnet[1m]",
  "claude-sonnet-4-6",
  "haiku",
  "claude-haiku-4-5",
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
  await call("session/set_model", { sessionId: sid, modelId });
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
  return { requested: modelId, apiModel, window, allSizes: sizes };
}

for (const m of MODELS) {
  const r = await probe(m);
  console.log(r.requested.padEnd(24), "→ API:", String(r.apiModel).padEnd(24), "window:", r.window, " sizes:", r.allSizes.join(","));
}
```

Run it:
```bash
timeout 300 node /tmp/probe-models.mjs 2>/dev/null
```

**How to read the output — a model entry is VERIFIED only if ALL hold:**
1. `API model` matches the model you intended (e.g. `default` → `claude-opus-4-8`,
   NOT `claude-sonnet-...`).
2. `window` matches the label you plan to show (1M vs 200K).
3. `sizes` does not reveal a problematic flicker you care about (a bare 1M-capable
   Opus ID shows `200000,1000000` — it ends at 1M but seam-acp's compaction
   threshold will be wrong unless the string carries a `1m` token; see §6).

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
for m in claude-opus-4-6 claude-opus-4-6[1m] claude-opus-4-8 claude-opus-4-8[1m]; do
  echo "=== $m ==="
  timeout 40 claude --model "$m" -p "/context" 2>/dev/null | grep -iE "Model:|Tokens:"
done
```

`/context` prints e.g. `**Tokens:** 23.6k / 200k (12%)` — the denominator is the
authoritative window. **A window claim is only proven when the raw CLI `/context`
agrees with it.** (Empirically: bare `claude-opus-4-6` = 200K, `claude-opus-4-6[1m]`
= 1M in the raw CLI — but the wrapper breaks the `[1m]` variant to Sonnet, so 4.6
is 200K-only through our stack.)

**Known traps to re-confirm every time (these have ALL bitten us):**
- `opus`, `opus[1m]`, `best` → resolve to **Sonnet**. Never use.
- `claude-sonnet-4-6[1m]` (full ID) → silently **200K**. For 1M Sonnet use the
  `sonnet[1m]` **alias** only.
- `claude-opus-4-6[1m]` → resolves to **Sonnet**. Opus 4.6 is **200K-only** via
  the wrapper.
- bare `claude-opus-4-8` / `claude-opus-4-7` → run at 1M but, lacking a `1m`
  token, make seam-acp compute a **200K compaction threshold** → premature
  compaction. Use the `[1m]` form.
- `default` → correct model + 1M window, but the string has no `1m` token, so
  `getClaudeContextWindow` MUST special-case it (it does — verify §6).

---

## 5. Update the list of model choices

The picker is `CLAUDE_MODELS` in `.env`, comma-separated `modelId:Label` pairs.
`CLAUDE_DEFAULT_MODEL` is the model new threads start on.

Rules (enforced by §4 evidence, not by intuition):
- **One correct entry per (model, window).** No trap variants, no redundant
  bare/suffixed pairs.
- **Opus 1M** → full ID **with** `[1m]` (`claude-opus-4-8[1m]`). The suffix is
  load-bearing for the compaction threshold.
- **Opus 200K-only models** (e.g. 4.6) → bare full ID.
- **Sonnet 1M** → `sonnet[1m]` **alias** (the only thing that works).
- **Sonnet/Haiku 200K** → alias (`sonnet`,`haiku`) for auto-roll, and/or full ID
  (`claude-sonnet-4-6`,`claude-haiku-4-5`) to pin a version.
- **`default`** → the auto-rolling "latest Opus @ 1M" entry (Max tier).
- Label format: `Name • <window> 🪟` (+ `⭐` for the recommended default). The
  window in the label MUST match the §4-verified window.

After editing `.env`, **re-run §4** for every entry you added or changed. Then
update the compaction map if needed (§6) and deploy:
```bash
npm run redeploy
```

If you removed or renamed a model that existing sessions point at, migrate the
DB (§9).

---

## 6. Verify the compaction threshold (the silent trap)

`getClaudeContextWindow(modelId)` in `src/agents/profiles/claude.ts` decides the
window used to compute the auto-compaction threshold (`newSessionMeta`). If it
returns 200K for a model that's actually 1M, Claude Code compacts at
`0.8 × 200K = 160K` and throws away 840K of usable context.

For **every** model in `CLAUDE_MODELS`, confirm `getClaudeContextWindow` returns
the same window §4 proved:

```bash
node -e '
const re1 = s => /\b1m\b/i.test(s) || /-1m\b/i.test(s);
const reDefault = s => /^default$/i.test(s.trim());
const gcw = s => !s ? 200000 : (re1(s) || reDefault(s)) ? 1000000 : 200000;
for (const m of ["default","claude-opus-4-8[1m]","claude-opus-4-7[1m]","claude-opus-4-6","sonnet","sonnet[1m]","claude-sonnet-4-6","haiku","claude-haiku-4-5"]) {
  console.log(m.padEnd(24), "→ compaction window:", gcw(m));
}
'
```

Each line must equal the §4 `window`. If a 1M model shows 200K here (e.g. a new
alias like `default2`, or a bare 1M Opus ID), **fix `getClaudeContextWindow`**
to recognize it, rebuild, and re-run.

---

## 7. Test NEW sessions apply the model correctly

The orchestrator calls `setModel(cfg.model)` after `newSession`. To prove a fresh
thread runs the intended model:

1. Create a new Discord thread (or `/seam new`) and set the model via `/seam model`.
2. Send one real message.
3. **Read the status card** — the Model field shows the *resolved* API model id
   (we capture `entry.message.model`, timestamp-filtered to the current turn).
   It must read e.g. `claude-opus-4-8 (default)`, never `claude-sonnet-…`.
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
4. If it reverted to the default/Sonnet, `loadSession` is not re-applying —
   inspect `AgentRuntime.loadSession` and the `setModel` call.

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
const broken=["opus","opus[1m]","best","claude-opus-4-6[1m]","claude-sonnet-4-6[1m]"];
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
- [ ] `npm run patch-acp` re-applied and reports success (§3a)
- [ ] §4 probe shows every picker entry resolves to the intended API model + window
- [ ] §4a raw-CLI `/context` cross-check agrees with every window claim
- [ ] §6 confirms the compaction window matches for every entry
- [ ] §7 a new session shows the correct resolved model on the card AND in JSONL
- [ ] §8 a resumed session keeps its model across a runtime restart
- [ ] §9 DB audited; no session points at a broken/removed model; no post-deploy revert
- [ ] §11 if effort touched: verified via _meta injection (bogus rejected, valid accepted)
- [ ] The status card shows the resolved API model id + effort on every turn (regression alarm)

The status card's resolved-model + effort display is the standing safety net: if
any of the above silently regresses later, it shows up there on the very next
turn instead of costing you days of wrong-model / wrong-effort work.

---

## 11. Reasoning effort

Effort (`low|medium|high|xhigh|max`) is **NOT** settable through the obvious ACP
paths — both are traps verified to fail:
- `set_config_option("effort", …)` returns `Internal error`.
- The wrapper never reads a `reasoningEffort` field; only `effort`/`effortLevel`.

**The one working injection point (pure seam-acp, no wrapper patch):**
`_meta.claudeCode.options.effort` at `session/new`. The wrapper spreads
`sessionMeta.claudeCode.options` straight into the SDK query `Options` (verified
at wrapper lines ~1500/1524), and the SDK has an `effort` field. seam-acp builds
this in `claude.ts` `newSessionMeta(model, effort)`, alongside `compactionControl`.
The value is threaded from `cfg.reasoningEffort` through `session-router` →
`AgentRuntime.newSession`/`loadSession` → `newSessionMeta`. `/seam effort` saves
it and invalidates the runtime so the next turn rebuilds the session with the new
effort baked into `_meta`.

**Why this path and not a wrapper patch:** it's our own code, survives every
wrapper update untouched, nothing to re-apply (unlike the model patch in §3a).

**Verification (the deterministic test):** pass a *bogus* effort via `_meta` and
confirm the SDK rejects it, then a valid one and confirm it's accepted. You don't
validate a field you ignore, so rejection of garbage + acceptance of valid levels
proves the value is honored:

```javascript
// session/new with _meta: { claudeCode: { options: { effort: "<value>" } } }
//   effort: "totally-bogus" → session/new ERROR  (proves SDK reads it)
//   effort: "high"          → ok
//   effort: "xhigh"         → ok  (works via _meta even though the wrapper's
//                                  config-option list caps at "max")
```
(Run the full probe in `/tmp/probe-effort-final.mjs` — see git history of this
work, or reconstruct from the snippet above.)

**Valid levels are bounded by the bundled SDK, not the wrapper.** The SDK's
`EffortLevel` type is the source of truth:
```bash
SDK=$(npm root -g)/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk
grep -n "EffortLevel =" "$SDK/sdk.d.ts"
```
As of SDK 0.3.156–0.3.159: `'low' | 'medium' | 'high' | 'xhigh' | 'max'`.
**`ultra` is NOT in the SDK** (even latest) — it appears to be interactive-CLI
branding, not exposed programmatically. The SDK is *bundled inside*
claude-agent-acp, so it can't be updated independently; `ultra` arrives only when
a new wrapper bundles a new SDK that adds it. Keep `/seam effort` choices in sync
with `EffortLevel` (`src/platforms/discord/commands.ts`).

**Unsupported-but-valid levels** (e.g. `xhigh` on a model that tops out at `high`)
fall back to the highest supported level per Claude Code's documented behavior —
they don't error. Truly invalid strings (not in `EffortLevel`) are rejected at
`session/new`.
