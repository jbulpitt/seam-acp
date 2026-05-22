# Hypothetical Ideas & Architectural Scratchpad

This file serves as a living document for brainstorming new features, architectural changes, and hypothetical improvements for `seam-acp`.

---

## 1. Thread-Based Context Inheritance (The `/btw` clone)

**Concept:** 
In the native Claude Code CLI, the `/btw` command spawns an ephemeral agent that shares the parent's full conversation context. We can replicate this behavior in Discord by using Threads!

**Current State:** 
`seam-acp` correctly detects Discord threads and maps them to unique `channel.id` values. However, it spins up a completely blank agent session for them, ignoring the parent channel's history.

**Proposed Implementation:**
When `seam-acp` creates a session for a Thread, it should "fork" the parent session's context rather than starting fresh.
1. **Detection:** When `router.ensureSessionRecord()` detects a `parentRef` (meaning it's a thread), it queries the SQLite store to find the parent channel's `acpSessionId`.
2. **Context Cloning:** 
   - *Option A (Bridge layer):* `seam-acp` manually copies the parent's Claude Code history file on disk to a new file before booting the thread's agent.
   - *Option B (Protocol layer):* We extend the Agent Client Protocol (ACP) `session/new` payload to accept a `parentSessionId` parameter, allowing the ACP adapter (`claude-agent-acp`) to handle the duplication natively in memory or on disk.

**Benefit:** 
Users can branch off "what-if" tangents or ask side-questions in Discord threads without polluting the main channel's context or having to re-explain the entire project state.

---

## 2. Session Manager (Agent-Specific Slash Command)

**Concept:**
A `/sessions` or `/manage-sessions` slash command that acts as a powerful, agent-specific session manager. It would allow users to visually browse, manage, and recover recent sessions directly from Discord.

**Proposed Functionality:**
1. **Load & Summarize:** Query the underlying agent's session store (e.g., Claude Code's local history directory), load the most recent sessions, and use an LLM (or heuristics) to generate a brief summary of what each session was working on.
2. **Interactive UI:** Present the sessions using Discord's `StringSelectMenuBuilder` or interactive buttons.
3. **Actions:**
   - **Attach:** Hot-swap the current Discord channel's session with a selected historical session.
   - **Clone:** Duplicate a historical session into a new session ID for the current channel (similar to the Thread-based context inheritance).
   - **Recover/Rewind:** If a session is bricked by a bad turn (e.g., "Prompt is too long"), "rewind" it cleanly using a `clone > modify > attach` pipeline. By cloning the file, slicing the last $N$ turns from the clone, and then attaching the fresh clone, we avoid modifying active/locked files entirely!
   - **Delete:** Permanently purge a session from the agent's history. *(Caveat: If the session file is currently locked by an active agent process, we simply catch the filesystem lock and return a friendly Discord error rather than trying to force-kill processes).*

**Challenges:**
- Because this relies on modifying the raw history files (or calling specific ACP/Agent endpoints that might not exist yet), the implementation would have to be highly agent-specific (e.g., a Claude Code adapter vs. a Copilot adapter).
- The bridge would need to safely parse and mutate the agent's proprietary history format (like `messages.json` or an SQLite DB) without corrupting it.

---

## 3. [Add future ideas here...]
