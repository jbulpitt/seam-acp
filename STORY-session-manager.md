# Story: Agent-Specific Session Manager

**Concept:**
A `/sessions` or `/manage-sessions` slash command that acts as a powerful, agent-specific session manager. It allows users to visually browse, manage, and recover recent sessions directly from Discord.

## Proposed Functionality

1. **Load & Summarize:** Query the underlying agent's session store. To avoid latency and API costs, use **heuristics by default**: extract the first few messages (e.g., `head -n 2`) and the last few messages (e.g., `tail -n 6`). Prefix these lines with 👤 for human input and 🤖 for agent output to provide a readable preview alongside timestamps.
2. **Interactive UI Flow:** Because Discord dropdown descriptions are limited to 100 characters, we avoid dropdowns for the summaries. Instead, we use a two-step "Card" flow:
   - **Step 1: Paginated Preview.** An Embed displays the rich 8-line heuristic summary for a single session. Below it are buttons: `[◀ Prev]` `[Next ▶]` and a prominent `[Manage This Session]` button.
   - **Step 2: Session Actions Card.** Clicking "Manage" edits the message to show a detailed card for that specific session. The card features an array of action buttons: `[Attach]` `[Clone]` `[Repair]` `[Delete]` `[🪄 AI Summary]`, and a `[⬅ Back to List]` button to return to the paginated view.
3. **Actions:**
   - **Attach:** Hot-swap the current Discord channel's session with a selected historical session.
   - **Clone:** Duplicate a historical session into a new session ID for the current channel.
   - **Recover/Rewind:** If a session is bricked by a bad turn (e.g., "Prompt is too long"), "rewind" it cleanly using a `clone > modify > attach` pipeline to avoid modifying active/locked files entirely!
   - **Delete:** Permanently purge a session from the agent's history. *(Caveat: If the session file is currently locked by an active agent process, we simply catch the filesystem lock and return a friendly Discord error).*
   - **🪄 AI Summary:** Spawn a temporary, short-lived `AgentRuntime` instance with a designated summary model override, prompt the agent to summarize the conversation transcript, display the output in Discord, and cleanly dispose of the temporary runtime.

## AI Summary Model Selections
To perform the summary, the bot utilizes the following lightweight/fast model mappings for the temporary runtimes:
- **Local Copilot agents:** `gpt-5-mini`
- **Remote Mac agent:** `gpt-5-mini`
- **Claude Code:** `haiku`
- **Antigravity:** `gemini-3-flash`
- **Gemini CLI:** *(Skipped entirely)*

## Gaps & Blockers to Consider

1. **Concurrency & Race Conditions:** What happens if a user triggers "Clone" or "Rewind" while the session is actively executing a long-running bash command? The bridge needs robust file lock detection or a way to ensure it doesn't mutate a file being actively written to by the agent.
2. **Discord Interaction Timeouts:** Generating an LLM summary via the `🪄 AI Summary` button will take 5-10 seconds for massive sessions. Discord interactions MUST be deferred within 3 seconds or they timeout. We'll need to use `interaction.deferUpdate()` immediately when the button is clicked to prevent errors.
3. **Session Identification across APIs:** `seam-acp` tracks sessions by a UUID, but Claude uses `.jsonl` files, Copilot uses an SQLite DB, and Antigravity uses `brain/<uuid>`. The abstraction layer needs a strict interface (e.g., `ISessionManager`) that each agent profile implements, so the Discord orchestrator remains completely agnostic to the underlying file structures.
4. **Remote Bridge Protocol Upgrades:** The `remote-agent-bridge.mjs` currently acts as a transparent `stdio` proxy. It needs to be upgraded to handle new, out-of-band JSON-RPC calls (like `listSessions`, `cloneSession`) securely without breaking its core proxy logic.

## Reference
See the detailed `implementation_plan.md` artifact for agent-specific execution strategies (Claude vs Copilot vs Remote vs Antigravity).
