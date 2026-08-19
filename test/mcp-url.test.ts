import { describe, it, expect } from "vitest";
import { buildSeamMcpServerEntry } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import { resolveReachableMcpUrl, publicBaseFromTunnelUrl } from "../packages/core/src/core/mcp-url.js";

describe("reachable seam-MCP URL (#84)", () => {
  it("local spawn still uses 127.0.0.1", () => {
    expect(resolveReachableMcpUrl({ port: 4321, remote: false })).toBe(
      "http://127.0.0.1:4321/mcp"
    );
    const entry = buildSeamMcpServerEntry(4321, "tok-abc") as {
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
    expect(entry.url).toBe("http://127.0.0.1:4321/mcp");
    expect(entry.headers).toEqual([{ name: "X-Seam-Session", value: "tok-abc" }]);
  });

  it("remote spawn never uses 127.0.0.1 when a public base is set", () => {
    const url = resolveReachableMcpUrl({
      port: 9,
      remote: true,
      publicBaseUrl: "https://tunnel.example",
    });
    expect(url).toBe("https://tunnel.example/mcp");
    expect(url).not.toContain("127.0.0.1");
    const entry = buildSeamMcpServerEntry(9, "sess-token", { url }) as {
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
    expect(entry.url).toBe(url);
    expect(entry.headers).toEqual([{ name: "X-Seam-Session", value: "sess-token" }]);
  });

  it("converts a wss tunnel to https /mcp", () => {
    expect(publicBaseFromTunnelUrl("wss://abc.trycloudflare.com")).toBe(
      "https://abc.trycloudflare.com"
    );
    const url = resolveReachableMcpUrl({
      port: 1,
      remote: true,
      publicBaseUrl: publicBaseFromTunnelUrl("wss://abc.trycloudflare.com"),
    });
    expect(url).toBe("https://abc.trycloudflare.com/mcp");
  });

  it("remote fallback is not 127.0.0.1", () => {
    const url = resolveReachableMcpUrl({ port: 3000, healthPort: 3000, remote: true });
    expect(url.startsWith("http://127.0.0.1")).toBe(false);
    expect(url.endsWith("/mcp")).toBe(true);
  });
});
