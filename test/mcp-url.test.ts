import { describe, it, expect } from "vitest";
import { buildSeamMcpServerEntry } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import {
  resolveReachableMcpUrl,
  publicBaseFromTunnelUrl,
  normalizePublicBridgeWsUrl,
  resolvePublicBridgeWsUrl,
  publicBaseFromBridgeWsUrl,
  resolveIngestPublicBase,
  dialedOriginFromUpgrade,
} from "../packages/core/src/core/mcp-url.js";

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

describe("permanent bridge public URL", () => {
  it("normalizes host, https, and missing /bridge", () => {
    expect(normalizePublicBridgeWsUrl("seam.example.com")).toBe(
      "wss://seam.example.com/bridge"
    );
    expect(normalizePublicBridgeWsUrl("https://seam.example.com")).toBe(
      "wss://seam.example.com/bridge"
    );
    expect(normalizePublicBridgeWsUrl("wss://seam.example.com/bridge")).toBe(
      "wss://seam.example.com/bridge"
    );
  });

  it("prefers SEAM_BRIDGE_PUBLIC_URL over the quick-tunnel file", () => {
    const url = resolvePublicBridgeWsUrl({
      configured: "wss://seam.example.com/bridge",
      tunnelUrl: "wss://yamaha-airport-street-almost.trycloudflare.com",
      healthPort: 3000,
    });
    expect(url).toBe("wss://seam.example.com/bridge");
    expect(url).not.toContain("trycloudflare");
  });

  it("falls back to tunnel-url.txt when the flag is unset", () => {
    expect(
      resolvePublicBridgeWsUrl({
        configured: "",
        tunnelUrl: "wss://abc.trycloudflare.com",
        healthPort: 3000,
      })
    ).toBe("wss://abc.trycloudflare.com/bridge");
  });

  it("loopback is last resort", () => {
    expect(
      resolvePublicBridgeWsUrl({ configured: undefined, tunnelUrl: null, healthPort: 3000 })
    ).toBe("ws://127.0.0.1:3000/bridge");
  });

  it("MCP origin strips /bridge so we do not produce /bridge/mcp", () => {
    expect(publicBaseFromBridgeWsUrl("wss://seam.example.com/bridge")).toBe(
      "https://seam.example.com"
    );
  });
});

describe("ingest public origin", () => {
  it("SEAM_INGEST_PUBLIC_URL wins over the bridge URL", () => {
    expect(
      resolveIngestPublicBase({
        ingestPublicUrl: "https://ingest.example.com/",
        bridgeWsUrl: "wss://seam.example.com/bridge",
        healthPort: 3000,
      })
    ).toBe("https://ingest.example.com");
  });

  it("falls back to the bridge origin when ingest public URL is unset", () => {
    expect(
      resolveIngestPublicBase({
        ingestPublicUrl: "",
        bridgeWsUrl: "wss://seam.example.com/bridge",
        healthPort: 3000,
      })
    ).toBe("https://seam.example.com");
  });

  it("loopback is last resort", () => {
    expect(
      resolveIngestPublicBase({
        ingestPublicUrl: undefined,
        bridgeWsUrl: null,
        healthPort: 3000,
      })
    ).toBe("http://127.0.0.1:3000");
  });
});

describe("seam-MCP follows the origin a bridge dialed (#650)", () => {
  it("a bridge on the WireGuard link gets its private http origin", () => {
    const origin = dialedOriginFromUpgrade({ host: "192.0.2.10:3000" });
    expect(origin).toBe("http://192.0.2.10:3000");
    expect(resolveReachableMcpUrl({ port: 4321, publicBaseUrl: origin, remote: true }))
      .toBe("http://192.0.2.10:3000/mcp");
  });

  it("a bridge through the tunnel keeps the public https origin", () => {
    expect(dialedOriginFromUpgrade({
      host: "seam.example.com",
      "x-forwarded-proto": "https",
    })).toBe("https://seam.example.com");
  });

  it("a loopback or missing host falls back to the public URL", () => {
    expect(dialedOriginFromUpgrade({ host: "127.0.0.1:3000" })).toBeUndefined();
    expect(dialedOriginFromUpgrade({})).toBeUndefined();
  });
});
