import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@seam/adapters";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import { logger } from "../packages/core/src/lib/logger.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";

type ToolFrame = Record<string, unknown>;

// Recorded from a real codex-acp 2.0.1 session on 2026-09-30.
const codex201 = {
  execute: {
    sessionUpdate: "tool_call",
    toolCallId: "exec-2",
    title: '"printf \'alpha\\\\nbeta\\\\n\' > /tmp/seam-724-probe.txt"',
    kind: "execute",
    status: "in_progress",
    content: [{ terminalId: "exec-2", type: "terminal" }],
    rawInput: {
      command: '/bin/bash -lc "printf \'alpha\\\\nbeta\\\\n\' > /tmp/seam-724-probe.txt"',
      cwd: "/workspace",
    },
  },
  edit: {
    sessionUpdate: "tool_call",
    toolCallId: "edit-2",
    title: "Editing files",
    kind: "edit",
    status: "in_progress",
    content: [{
      path: "/tmp/codex2-proof.txt",
      oldText: "before\n",
      newText: "after\n",
      _meta: { kind: "update" },
      type: "diff",
    }],
  },
  read: {
    sessionUpdate: "tool_call",
    toolCallId: "read-2",
    title: "cat /tmp/codex2-proof.txt",
    kind: "execute",
    status: "in_progress",
    content: [{ terminalId: "read-2", type: "terminal" }],
    rawInput: { command: "/bin/bash -lc 'cat /tmp/codex2-proof.txt'", cwd: "/workspace" },
  },
  search: {
    sessionUpdate: "tool_call",
    toolCallId: "search-2",
    title: "rg after /tmp/codex2-proof.txt",
    kind: "execute",
    status: "in_progress",
    content: [{ terminalId: "search-2", type: "terminal" }],
    rawInput: { command: "/bin/bash -lc 'rg after /tmp/codex2-proof.txt'", cwd: "/workspace" },
  },
} satisfies Record<string, ToolFrame>;

// Recorded from codex-acp 1.13.1 against the same installed Codex CLI.
const codex113 = {
  execute: {
    sessionUpdate: "tool_call",
    toolCallId: "exec-1",
    title: '"printf \'alpha\\\\nbeta\\\\n\' > /tmp/seam-724-probe.txt"',
    kind: "execute",
    status: "in_progress",
    content: [{ terminalId: "exec-1", type: "terminal" }],
    rawInput: {
      command: '/bin/bash -lc "printf \'alpha\\\\nbeta\\\\n\' > /tmp/seam-724-probe.txt"',
      cwd: "/workspace",
    },
  },
  edit: {
    sessionUpdate: "tool_call",
    toolCallId: "edit-1",
    title: "Editing files",
    kind: "edit",
    status: "in_progress",
    content: [{
      path: "/tmp/legacy-proof.txt",
      oldText: "before\n",
      newText: "after\n",
      _meta: {
        kind: "update",
        jetbrains: { air: { version: 1, diffStats: { version: 1, added: 1, removed: 1 } } },
      },
      type: "diff",
    }],
  },
  read: {
    sessionUpdate: "tool_call",
    toolCallId: "read-1",
    title: "cat /tmp/legacy-proof.txt",
    kind: "execute",
    status: "in_progress",
    content: [{ terminalId: "read-1", type: "terminal" }],
    rawInput: { command: "/bin/bash -lc 'cat /tmp/legacy-proof.txt'", cwd: "/workspace" },
  },
  search: {
    sessionUpdate: "tool_call",
    toolCallId: "search-1",
    title: "rg after /tmp/legacy-proof.txt",
    kind: "execute",
    status: "in_progress",
    content: [{ terminalId: "search-1", type: "terminal" }],
    rawInput: { command: "/bin/bash -lc 'rg after /tmp/legacy-proof.txt'", cwd: "/workspace" },
  },
} satisfies Record<string, ToolFrame>;

// Recorded from the scratch claude-agent-acp 0.84.0 binary on 2026-09-30.
const claude084: ToolFrame[] = [
  {
    sessionUpdate: "tool_call",
    toolCallId: "bash-1",
    title: "Terminal",
    name: "Bash",
    kind: "execute",
    status: "pending",
    content: [],
    rawInput: {},
    _meta: { claudeCode: { toolName: "Bash" } },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "bash-1",
    title: "printf 'alpha\\nbeta\\n' > /tmp/seam-724-claude-probe.txt",
    rawInput: { command: "printf 'alpha\\nbeta\\n' > /tmp/seam-724-claude-probe.txt" },
    _meta: { claudeCode: { toolName: "Bash" } },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "read-claude",
    title: "Read File",
    name: "Read",
    kind: "read",
    status: "pending",
    content: [],
    locations: [],
    rawInput: {},
    _meta: { claudeCode: { toolName: "Read" } },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "read-claude",
    title: "Read /tmp/seam-724-claude-probe.txt",
    locations: [{ path: "/tmp/seam-724-claude-probe.txt", line: 1 }],
    rawInput: { file_path: "/tmp/seam-724-claude-probe.txt" },
    _meta: { claudeCode: { toolName: "Read" } },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "edit-claude",
    title: "Edit",
    name: "Edit",
    kind: "edit",
    status: "pending",
    content: [],
    locations: [],
    rawInput: {},
    _meta: { claudeCode: { toolName: "Edit" } },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "edit-claude",
    title: "Edit /tmp/seam-724-claude-probe.txt",
    locations: [{ path: "/tmp/seam-724-claude-probe.txt" }],
    rawInput: { file_path: "/tmp/seam-724-claude-probe.txt" },
    _meta: { claudeCode: { toolName: "Edit" } },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "bash-2",
    title: "Terminal",
    name: "Bash",
    kind: "execute",
    status: "pending",
    content: [],
    rawInput: {},
    _meta: { claudeCode: { toolName: "Bash" } },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "bash-2",
    title: "grep -n gamma /tmp/seam-724-claude-probe.txt",
    rawInput: { command: "grep -n gamma /tmp/seam-724-claude-probe.txt" },
    _meta: { claudeCode: { toolName: "Bash" } },
  },
];

async function emitted(frames: ToolFrame[]): Promise<AgentEvent[]> {
  const profile = { id: "codex" } as unknown as AgentProfile;
  const runtime = new AgentRuntime({
    profile,
    logger,
    spawnFn: () => { throw new Error("unused"); },
  });
  const events: AgentEvent[] = [];
  runtime.onEvent((event) => { events.push(event); });
  for (const frame of frames) {
    await (runtime as unknown as {
      handleSessionUpdate(update: ToolFrame): Promise<void>;
    }).handleSessionUpdate(frame);
  }
  return events;
}

async function labels(frames: ToolFrame[]): Promise<string[]> {
  return (await emitted(frames))
    .flatMap((event) => event.kind === "tool-start" && event.title ? [event.title] : []);
}

function renderedActivity(activity: string[]): string {
  return discordRenderer.statusPanel({
    state: "Working",
    repoDisplay: "workspace",
    model: "gpt-6.1-sol",
    action: "Working…",
    elapsedSeconds: 1,
    activity,
  }).description ?? "";
}

describe("Codex ACP tool activity", () => {
  it("renders recorded 2.0.1 execute, edit, read, and search frames", async () => {
    const activity = await labels(Object.values(codex201));
    expect(activity).toEqual([
      'Terminal · "printf \'alpha\\\\nbeta\\\\n\' > /tmp/seam-724-probe.txt"',
      "Edit /tmp/codex2-proof.txt",
      "Terminal · cat /tmp/codex2-proof.txt",
      "Terminal · rg after /tmp/codex2-proof.txt",
    ]);
    expect(renderedActivity(activity)).toContain("▶️ Terminal · ");
    expect(renderedActivity(activity)).toContain("✏️ Edit /tmp/codex2-proof.txt");
    expect(renderedActivity(activity)).toContain("📄 Terminal · cat /tmp/codex2-proof.txt");
    expect(renderedActivity(activity)).toContain("🔍 Terminal · rg after /tmp/codex2-proof.txt");
  });

  it("keeps recorded 1.13.1 frame shapes working", async () => {
    const activity = await labels(Object.values(codex113));
    expect(activity).toEqual([
      'Terminal · "printf \'alpha\\\\nbeta\\\\n\' > /tmp/seam-724-probe.txt"',
      "Edit /tmp/legacy-proof.txt",
      "Terminal · cat /tmp/legacy-proof.txt",
      "Terminal · rg after /tmp/legacy-proof.txt",
    ]);
    const rendered = renderedActivity(activity);
    expect(rendered).toContain("▶️ Terminal · ");
    expect(rendered).toContain("✏️ Edit /tmp/legacy-proof.txt");
    expect(rendered).toContain("📄 Terminal · cat /tmp/legacy-proof.txt");
    expect(rendered).toContain("🔍 Terminal · rg after /tmp/legacy-proof.txt");
  });

  it("keeps Claude ACP 0.84.0 AIR-contract frames detailed", async () => {
    const activity = (await emitted(claude084)).flatMap((event) =>
      (event.kind === "tool-start" || event.kind === "tool-update") && event.title
        ? [event.title]
        : []
    );
    expect(activity).toEqual([
      "Terminal",
      "printf 'alpha\\nbeta\\n' > /tmp/seam-724-claude-probe.txt",
      "Read File",
      "Read /tmp/seam-724-claude-probe.txt",
      "Edit",
      "Edit /tmp/seam-724-claude-probe.txt",
      "Terminal",
      "grep -n gamma /tmp/seam-724-claude-probe.txt",
    ]);
    const rendered = renderedActivity(activity);
    expect(rendered).toContain("▶️ Terminal");
    expect(rendered).toContain("📄 Read /tmp/seam-724-claude-probe.txt");
    expect(rendered).toContain("✏️ Edit /tmp/seam-724-claude-probe.txt");
    expect(rendered).toContain("🔍 grep -n gamma /tmp/seam-724-claude-probe.txt");
  });
});
