import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  discoverAgyLs,
  waitForAgyConversationId,
} from "../src/agents/agy-stream.js";

// Regression coverage for the intermittent agy empty-response bug: two agy
// turns running at once used to cross-wire because port + cascade discovery
// scanned agy's SHARED global dirs by recency ("newest wins"), so turn A could
// latch onto turn B's just-booted language server / just-created cascade.
//
// The fix gives every spawn a private `--log-file` and reads BOTH the port and
// the conversation id back from THAT file. These tests assert the read is
// file-scoped: given two independent log files (two concurrent turns), each
// resolves only to its own server/cascade — never the other's.

const tmpFiles: string[] = [];
const servers: Server[] = [];

async function writeTmp(contents: string): Promise<string> {
  const p = path.join(os.tmpdir(), `agy-discovery-test-${randomUUID()}.log`);
  await fs.writeFile(p, contents);
  tmpFiles.push(p);
  return p;
}

/** A fake agy language server: /healthz returns ok with a unique instanceId. */
async function startFakeLs(): Promise<{ port: number; instanceId: string }> {
  const instanceId = randomUUID();
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", instanceId }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, instanceId };
}

/** The exact log line agy emits for its plain-HTTP Connect port. */
function portLogLine(port: number): string {
  return `ERROR: logging before google.Init: I0815 12:44:45.585567       9 server.go:596] Language server listening on random port at ${port} for HTTP\n`;
}

afterEach(async () => {
  await Promise.all(tmpFiles.splice(0).map((p) => fs.unlink(p).catch(() => {})));
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

describe("waitForAgyConversationId", () => {
  it("parses the `Created conversation <id>` form", async () => {
    const id = randomUUID();
    const file = await writeTmp(
      `some preamble\nI0815 ... server.go:1074] Created conversation ${id}\nmore lines\n`,
    );
    await expect(waitForAgyConversationId({ logFile: file })).resolves.toBe(id);
  });

  it("parses the `Print mode: conversation=<id>` form", async () => {
    const id = randomUUID();
    const file = await writeTmp(
      `printmode.go:340] Print mode: conversation=${id}, sending message\n`,
    );
    await expect(waitForAgyConversationId({ logFile: file })).resolves.toBe(id);
  });

  it("binds each concurrent turn to its OWN cascade id (no cross-wire)", async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    // Two private logs, as two overlapping turns would produce. B's file is
    // written second (would be 'newest' under the old recency scan).
    const fileA = await writeTmp(`Created conversation ${idA}\n`);
    const fileB = await writeTmp(`Created conversation ${idB}\n`);

    const [gotA, gotB] = await Promise.all([
      waitForAgyConversationId({ logFile: fileA }),
      waitForAgyConversationId({ logFile: fileB }),
    ]);

    // Each resolves to its own id — recency of the other file is irrelevant.
    expect(gotA).toBe(idA);
    expect(gotB).toBe(idB);
    expect(gotA).not.toBe(gotB);
  });

  it("waits for the id line to appear, then returns it", async () => {
    const id = randomUUID();
    const file = await writeTmp("starting up, no conversation yet\n");
    // Append the id line shortly after discovery begins.
    setTimeout(() => {
      void fs.appendFile(file, `Created conversation ${id}\n`);
    }, 120);
    await expect(
      waitForAgyConversationId({ logFile: file, timeoutMs: 3_000 }),
    ).resolves.toBe(id);
  });

  it("throws on timeout when the id never appears", async () => {
    const file = await writeTmp("no conversation id here, ever\n");
    await expect(
      waitForAgyConversationId({ logFile: file, timeoutMs: 300 }),
    ).rejects.toThrow(/conversation id/i);
  });
});

describe("discoverAgyLs (logFile-scoped port readback)", () => {
  it("reads the port from the given log file and health-checks it", async () => {
    const ls = await startFakeLs();
    const file = await writeTmp(portLogLine(ls.port));
    const found = await discoverAgyLs({ logFile: file, timeoutMs: 3_000 });
    expect(found.port).toBe(ls.port);
    expect(found.instanceId).toBe(ls.instanceId);
  });

  it("routes two concurrent turns to their OWN language server (no cross-wire)", async () => {
    const lsA = await startFakeLs();
    const lsB = await startFakeLs();
    const fileA = await writeTmp(portLogLine(lsA.port));
    const fileB = await writeTmp(portLogLine(lsB.port));

    const [foundA, foundB] = await Promise.all([
      discoverAgyLs({ logFile: fileA, timeoutMs: 3_000 }),
      discoverAgyLs({ logFile: fileB, timeoutMs: 3_000 }),
    ]);

    expect(foundA.port).toBe(lsA.port);
    expect(foundA.instanceId).toBe(lsA.instanceId);
    expect(foundB.port).toBe(lsB.port);
    expect(foundB.instanceId).toBe(lsB.instanceId);
    expect(foundA.port).not.toBe(foundB.port);
  });
});
