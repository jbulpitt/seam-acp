/**
 * ZERO-TOKEN direct-Anthropic Claude catalog probe (#232).
 *
 * Prints exactly what a catalog refresh would publish for a direct Claude
 * profile: the live ACP-advertised models with their per-model effort choices,
 * plus the verified-overlay rows for canonical models the wrapper does not
 * advertise — each with its provenance.
 *
 * It runs the SHIPPED adapter code (not a re-implementation), so it cannot
 * drift from what production does. Build first:
 *
 *   npm run build
 *   node scripts/claude-catalog-probe.mjs [--clean-env] [--config-dir <dir>]
 *
 * It never calls `session/prompt`, so it spends no subscription tokens and no
 * usage credits. It therefore proves ADVERTISEMENT, not what the API serves —
 * proving a served model still requires the JSONL ground-truth procedure in
 * docs/model-management-runbook.md §4, which is a deliberate, token-spending
 * maintenance operation that updates CLAUDE_VERIFIED_OVERLAY.
 *
 * Run it from a clean shell. Invoked from inside a Claude Code session the
 * child inherits `CLAUDECODE` / `CLAUDE_CODE_*`, which systemd never sets and
 * which change what the wrapper advertises. `--clean-env` strips them so the
 * probe matches how seam-acp actually spawns the agent.
 */
import { makeClaudeProfile } from "../packages/adapters/dist/index.js";

const argv = process.argv.slice(2);
if (argv.includes("--clean-env")) {
  for (const key of Object.keys(process.env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) delete process.env[key];
  }
  delete process.env.CLAUDE_AGENT_SDK_VERSION;
  delete process.env.CLAUDE_PID;
  delete process.env.CLAUDE_EFFORT;
  delete process.env.CLAUDE_THINKING_DISPLAY;
}
const configDirIndex = argv.indexOf("--config-dir");
const configDir = configDirIndex === -1 ? undefined : argv[configDirIndex + 1];

const profile = makeClaudeProfile({
  directAnthropic: true,
  defaultModel: process.env.CLAUDE_DEFAULT_MODEL || "default",
  ...(configDir ? { configDir } : {}),
});

const startedAt = Date.now();
const candidate = await profile.catalog.fetch();

console.log(`source        : ${candidate.source}`);
console.log(`overlay       : ${candidate.sourceVersion}`);
console.log(`wrapper       : claude-agent-acp ${candidate.cliVersion ?? "?"}`);
console.log(`scope         : ${JSON.stringify(candidate.scope)}`);
console.log(`elapsed       : ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`models        : ${candidate.models.length}\n`);

for (const model of candidate.models) {
  const window = model.context.native === null ? "unverified" : String(model.context.native);
  console.log(
    `${model.default ? "*" : " "} ${model.id.padEnd(22)} context=${window.padEnd(11)}` +
      `effort=${model.effort.mechanism.padEnd(6)}[${model.effort.choices.map((c) => c.id).join(",")}]` +
      ` default=${model.effort.selectionDefault}`
  );
  if (model.aliases.length) console.log(`    aliases   : ${model.aliases.join(", ")}`);
  for (const record of model.evidence ?? []) {
    const parts = [`${record.kind} via ${record.source}`];
    if (record.observedAt) parts.push(record.observedAt);
    if (record.runtimeVersion) parts.push(record.runtimeVersion);
    if (record.resolvedModel) parts.push(`resolved ${record.resolvedModel}`);
    if (record.context?.native != null) parts.push(`context ${record.context.native}`);
    if (record.effort?.selectionDefault) parts.push(`effort default ${record.effort.selectionDefault}`);
    if (record.note) parts.push(record.note);
    console.log(`    evidence  : ${parts.join("; ")}`);
  }
  if (!model.evidence?.length) console.log("    evidence  : (none)");
}
