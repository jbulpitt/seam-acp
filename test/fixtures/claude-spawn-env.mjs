#!/usr/bin/env node

if (process.argv.includes("--version")) {
  console.log("fixture-claude-agent-acp");
} else {
  console.log(JSON.stringify({
    model: process.env.ANTHROPIC_MODEL ?? null,
    vertex: process.env.CLAUDE_CODE_USE_VERTEX ?? null,
    project: process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? null,
    region: process.env.CLOUD_ML_REGION ?? null,
    credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null,
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    anthropicApiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
  }));
}
