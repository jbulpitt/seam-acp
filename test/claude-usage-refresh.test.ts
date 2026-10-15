import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs, { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchClaudeUsage } from "../packages/adapters/src/profiles/claude.js";
import { createUsageProviderPort } from "../packages/core/src/core/quota/usage-provider.js";
import { createQuotaSources } from "../packages/core/src/plugins/quota/sources.js";
import { renderAgentQuotaLayout, renderAgentQuotaPanel } from "../packages/core/src/core/quota/agent-quota-card.js";

// Installed Claude Code 2.1.294 / agent SDK 0.3.293 OAuth configuration.
const tokenUrl = "https://platform.claude.com/v1/oauth/token";
const usageUrl = "https://api.anthropic.com/api/oauth/usage";
const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const oldAccess = "fixture-old-access-secret";
const oldRefresh = "fixture-old-refresh-secret";
const newAccess = "fixture-new-access-secret";
const newRefresh = "fixture-new-refresh-secret";
const winnerAccess = "fixture-winner-access-secret";
const winnerRefresh = "fixture-winner-refresh-secret";
const now = Date.parse("2026-10-15T10:04:00Z");
const usage = { five_hour: { utilization: 12 }, seven_day: { utilization: 45 } };
const rotated = { access_token: newAccess, refresh_token: newRefresh, expires_in: 28_800, refresh_token_expires_in: 86400 };

function credentials(expiresAt = now - 1) {
  return {
    otherProvider: { key: "untouched", nested: [1, 2] },
    claudeAiOauth: {
      accessToken: oldAccess, refreshToken: oldRefresh, expiresAt,
      refreshTokenExpiresAt: now + 10 * 86400_000,
      email: "fixture@example.test", subscriptionType: "max", rateLimitTier: "default_claude_max_20x",
      scopes: ["user:profile", "user:inference"], futureField: { retained: true },
    },
  };
}

describe("Claude usage OAuth refresh", () => {
  let dir: string;
  let file: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-claude-usage-refresh-"));
    file = path.join(dir, ".credentials.json");
    write(credentials());
    fetchMock = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (url === tokenUrl) return Response.json(rotated);
      if (url === usageUrl) return Response.json(usage);
      throw new Error("Unexpected mocked URL; no network is allowed");
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(value: ReturnType<typeof credentials>): void {
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  }

  function winner() {
    const value = credentials(now + 28_800_000);
    value.claudeAiOauth.accessToken = winnerAccess;
    value.claudeAiOauth.refreshToken = winnerRefresh;
    value.otherProvider.key = "concurrent writer";
    return value;
  }

  function expectUsageToken(token: string): void {
    const call = fetchMock.mock.calls.findLast(([url]) => url === usageUrl);
    expect(new Headers(call?.[1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
  }

  function expectNoSecrets(value: unknown): void {
    const text = JSON.stringify(value);
    for (const secret of [oldAccess, oldRefresh, newAccess, newRefresh, winnerAccess, winnerRefresh]) {
      expect(text).not.toContain(secret);
    }
  }

  it("refreshes an expired login before usage and atomically preserves all other fields and mode", async () => {
    const original = credentials();
    const inode = fs.statSync(file).ino;
    const data = await fetchClaudeUsage(dir);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([tokenUrl, usageUrl]);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: "refresh_token", refresh_token: oldRefresh, client_id: clientId,
      scope: original.claudeAiOauth.scopes.join(" "),
    });
    expectUsageToken(newAccess);
    expect(data).toMatchObject({ fiveHour: { utilization: 12 }, sevenDay: { utilization: 45 } });
    expect(data).not.toHaveProperty("error");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      ...original,
      claudeAiOauth: { ...original.claudeAiOauth, accessToken: newAccess, refreshToken: newRefresh,
        expiresAt: now + 28_800_000, refreshTokenExpiresAt: now + 86400_000 },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).ino).not.toBe(inode);
    expect(fs.readdirSync(dir)).toEqual([".credentials.json"]);
    expectNoSecrets(data);
  });

  it("refreshes once after a 401 even when the stored expiry is in the future", async () => {
    write(credentials(now + 3600_000));
    fetchMock.mockImplementationOnce(async () => Response.json({ message: "OAuth access token has expired" }, { status: 401 }));
    const data = await fetchClaudeUsage(dir);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([usageUrl, tokenUrl, usageUrl]);
    expectUsageToken(newAccess);
    expect(data.fiveHour?.utilization).toBe(12);
    expect(data).not.toHaveProperty("error");
  });

  it("does not refresh or rewrite a healthy login", async () => {
    write(credentials(now + 3600_000));
    const before = fs.readFileSync(file, "utf8");
    const inode = fs.statSync(file).ino;
    await fetchClaudeUsage(dir);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([usageUrl]);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.statSync(file).ino).toBe(inode);
  });

  it("holds Claude Code's .storage-write lock through the grant and credential commit, then releases it", async () => {
    const lock = path.join(dir, ".storage-write.lock");
    fetchMock.mockImplementation(async url => {
      if (url === tokenUrl) {
        expect(fs.statSync(lock).isDirectory()).toBe(true);
        return Response.json(rotated);
      }
      return Response.json(usage);
    });
    const rename = fs.renameSync.bind(fs);
    const commit = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      expect(fs.statSync(lock).isDirectory()).toBe(true);
      rename(from, to);
    });
    const data = await fetchClaudeUsage(dir);
    expect(data).not.toHaveProperty("error");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("does not rotate tokens or remove a live Claude Code writer lock", async () => {
    const lock = path.join(dir, ".storage-write.lock");
    fs.mkdirSync(lock);
    fs.utimesSync(lock, new Date(now), new Date(now));
    const before = fs.readFileSync(file, "utf8");
    const data = await fetchClaudeUsage(dir);
    expect(data.error).toMatch(/credential write lock.*ELOCKED/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.statSync(lock).isDirectory()).toBe(true);
  });

  it("recovers an abandoned writer lock using Claude Code's existing 15s stale bound", async () => {
    const lock = path.join(dir, ".storage-write.lock");
    fs.mkdirSync(lock);
    fs.utimesSync(lock, new Date(now - 15_001), new Date(now - 15_001));
    const data = await fetchClaudeUsage(dir);
    expect(data).not.toHaveProperty("error");
    expectUsageToken(newAccess);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("does not need the writer lock to read usage from an already healthy login", async () => {
    write(credentials(now + 3600_000));
    const lock = path.join(dir, ".storage-write.lock");
    fs.mkdirSync(lock);
    const data = await fetchClaudeUsage(dir);
    expect(data).not.toHaveProperty("error");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([usageUrl]);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("does not commit or release a writer lock that was replaced during the refresh", async () => {
    const lock = path.join(dir, ".storage-write.lock");
    const moved = path.join(dir, "original-lock");
    const before = fs.readFileSync(file, "utf8");
    fetchMock.mockImplementation(async url => {
      if (url === tokenUrl) {
        fs.renameSync(lock, moved);
        fs.mkdirSync(lock);
        return Response.json(rotated);
      }
      return Response.json(usage);
    });
    const data = await fetchClaudeUsage(dir);
    expect(data.error).toMatch(/credential write lock.*ownership changed/i);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("reuses a concurrent rotation observed after a usage 401 without granting again", async () => {
    write(credentials(now + 3600_000));
    fetchMock.mockImplementationOnce(async () => {
      write(winner());
      return Response.json({ message: "OAuth access token has expired" }, { status: 401 });
    });
    const data = await fetchClaudeUsage(dir);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([usageUrl, usageUrl]);
    expectUsageToken(winnerAccess);
    expect(data).not.toHaveProperty("error");
  });

  it("re-reads just before refresh and uses another writer's fresh login without a token grant", async () => {
    const read = fsp.readFile.bind(fsp);
    let first = true;
    vi.spyOn(fsp, "readFile").mockImplementation((async (target, options) => {
      const raw = await read(target, options);
      if (target === file && first) { first = false; write(winner()); }
      return raw;
    }) as typeof fsp.readFile);
    const data = await fetchClaudeUsage(dir);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([usageUrl]);
    expectUsageToken(winnerAccess);
    expect(data).not.toHaveProperty("error");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(winner());
  });

  it("uses a rotated login after invalid_grant, with one re-read and no repeated grant", async () => {
    const read = vi.spyOn(fsp, "readFile");
    fetchMock.mockImplementation(async url => {
      if (url === tokenUrl) {
        write(winner());
        return Response.json({ error: "invalid_grant", error_description: "Refresh token rotated" }, { status: 400 });
      }
      return Response.json(usage);
    });
    const data = await fetchClaudeUsage(dir);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([tokenUrl, usageUrl]);
    expect(read.mock.calls.filter(([target]) => target === file)).toHaveLength(3);
    expectUsageToken(winnerAccess);
    expect(data).not.toHaveProperty("error");
  });

  it("does not overwrite a concurrent successful refresh", async () => {
    const current = winner();
    fetchMock.mockImplementation(async url => {
      if (url === tokenUrl) { write(current); return Response.json(rotated); }
      return Response.json(usage);
    });
    const data = await fetchClaudeUsage(dir);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(current);
    expectUsageToken(winnerAccess);
    expect(data).not.toHaveProperty("error");
    expect(fs.readdirSync(dir)).toEqual([".credentials.json"]);
  });

  it("checks again after preparing the temporary file, without overwriting a later writer", async () => {
    const writeFile = fsp.writeFile.bind(fsp);
    vi.spyOn(fsp, "writeFile").mockImplementation((async (target, data, options) => {
      await writeFile(target, data, options);
      if (target !== file) write(winner());
    }) as typeof fsp.writeFile);
    await fetchClaudeUsage(dir);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(winner());
    expectUsageToken(winnerAccess);
    expect(fs.readdirSync(dir)).toEqual([".credentials.json"]);
  });

  it("refuses the write if unrelated credential fields changed and the on-disk token is still expired", async () => {
    const changed = credentials();
    changed.otherProvider.key = "do not overwrite";
    fetchMock.mockImplementation(async url => {
      if (url === tokenUrl) { write(changed); return Response.json(rotated); }
      return Response.json(usage);
    });
    const data = await fetchClaudeUsage(dir);
    expect(data.error).toMatch(/credentials changed.*refresh/i);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(changed);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([tokenUrl]);
    expect(fs.readdirSync(dir)).toEqual([".credentials.json"]);
  });

  it("surfaces invalid_grant through the actual quota source and both cards without tokens", async () => {
    const before = fs.readFileSync(file, "utf8");
    fetchMock.mockResolvedValue(Response.json({ error: "invalid_grant",
      error_description: `Refresh token revoked: ${oldRefresh} ${oldAccess}` }, { status: 400 }));
    const port = createUsageProviderPort({ profiles: [{ id: "claude", displayName: "Claude", configDir: dir }] });
    const [source] = createQuotaSources(port.bindings(), port);
    const quota = await source!.fetch(new AbortController().signal);
    expect(quota.ok).toBe(false);
    expect(quota.error).toMatch(/OAuth refresh.*400.*invalid_grant.*Refresh token revoked/);
    expect(JSON.stringify(renderAgentQuotaLayout([quota]))).toContain("invalid_grant");
    expect(JSON.stringify(renderAgentQuotaPanel([quota]))).toContain("invalid_grant");
    expectNoSecrets(quota);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([tokenUrl]);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(dir)).toEqual([".credentials.json"]);
  });

  it("does not refresh twice when the refreshed token is also rejected with 401", async () => {
    write(credentials(now + 3600_000));
    fetchMock.mockImplementation(async url => url === tokenUrl ? Response.json(rotated)
      : Response.json({ message: "Account access revoked" }, { status: 401 }));
    const data = await fetchClaudeUsage(dir);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([usageUrl, tokenUrl, usageUrl]);
    expect(data.error).toBe("Claude usage endpoint returned 401: Account access revoked");
  });

  it.each(["headers", "body"] as const)("honors cancellation during refresh %s without changing credentials", async stage => {
    const controller = new AbortController();
    const reason = new Error("quota refresh cancelled");
    const before = fs.readFileSync(file, "utf8");
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    fetchMock.mockImplementation(async (_url, init) => {
      const signal = init?.signal;
      const stalled = () => new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        entered();
      });
      if (stage === "headers") return await stalled();
      return { ok: true, json: stalled } as unknown as Response;
    });
    const result = fetchClaudeUsage(dir, controller.signal);
    const rejection = expect(result).rejects.toBe(reason);
    await reading;
    controller.abort(reason);
    await rejection;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(tokenUrl);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(dir)).toEqual([".credentials.json"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not commit after cancellation while writing the temporary file", async () => {
    const controller = new AbortController();
    const reason = new Error("quota refresh cancelled before commit");
    const before = fs.readFileSync(file, "utf8");
    const writeFile = fsp.writeFile.bind(fsp);
    vi.spyOn(fsp, "writeFile").mockImplementation((async (target, data, options) => {
      await writeFile(target, data, options);
      controller.abort(reason);
    }) as typeof fsp.writeFile);
    await expect(fetchClaudeUsage(dir, controller.signal)).rejects.toBe(reason);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(dir)).toEqual([".credentials.json"]);
  });

  it("reports a commit error and removes only its temporary file, leaving the original intact", async () => {
    const before = fs.readFileSync(file, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("EACCES: credential rename refused"); });
    const data = await fetchClaudeUsage(dir);
    expect(data.error).toContain("EACCES: credential rename refused");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual([".credentials.json"]);
    expectNoSecrets(data);
  });

  it("keeps the old refresh token when the server does not rotate it", async () => {
    fetchMock.mockImplementation(async url => url === tokenUrl
      ? Response.json({ access_token: newAccess, expires_in: 3600 }) : Response.json(usage));
    await fetchClaudeUsage(dir);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth).toMatchObject({
      accessToken: newAccess, refreshToken: oldRefresh, expiresAt: now + 3600_000,
    });
  });

  it.each([
    { refresh_token: newRefresh, expires_in: 3600 },
    { access_token: newAccess },
    { access_token: newAccess, expires_in: -1 },
  ])("does not replace credentials with an incomplete token response %j", async body => {
    const before = fs.readFileSync(file, "utf8");
    fetchMock.mockResolvedValue(Response.json(body));
    const data = await fetchClaudeUsage(dir);
    expect(data.error).toContain("missing a valid access_token or expires_in");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expectNoSecrets(data);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports malformed token JSON without quoting the returned token", async () => {
    const before = fs.readFileSync(file, "utf8");
    fetchMock.mockResolvedValue(new Response(`{\"access_token\":\"${newAccess}\" broken`));
    const data = await fetchClaudeUsage(dir);
    expect(data.error).toContain("OAuth refresh endpoint returned invalid JSON");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expectNoSecrets(data);
  });

  it("updates the alternate credentials file without inventing a primary one", async () => {
    const alternate = path.join(dir, "credentials.json");
    fs.renameSync(file, alternate);
    file = alternate;
    const data = await fetchClaudeUsage(dir);
    expect(data).not.toHaveProperty("error");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth.accessToken).toBe(newAccess);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["credentials.json"]);
  });
});
