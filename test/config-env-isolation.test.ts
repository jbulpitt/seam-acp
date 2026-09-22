import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

describe("#495 actual config tests under real dotenv files", () => {
  it.each(["clean", "hostile"])("passes with a %s .env, without operator environment assistance", async mode => {
    const cwd = mkdtempSync(path.join(tmpdir(), "seam-config-env-"));
    try {
      writeFileSync(path.join(cwd, ".env"), [
        "SEAM_495_DOTENV_SENTINEL=from-real-dotenv-file",
        ...(mode === "hostile" ? [
          "COPILOT_ENABLED=true", "AGENT_LOCATION_DENY=copilot@local", "DEFAULT_AGENT=opencode",
          "DISCORD_DEV_GUILD_ID=not-a-numeric-id", "CHANNEL_PRESETS_FILE=/missing/hostile-presets.json",
          "DISCORD_BOT_TOKEN=ambient-token-must-not-rescue-fixtures", "DISCORD_ALLOWED_USER_IDS=987",
        ] : []),
      ].join("\n"));
      const report = path.join(cwd, "report.json");
      const result = await exec(process.execPath, [
        path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1",
        "--config", path.join(root, "test/fixtures/config-env.vitest.ts"),
        "--reporter=json", `--outputFile=${report}`,
      ], {
        cwd, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
        // No credential, config, NODE_OPTIONS or other operator setting is
        // inherited. PATH is operational only; HOME is another disposable path.
        env: { PATH: process.env.PATH, HOME: cwd, CI: "true", SEAM_495_DOTENV_SENTINEL: "inherited-wrong-value" },
      }).then(() => 0, (error: { code?: unknown }) => error.code);
      const summary = JSON.parse(readFileSync(report, "utf8"));
      const failures = summary.testResults.flatMap((file: any) => file.assertionResults
        .filter((test: any) => test.status === "failed").map((test: any) => test.fullName));
      expect({ exit: result, failures }).toEqual({ exit: 0, failures: [] });
      expect(summary.numPassedTests).toBeGreaterThan(100);
      expect(summary.testResults).toHaveLength(12);
      expect(summary.numFailedTestSuites).toBe(0);
      console.info(`#495 ${mode} dotenv: ${summary.numPassedTests} tests passed across ${summary.testResults.length} files`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 100_000);

  it("preserves the no-argument production loader and dotenv's file-over-shell precedence", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "seam-config-boot-"));
    try {
      writeFileSync(path.join(cwd, ".env"), [
        "DISCORD_BOT_TOKEN=file-token", "DISCORD_ALLOWED_USER_IDS=123", `REPOS_ROOT=${cwd}`,
        "DEFAULT_AGENT=claude", "COPILOT_ENABLED=true", "AGENT_LOCATION_DENY=copilot@local",
      ].join("\n"));
      const { stdout } = await exec(process.execPath, [
        "--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e",
        `const { loadConfig } = await import(${JSON.stringify(new URL("../packages/core/src/config.ts", import.meta.url).href)});
         const c = loadConfig();
         process.stdout.write(JSON.stringify({ token: c.DISCORD_BOT_TOKEN, agent: c.DEFAULT_AGENT,
           copilot: c.COPILOT_ENABLED, deny: c.AGENT_LOCATION_DENY, root: c.REPOS_ROOT }));`,
      ], { cwd, timeout: 15_000, env: { PATH: process.env.PATH, HOME: cwd, DEFAULT_AGENT: "codex", DISCORD_BOT_TOKEN: "shell-token" } });
      expect(JSON.parse(stdout)).toEqual({ token: "file-token", agent: "claude", copilot: true,
        deny: [{ agentId: "copilot", location: "local" }], root: cwd });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 20_000);
});
