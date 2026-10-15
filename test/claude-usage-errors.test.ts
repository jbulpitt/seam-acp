import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchClaudeUsage } from "../packages/adapters/src/profiles/claude.js";
import { createUsageProviderPort } from "../packages/core/src/core/quota/usage-provider.js";
import { createQuotaSources } from "../packages/core/src/plugins/quota/sources.js";
import {
  renderAgentQuotaLayout,
  renderAgentQuotaPanel,
} from "../packages/core/src/core/quota/agent-quota-card.js";

const accessToken = "usage-test-access-secret";
const refreshToken = "usage-test-refresh-secret";
const usage = {
  five_hour: { utilization: 12, resets_at: "2026-10-15T04:00:00Z" },
  seven_day: { utilization: 45, resets_at: "2026-10-20T04:00:00Z" },
};

describe("Claude usage failure causes", () => {
  let dir: string;
  let credentials: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-claude-quota-errors-"));
    credentials = path.join(dir, ".credentials.json");
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeCredentials(file = credentials): void {
    fs.writeFileSync(file, JSON.stringify({
      claudeAiOauth: { accessToken, refreshToken, subscriptionType: "max" },
    }));
  }

  it("reports the missing credentials paths and filesystem cause without requesting usage", async () => {
    const data = await fetchClaudeUsage(dir);
    expect(data).toHaveProperty("error", expect.stringContaining("ENOENT"));
    expect(data).toHaveProperty("error", expect.stringContaining(credentials));
    expect(data).toHaveProperty("error", expect.stringContaining(path.join(dir, "credentials.json")));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves an unreadable primary file's cause when the alternate is absent", async () => {
    fs.mkdirSync(credentials);
    const data = await fetchClaudeUsage(dir);
    expect(data).toHaveProperty("error", expect.stringContaining("EISDIR"));
    expect(data).toHaveProperty("error", expect.stringContaining(credentials));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports malformed credentials without exposing their contents", async () => {
    fs.writeFileSync(credentials, `{"claudeAiOauth": {"accessToken": "${accessToken}" broken`);
    const data = await fetchClaudeUsage(dir);
    expect(data).toHaveProperty("error", expect.stringContaining("invalid JSON"));
    expect(data).toHaveProperty("error", expect.stringContaining(credentials));
    expect(JSON.stringify(data)).not.toContain(accessToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{}, { claudeAiOauth: { expiresAt: 0, refreshToken, subscriptionType: "max" } }])(
    "reports the incident's missing OAuth access token for %j", async (store) => {
      fs.writeFileSync(credentials, JSON.stringify(store));
      const data = await fetchClaudeUsage(dir);
      expect(data).toHaveProperty("error", `Claude usage: no OAuth access token in ${credentials}`);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(JSON.stringify(data)).not.toContain(refreshToken);
    },
  );

  it("keeps the alternate credentials filename working after a missing primary", async () => {
    writeCredentials(path.join(dir, "credentials.json"));
    fetchMock.mockResolvedValue(Response.json(usage));
    const data = await fetchClaudeUsage(dir);
    expect(data.fiveHour?.utilization).toBe(12);
    expect(data.sevenDay?.utilization).toBe(45);
    expect(data).not.toHaveProperty("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(data)).not.toContain(accessToken);
  });

  it("reports the final 429's status and body message after the existing three attempts", async () => {
    writeCredentials();
    fetchMock.mockImplementation(async () => Response.json({
      error: { type: "rate_limit_error", message: `Rate limited on attempt ${fetchMock.mock.calls.length}` },
    }, { status: 429 }));
    const data = await fetchClaudeUsage(dir);
    expect(data).toHaveProperty("error", "Claude usage endpoint returned 429: Rate limited on attempt 3");
    expect(data.subscriptionType).toBe("max");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports an auth response's top-level message without adding retries", async () => {
    writeCredentials();
    fetchMock.mockResolvedValue(Response.json({ message: "OAuth token has expired" }, { status: 401 }));
    const data = await fetchClaudeUsage(dir);
    expect(data).toHaveProperty("error", "Claude usage endpoint returned 401: OAuth token has expired");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a non-JSON endpoint error body", async () => {
    writeCredentials();
    fetchMock.mockResolvedValue(new Response("Forbidden by the usage endpoint", { status: 403 }));
    expect(await fetchClaudeUsage(dir)).toHaveProperty("error",
      "Claude usage endpoint returned 403: Forbidden by the usage endpoint");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the HTTP status when the error body is empty", async () => {
    writeCredentials();
    fetchMock.mockResolvedValue(new Response(null, { status: 403, statusText: "Forbidden" }));
    expect(await fetchClaudeUsage(dir)).toHaveProperty("error", "Claude usage endpoint returned 403: Forbidden");
  });

  it("reports the final fetch failure after the existing three attempts", async () => {
    writeCredentials();
    fetchMock.mockRejectedValueOnce(new Error("first network failure"))
      .mockRejectedValueOnce(new Error("second network failure"))
      .mockRejectedValueOnce(new Error("connection reset by peer"));
    expect(await fetchClaudeUsage(dir)).toHaveProperty("error", "Claude usage: connection reset by peer");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clears a failed attempt's error when the existing retry succeeds", async () => {
    writeCredentials();
    fetchMock.mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(Response.json(usage));
    const data = await fetchClaudeUsage(dir);
    expect(data.fiveHour?.utilization).toBe(12);
    expect(data).not.toHaveProperty("error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["response", "fetch"])("never includes credential token values in a %s error", async (kind) => {
    writeCredentials();
    const message = `Access denied: ${accessToken}; ${refreshToken}`;
    if (kind === "response") {
      fetchMock.mockResolvedValue(Response.json({ error: { message } }, { status: 401 }));
    } else {
      fetchMock.mockRejectedValue(new Error(message));
    }
    const data = await fetchClaudeUsage(dir);
    expect(data).toHaveProperty("error", expect.stringContaining("Access denied"));
    expect(JSON.stringify(data)).not.toContain(accessToken);
    expect(JSON.stringify(data)).not.toContain(refreshToken);
  });

  it("carries the actual credential failure through the quota source to both card renderers", async () => {
    fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { expiresAt: 0 } }));
    const port = createUsageProviderPort({ profiles: [{ id: "claude", displayName: "Claude", configDir: dir }] });
    const [source] = createQuotaSources(port.bindings(), port);
    const quota = await source!.fetch(undefined);
    const error = `Claude usage: no OAuth access token in ${credentials}`;
    expect(quota).toMatchObject({ agentId: "claude", ok: false, error });
    const layout = renderAgentQuotaLayout([quota]);
    const text = layout.blocks.filter(block => block.kind === "text").map(block => block.content).join("\n");
    expect(text).toContain(error);
    expect(renderAgentQuotaPanel([quota]).fields?.[0]?.value).toContain(error);
    expect(text).not.toContain("Claude quota data unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
