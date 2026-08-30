/**
 * Build a codex `model_catalog_json` for the Ollama Cloud agent (codex-acp backend).
 *
 * WHY: codex uses fallback "unknown-model" metadata for slugs it doesn't recognize,
 * which caps the usable context window well below these models' real limits
 * (openai/codex#31860, #32132) and prints a warning. Supplying a catalog gives codex
 * the true per-model context window, so long sessions use the full window (e.g. the
 * 1M on glm-5.3) instead of compacting early.
 *
 * SCHEMA: each entry mirrors codex's internal `ModelInfo` struct (~30 fields, values
 * cribbed from codex's own published catalog). `base_instructions` is REQUIRED and IS
 * injected as the model's system prompt (verified empirically: a marker instruction in
 * base_instructions is obeyed). We therefore supply a concise, accurate coding-agent
 * prompt instead of copying codex's stock "You are Codex … based on GPT-5" text, which
 * would misidentify these open-weight models and drift across codex releases.
 *
 * FRAGILITY: this schema is codex-internal. A future codex release that adds a required
 * field will make the catalog fail to parse and prevent the agent from starting (same
 * class as the wire_api chat→responses break). Revisit on codex upgrades.
 */

export interface OllamaCatalogModel {
  modelId: string;
  name: string;
  contextLimit?: number;
  visionMode?: string;
}

/** Concise, model-accurate coding-agent system prompt (see WHY above). */
export const OLLAMA_CODEX_BASE_INSTRUCTIONS = `You are a capable software-engineering agent operating through the Codex CLI over the Agent Client Protocol. You run an open-weight model hosted on Ollama Cloud, bridged into a chat thread where you collaborate with the user on real tasks in a shared workspace.

Work directly and pragmatically:
- Use the apply_patch tool to create and edit files. Do not paste large file contents into chat or edit files with shell redirection.
- Use the shell to inspect the repository and run commands. Prefer ripgrep (rg) for searching.
- Lead with the outcome. Keep messages concise and easy to scan; use the minimum formatting needed to be clear.
- Verify your changes in proportion to their risk (build, run, or test when it matters).

Be careful with irreversible actions: never run destructive commands such as \`rm -rf\`, \`git reset --hard\`, or \`git checkout --\` unless the user has explicitly asked for that operation. When a request is ambiguous, or completing it needs a decision only the user can make, stop and ask rather than guessing.`;

/**
 * Map the curated Ollama Cloud model list to a codex model catalog. Slugs are the
 * `:cloud`-suffixed model ids the picker uses (they resolve on the OpenAI endpoint),
 * so codex looks up the right entry when a session pins one.
 */
export function buildOllamaCodexCatalog(
  models: ReadonlyArray<OllamaCatalogModel>,
): { models: Array<Record<string, unknown>> } {
  return {
    models: models.map((m, i) => {
      const ctx = m.contextLimit ?? 128_000;
      const native = m.visionMode === "native";
      return {
        slug: m.modelId,
        prefer_websockets: false,
        support_verbosity: true,
        default_verbosity: "low",
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text",
        input_modalities: native ? ["text", "image"] : ["text"],
        supports_image_detail_original: native,
        truncation_policy: { mode: "tokens", limit: 10000 },
        supports_parallel_tool_calls: true,
        tool_mode: null,
        multi_agent_version: "v2",
        use_responses_lite: false,
        include_skills_usage_instructions: false,
        auto_review_model_override: null,
        context_window: ctx,
        max_context_window: ctx,
        effective_context_window_percent: 95,
        auto_compact_token_limit: null,
        comp_hash: "3000",
        reasoning_summary_format: "experimental",
        // "auto" (not "none") so codex surfaces the model's reasoning to the
        // status card; "none" (from DeepSeek's example) suppressed the thinking
        // these open-weight models stream.
        default_reasoning_summary: "auto",
        display_name: m.name,
        description: `${m.name} on Ollama Cloud`,
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "high", description: "Deeper reasoning for complex problems" },
          { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
        ],
        shell_type: "shell_command",
        visibility: "list",
        minimal_client_version: "0.144.0",
        supported_in_api: true,
        availability_nux: null,
        upgrade: null,
        priority: i + 1,
        experimental_supported_tools: [],
        // MUST be false for a non-OpenAI provider. With true (+ tool_mode null),
        // codex registers MCP tools as ToolExposure::Deferred behind `tool_search`
        // — but Ollama's Responses API can't service tool_search, so seam-mcp
        // tools (inspect_image, handoff, poll_inbox, …) become invisible and even
        // the tool_search escape hatch aborts. false → ToolExposure::Direct, so
        // MCP tools appear inline and are directly callable. See openai/codex#36382.
        supports_search_tool: false,
        default_service_tier: null,
        supports_reasoning_summaries: true,
        base_instructions: OLLAMA_CODEX_BASE_INSTRUCTIONS,
      };
    }),
  };
}
