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

## 3. [Add future ideas here...]
