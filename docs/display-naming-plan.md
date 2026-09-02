# Display naming — emoji + short-name standard for renderable entities

**Status:** SUPERSEDED — historical record only · **Created:** 2026-06-05 ·
**Updated:** 2026-09-02 · **Owner:** jbulpitt

> Superseded by the data-driven thread namer shipped in #145/#146. Thread name
> prefixes are now computed from configurable agent/model/role symbol tables
> plus a role-local ordinal, and `AgentProfile.threadAbbr` no longer exists.
> See `packages/core/src/platforms/discord/thread-namer.ts` and the
> "Reading a thread name" section of `docs/agent-guides/model-intelligence-and-thread-control.md`.
> Do not implement from this document.

Every named entity the UI shows (agent, model, host/bridge, workspace/cwd, effort, …)
needs a compact **display identity** — emoji and/or short text — or the Discord UI
drowns in token/information overload. Today this is ad-hoc; make it a standard.

> **Legend** — `[idea]` · `[research]` · `[decided]` · `[blocked]` · `[done]`.

---

## 1. Problem
Raw ids, full paths, and long model names overwhelm humans. Today's mechanisms are
scattered and inconsistent, with no shared concept and no fallback:
- `AgentProfile.threadAbbr` (e.g. 👾, 🦙) — agents only.
- `REPO_EMOJIS` config map (repo → emoji) — repos only, central, manual.
- Model emoji baked into names by hand (e.g. `gemma-4-26b-a4b 🦙`).
- No per-host story — and cwd names live on *other machines* once the bridge exists.

## 2. Principle (the standard)
Every renderable entity resolves through **one** function to a `Display`:
```
Display = { emoji?: string, short: string, full: string }
resolveDisplay(kind, id, ctx) -> Display      // ALWAYS returns a valid Display
```
- `kind` ∈ `agent | model | host | workspace | effort | …` (extensible).
- **The renderer only ever uses `resolveDisplay`** — it never prints a raw id/path.
  This single chokepoint is what makes it a *standard* (and makes the fallback safe,
  §5).

## 3. Resolution precedence (first hit wins)
1. **Override** — user-set, live-editable (`/seam name <kind> <id> <emoji> <short>`),
   stored in seam-acp DB keyed by `(kind, id)`. Quick tweaks, no file edits.
2. **Declared default** — the entity ships its own: agents/models in code/registry,
   hosts in bridge config.
3. **Host-defined** — host-local entities (workspaces/cwd) read from a per-host file
   (`.seam`, §4.1) by the agent adapter, which runs *at the host*.
4. **Derived fallback** — deterministic, never empty (§5).

## 4. Where each kind's names live
| Kind | Source of truth | Notes |
|---|---|---|
| agent | **code** (adapter/profile `display`) | generalize `threadAbbr` → `{emoji,short}` |
| model | **model registry** / `staticModels` entry | add `emoji?` / `short?` fields |
| host / bridge | **bridge config** | the machine emoji (selection prefix); `local` gets one too (e.g. 🏠) |
| workspace / cwd | **per-host `.seam` file** | host-local + user-owned → co-locate (§4.1) |
| *any* | **DB override** | live edit via slash command (precedence tier 1) |

### 4.1 The `.seam` file (host-local cwd names)
- One file per host workspace root (start with **one root/host** — see bridge spec
  D11): e.g. `<root>/.seam/display.json` (a dir leaves room to grow; a flat
  `.seam.json` is also fine).
- Schema — simple, hand-editable:
  ```json
  { "workspaces": {
      "seam-acp":          { "emoji": "🧵", "short": "seam" },
      "some-long-folder":  { "emoji": "📦", "short": "core" }
  } }
  ```
- **Read at the host** by the adapter's `listWorkspaces()`, which returns each path
  *with* its `Display`. seam-acp never guesses a remote folder's name — the host tells
  it. Composes with bridge **D3** (agent-local everything).
- Replaces `REPO_EMOJIS` for the workspace case; `REPO_EMOJIS` can linger as a local
  fallback until migrated.

## 5. Fallback — "what if it's not defined?" (never breaks the UI)
The bottom tier of `resolveDisplay` is **deterministic and total**, so an undefined
entity degrades gracefully instead of dumping a raw token:
- **emoji** = a **kind-default** (agent 🤖 · model 🧠 · host 🖥️ · workspace 📁 ·
  effort ⚙️ · generic 🔖). *Option:* hash the id into a small per-kind emoji palette so
  many undefined entities of the same kind stay visually **distinct and stable**.
- **short** = derived from the id deterministically (workspace → folder basename;
  ids → slug / truncation / initials).
- **stable** — same entity → same fallback every render, so even auto-named things are
  recognizable.
- **discoverable** — log `display: no definition for {kind}:{id}` (debug) and/or show
  a faint marker; defining it later (override / `.seam` / config) just *upgrades* the
  display.

**Guarantees:** the renderer never emits an unresolved id, and **adding a new entity
kind only requires registering one kind-default** — existing render code is untouched.
So "undefined" → "auto-named but consistent," never "broken/overwhelming."

## 6. Composition with the bridge
- **Host emoji** (selection picker prefixes every `agentId@location` with its machine
  emoji, e.g. `🖥️x 🦙 gemma`) comes from **bridge config** — precedence tier 2.
- **cwd names** come from the host's `.seam` via the adapter — tier 3, host-local
  (D3).
- `local` is just another host (bridge **D9** loopback) → it gets a host emoji too.

## 7. Migration / cleanup
Consolidate today's three mechanisms into the resolver, then route all rendering
through `resolveDisplay`:
- `threadAbbr` → agent `display`.
- model emoji-in-name → model entry `emoji/short`.
- `REPO_EMOJIS` → `.seam` workspace files (or keep as a local fallback).

## 8. Open
- `[research]` Exact `.seam` filename/schema; file vs. dir.
- `[research]` Which kinds get DB overrides vs. config-only.
- `[idea]` Are `short` names required unique (per kind / per host)? Likely not —
  display-only; canonical ids are unchanged.
- `[idea]` Emoji palette + hash function for the distinct-fallback option.
- `[idea]` `/seam name …` editing UX.

## 9. Related
- Host emoji + cwd short-names are consumed by the bridge selection UX —
  [seam-bridge-plan.md](./seam-bridge-plan.md) (D10) — and by `listWorkspaces` (D3, §7).
