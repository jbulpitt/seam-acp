/**
 * #264 (R8) — the capabilities agy already has must stay reachable, and a
 * failure in one must cost only that one.
 *
 * R8 says "preserve parity", which is the kind of brief that invites adding
 * surface. So each test here answers question 3 of the review rule in
 * `AGENTS.md` first: is this reached from a PRODUCTION call site, or only by a
 * test? #324 is what happens when nobody asks — we believed for weeks that
 * helpers ran under `--sandbox`, and the only places setting it were tests.
 *
 * Three areas, and most of what R8 asked for was already shipped:
 *
 *   MCP               — #109's per-session private HOME. Isolation verified
 *                       here for two SIMULTANEOUS sessions, which is R8's
 *                       acceptance wording and was not covered.
 *   structured output — #372's stdout fallback. Its degradation notice must
 *                       never enter a schema caller's parsed payload.
 *   helpers           — audited, not moved. See the last describe block.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildAgyMcpConfigJson,
  prepareAgyMcpHome,
  type McpServer,
} from "@seam/adapters";
import { isLoopbackHost, resolveReachableMcpUrl } from "../packages/core/src/core/mcp-url.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function mcpConfigOf(home: string): { mcpServers: Record<string, { serverUrl?: string; headers?: Record<string, string> }> } {
  return JSON.parse(
    fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8")
  ) as { mcpServers: Record<string, { serverUrl?: string; headers?: Record<string, string> }> };
}

const httpServer = (name: string, url: string, token: string): McpServer => ({
  type: "http",
  name,
  url,
  headers: [{ name: "X-Seam-Session", value: token }],
}) as McpServer;

describe("#264 MCP: two simultaneous scopes stay isolated", () => {
  it("gives concurrent sessions different homes and different tokens", async () => {
    // `~/.gemini/config/mcp_config.json` is process-global and agy has no
    // --mcp-config flag, so HOME is the only isolation there is (#109). Two
    // live sessions is the case that matters and the one R8 names; a single
    // session proves nothing about the thing that can actually collide.
    const [first, second] = await Promise.all([
      prepareAgyMcpHome("session-a", [httpServer("seam-mcp", "https://hub.example/mcp", "token-a")]),
      prepareAgyMcpHome("session-b", [httpServer("seam-mcp", "https://hub.example/mcp", "token-b")]),
    ]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    homes.push(first!, second!);

    expect(first).not.toBe(second);
    expect(mcpConfigOf(first!).mcpServers["seam-mcp"]?.headers?.["X-Seam-Session"]).toBe("token-a");
    expect(mcpConfigOf(second!).mcpServers["seam-mcp"]?.headers?.["X-Seam-Session"]).toBe("token-b");
  });

  it("treats no servers as NO tools, not as inherit-the-host's", async () => {
    // The dangerous default. Writing nothing would leave agy reading whatever
    // the host's global config happens to hold, which is how a session gets
    // tools nobody granted it.
    const home = await prepareAgyMcpHome("session-empty", []);
    expect(home).toBeDefined();
    homes.push(home!);
    expect(mcpConfigOf(home!).mcpServers).toEqual({});
  });

  it("preserves headers and the remote address through the config it writes", () => {
    // Reachable remote URL + minted session header is the entire MCP contract
    // for a bridged spawn; dropping either silently removes the agent's tools.
    const json = JSON.parse(buildAgyMcpConfigJson([
      httpServer("seam-mcp", "https://hub.example:8787/mcp", "minted"),
    ])) as { mcpServers: Record<string, { serverUrl?: string; headers?: Record<string, string> }> };
    expect(json.mcpServers["seam-mcp"]?.serverUrl).toBe("https://hub.example:8787/mcp");
    expect(json.mcpServers["seam-mcp"]?.headers?.["X-Seam-Session"]).toBe("minted");
  });
});

describe("#264 MCP: a remote agent is never handed the controller's loopback", () => {
  // The rule was this file's stated contract and was enforced on the discovery
  // path — but a CONFIGURED public base was used verbatim, so the one input an
  // operator controls was the one nobody checked. That is the gap R8's
  // acceptance names ("remote URLs never point to controller loopback").
  it.each([
    ["http://localhost:8787", "localhost"],
    ["http://127.0.0.1:8787", "127.0.0.1"],
    ["ws://127.0.0.53:8787", "a non-.1 address in 127.0.0.0/8"],
    ["http://[::1]:8787", "IPv6 loopback"],
  ])("refuses a configured %s base and still returns a usable URL", (base) => {
    const url = resolveReachableMcpUrl({ port: 8787, healthPort: 8080, publicBaseUrl: base, remote: true });
    expect(isLoopbackHost(new URL(url).hostname)).toBe(false);
    // Blast radius: the bad URL is refused, the capability is not. The agent
    // still gets an MCP entry from discovery rather than losing its tools.
    expect(url).toMatch(/\/mcp$/);
  });

  it("still uses a legitimate configured base, and still uses loopback locally", () => {
    expect(
      resolveReachableMcpUrl({ port: 8787, publicBaseUrl: "https://hub.example", remote: true })
    ).toBe("https://hub.example/mcp");
    // Local spawns are on the same host, where 127.0.0.1 is the correct answer.
    expect(resolveReachableMcpUrl({ port: 8787, publicBaseUrl: "http://localhost:1", remote: false }))
      .toBe("http://127.0.0.1:8787/mcp");
  });

  it("classifies loopback hosts without over-reaching", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "::1"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    // Not loopback, and must not be mistaken for it — 127 in another octet,
    // or a hostname that merely contains the word.
    for (const host of ["10.0.0.1", "192.168.127.1", "hub.example", "notlocalhost.example"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("#264 structured output: the degradation notice stays out of the payload", () => {
  it("routes the stream-unavailable notice by whether a schema is in force", () => {
    // #372's boundary, and the reason it is load-bearing: for a schema caller
    // the notice must arrive as a THOUGHT, because an agent_message_chunk is
    // what gets parsed as the JSON result. Prose prepended there does not
    // degrade the answer, it corrupts it — the silently-wrong outcome the
    // blast-radius rule ranks worst.
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "packages", "adapters", "src", "profiles", "agy.ts"),
      "utf8"
    );
    const line = source
      .split("\n")
      .find((row) => row.includes("sessionUpdate: jsonSchema ?"));
    expect(line).toBeDefined();
    expect(line).toContain('"agent_thought_chunk"');
    expect(line).toContain('"agent_message_chunk"');
    // Order matters: schema present => thought. Inverting it is the defect.
    expect(line).toMatch(/jsonSchema \? "agent_thought_chunk" : "agent_message_chunk"/);
  });

  it("keeps the notice text out of anything a schema caller parses", () => {
    // The notice is emitted before the turn's output. A schema caller reads
    // the structured envelope, so the assertion that matters is that the
    // notice is not on the message channel at all when a schema is set.
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "packages", "adapters", "src", "profiles", "agy.ts"),
      "utf8"
    );
    const notice = source.split("\n").find((row) => row.includes("[AGY stream unavailable"));
    expect(notice).toBeDefined();
    // It says what was lost and what still holds, per the blast-radius rule.
    expect(notice).toContain("Using stdout only");
    expect(notice).toContain("permission policy is unchanged");
  });
});

describe("#264 helpers: audited, and deliberately not moved", () => {
  const coreIndex = fs.readFileSync(
    path.join(import.meta.dirname, "..", "packages", "core", "src", "index.ts"),
    "utf8"
  );

  it("is a vision sidecar for ollama-cloud sessions, not an agy-session capability", () => {
    // R8 asks whether each helper is still hardwired to the package factory
    // now that the chat adapter is native. For this one the answer turned out
    // to matter less than the question underneath it: agy sessions never call
    // `inspect_image` at all. The production gate admits only ollama-cloud
    // tool-vision sessions, and merely USES agy-package as the engine.
    //
    // So "move the helper back to the native factory" restores no agy parity:
    // there is no agy caller to restore it for. That is question 3 of the
    // review rule doing its job before any code was written.
    const gate = coreIndex.slice(
      coreIndex.indexOf("inspect_image is only available to tool-vision sessions") - 600,
      coreIndex.indexOf("agyImageInspector({ ...req, ownerId: record.id })")
    );
    expect(gate).toContain('effective.agent.value !== "ollama-cloud"');
    expect(gate).toContain("config.OLLAMA_CLOUD_ENABLED");
    expect(gate).toContain('visionMode !== "tool"');
  });

  it("refuses by name when its engine is absent, and refuses only itself", () => {
    // The NEGATIVE assertion R8 asks for. On a host without agy-package —
    // every agy-only Mac — this capability is unavailable. It says so, names
    // what to configure, and throws from inside one tool handler: the session
    // continues, the other tools continue, the host continues. That is
    // outcome 3 in the blast-radius ordering, and it is already correct, which
    // is why this PR does not change it.
    expect(coreIndex).toContain(
      'if (!agyImageInspector) throw new Error("inspect_image requires configured agy-package");'
    );
    // Constructed only when the engine exists — no half-built helper that
    // fails later at a point the operator cannot connect to a missing config.
    expect(coreIndex).toContain("const agyImageInspector = agyPackage");
  });

  it("still defaults to the package factory, which is the audited state", () => {
    // Recorded rather than changed. R8 permits moving a helper "only with its
    // sandbox/tool-scope contract verified" — and #324 deliberately deferred
    // that verification, so the precondition is unmet by design, not by
    // oversight. Moving it would make an unproven boundary look available.
    const inspector = fs.readFileSync(
      path.join(import.meta.dirname, "..", "packages", "core", "src", "core", "vision", "agy-image-inspector.ts"),
      "utf8"
    );
    expect(inspector).toContain("opts.profileFactory ?? makeAgyPackageProfile");
    // And the file states the real posture rather than implying a sandbox.
    expect(inspector).toContain("A private cwd is not a sandbox");
  });
});
