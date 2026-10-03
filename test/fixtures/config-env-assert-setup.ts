await import("../../packages/core/src/config.js");

// Neither shell values nor cwd/.env may reach non-live config consumers.
for (const key of ["SEAM_495_DOTENV_SENTINEL", "SEAM_620_OPERATOR_ONLY", "AGY_PIN", "DISCORD_BOT_TOKEN"]) {
  if (process.env[key] !== undefined) {
    throw new Error(`non-live test inherited ${key}`);
  }
}
