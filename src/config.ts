import "dotenv/config";
import { z } from "zod";

const Schema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_OWNER_USER_ID: z
    .string()
    .regex(/^\d+$/, "DISCORD_OWNER_USER_ID must be a numeric Discord user id"),
  DISCORD_DEV_GUILD_ID: z
    .string()
    .regex(/^\d+$/)
    .optional(),

  REPOS_ROOT: z.string().min(1, "REPOS_ROOT is required"),
  DATA_DIR: z.string().default("./data"),

  DEFAULT_AGENT: z.string().default("copilot"),
  DEFAULT_MODEL: z.string().default("gpt-5.4"),
  COPILOT_CLI_PATH: z.string().optional(),

  TURN_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(900),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(): Config {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
