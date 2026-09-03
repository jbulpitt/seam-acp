/**
 * ZERO-TOKEN Claude Fast-mode probe (#37).
 *
 * Verifies, WITHOUT sending a single completion:
 *   1. whether a fresh `session/new` advertises ACP config id `fast`
 *   2. what values it accepts (expected: `on` / `off`) and its current value
 *   3. whether `setSessionConfigOption({ configId: "fast", value })` is accepted
 *
 * It NEVER calls `session/prompt`, so it spends no subscription tokens and no
 * usage credits. Proving that a completion was actually *served* in Fast mode
 * needs a paid turn plus `fast_mode_state` inspection — deliberately out of
 * scope here (see docs/model-management-runbook.md §12).
 *
 * IMPORTANT — run it from a clean shell. If you invoke this from INSIDE a Claude
 * Code session, the child inherits that session's `CLAUDECODE` /
 * `CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_*` variables, which pm2 never sets
 * and which change what the wrapper advertises. `--clean-env` strips them so the
 * probe matches how seam-acp actually spawns the agent.
 *
 * Usage:
 *   node scripts/claude-fast-mode-probe.mjs [--clean-env] [model...]
 *   CLAUDE_CODE_DISABLE_FAST_MODE=1 node scripts/claude-fast-mode-probe.mjs
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

const acp = await import("@agentclientprotocol/sdk");

const argv = process.argv.slice(2);
const cleanEnv = argv.includes("--clean-env");
const models = argv.filter((a) => !a.startsWith("--"));
const targets = models.length > 0 ? models : ["default", "claude-opus-5", "claude-sonnet-5"];

/** Drop the nested-Claude-Code variables a parent session leaks into children. */
function baseEnv() {
  const env = { ...process.env };
  if (!cleanEnv) return env;
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  delete env.CLAUDE_AGENT_SDK_VERSION;
  delete env.CLAUDE_PID;
  delete env.CLAUDE_EFFORT;
  delete env.CLAUDE_THINKING_DISPLAY;
  return env;
}

function flatten(options) {
  return (options ?? []).flatMap((o) => ("options" in o ? o.options : [o]));
}

for (const model of targets) {
  const env = baseEnv();
  // Mirror the Seam Claude profile: full canonical ids are forwarded via
  // ANTHROPIC_MODEL; aliases like `default` are left to the wrapper.
  if (/^claude-[a-z]+-\d/.test(model)) env.ANTHROPIC_MODEL = model;

  const proc = spawn("claude-agent-acp", [], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  proc.stderr.on("data", () => {});
  const stream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin),
    Readable.toWeb(proc.stdout)
  );
  const conn = new acp.ClientSideConnection(
    () => ({
      async sessionUpdate() {},
      async requestPermission() {
        return { outcome: { outcome: "cancelled" } };
      },
    }),
    stream
  );

  try {
    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: {} },
    });
    const ns = await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
    const opts = ns.configOptions ?? [];
    const fast = opts.find((o) => o.id === "fast");
    const ids = opts.map((o) => o.id).join(", ");
    // What the session ACTUALLY resolved to. `default` is an alias; Fast support
    // follows the resolved model, so reporting the alias alone proves nothing.
    const modelOpt = opts.find((o) => o.category === "model" || o.id === "model");
    const resolved = typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : "?";

    if (!fast) {
      console.log(
        `${model.padEnd(18)} resolved=${resolved.padEnd(18)} fast: NOT ADVERTISED  (config ids: ${ids || "none"})`
      );
    } else {
      const values = fast.type === "select" ? flatten(fast.options).map((o) => o.value) : [];
      console.log(
        `${model.padEnd(18)} resolved=${resolved.padEnd(18)} fast: type=${fast.type} current=${JSON.stringify(fast.currentValue)} values=[${values.join("|")}]`
      );
      // Accept-check only. Still zero-token: set_config_option does not run a
      // completion. Restores `off` afterwards so nothing is left enabled.
      for (const value of ["on", "off"]) {
        if (!values.includes(value)) continue;
        try {
          const res = await conn.setSessionConfigOption({
            sessionId: ns.sessionId,
            configId: "fast",
            value,
          });
          const after = (res?.configOptions ?? []).find((o) => o.id === "fast");
          console.log(
            `${" ".repeat(18)}   set "${value}" → accepted, currentValue=${JSON.stringify(after?.currentValue)}`
          );
        } catch (err) {
          console.log(`${" ".repeat(18)}   set "${value}" → REJECTED: ${err?.message ?? err}`);
        }
      }
    }
  } catch (err) {
    console.log(`${model.padEnd(18)} probe failed: ${err?.message ?? err}`);
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 400));
  }
}
