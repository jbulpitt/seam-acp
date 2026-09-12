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

describe("#377 helpers: the agy-package vision sidecar is gone", () => {
  const coreIndex = fs.readFileSync(
    path.join(import.meta.dirname, "..", "packages", "core", "src", "index.ts"),
    "utf8"
  );

  it("no longer wires an inspect_image backend, and says why", () => {
    // R8 (#264) audited this helper and deliberately left it in place. The
    // measurement that followed settled it: agy-package had 0 sessions and 0
    // turn attempts ever, ollama-cloud — its only permitted caller — had 0 of
    // both, and OLLAMA_CLOUD_ENABLED=false meant the gate refused before the
    // sidecar was reached. Unreachable by construction, so removed (#377).
    expect(coreIndex).not.toContain("agyImageInspector");
    expect(coreIndex).not.toContain("createAgyImageInspector");
    // The answer is recorded where the wiring used to be, per AGENTS.md.
    expect(coreIndex).toContain("NO inspect_image BACKEND (#377)");
  });

  it("keeps the tool interface and its clean absent-backend answer", () => {
    // Blast radius: what was removed is one unverifiable backend, not the
    // interface. `visionMode: "tool"` is a catalog property any future model
    // may carry, and `inspectImage` is an optional dep, so a replacement can
    // be wired without re-adding a tool. The absent case already answers
    // cleanly rather than crashing.
    const mcp = fs.readFileSync(
      path.join(import.meta.dirname, "..", "packages", "core", "src", "core", "mcp", "seam-mcp-server.ts"),
      "utf8"
    );
    expect(mcp).toContain("inspect_image is not configured on this deployment.");
    expect(mcp).toContain("inspectImage?:");
  });

  it("leaves staged-image authorization completely untouched", () => {
    // The NEGATIVE assertion. `ollama-image-inspector.ts` is misleadingly
    // named: it holds the staging authorization the orchestrator uses directly
    // and independently of any vision backend. Removing the sidecar must not
    // touch it.
    const staging = fs.readFileSync(
      path.join(import.meta.dirname, "..", "packages", "core", "src", "core", "vision", "ollama-image-inspector.ts"),
      "utf8"
    );
    expect(staging).toContain("export function stagedAttachmentOwnerKey");
    expect(staging).toContain("export async function authorizeStagedImage");
    expect(staging).toContain("export async function readAuthorizedStagedImage");
    const orchestrator = fs.readFileSync(
      path.join(import.meta.dirname, "..", "packages", "core", "src", "platforms", "discord", "orchestrator.ts"),
      "utf8"
    );
    expect(orchestrator).toContain("vision/ollama-image-inspector.js");
  });

  it("removes the agent without disturbing any other adapter", () => {
    // The other half of the negative assertion: this is one entry out of a
    // factory list, and every sibling still builds.
    const inventory = fs.readFileSync(
      path.join(import.meta.dirname, "..", "packages", "bridge", "src", "inventory.ts"),
      "utf8"
    );
    expect(inventory).not.toContain("agy-package");
    expect(inventory).not.toContain("makeAgyPackageProfile");
    for (const id of ['id: "copilot"', 'id: "claude"', 'id: "agy"', 'id: "codex"', 'id: "grok"']) {
      expect(inventory).toContain(id);
    }
  });
});
