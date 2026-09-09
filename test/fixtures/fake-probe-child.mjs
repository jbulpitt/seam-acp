#!/usr/bin/env node
/**
 * Fake child for the #236 shared probe lifecycle tests.
 *
 * `FAKE_PROBE_MODE` selects a behaviour:
 *   ready         — print one line, then stay alive until terminated
 *   exit          — exit immediately with a stderr message
 *   garbage       — print non-protocol noise, then stay alive
 *   silent        — never print anything (drives the timeout path)
 *   ignore-sigterm— record SIGTERM and refuse to die (drives SIGKILL fallback)
 *
 * `FAKE_PROBE_SIGNAL_LOG`, when set, receives one line per signal received —
 * the evidence that termination is SIGTERM-first with a SIGKILL fallback.
 */
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_PROBE_MODE ?? "ready";
const signalLog = process.env.FAKE_PROBE_SIGNAL_LOG;

if (mode === "exit") {
  process.stderr.write("fake probe child refused to start\n");
  process.exit(4);
}

if (signalLog || mode === "ignore-sigterm") {
  process.on("SIGTERM", () => {
    if (signalLog) appendFileSync(signalLog, "SIGTERM\n");
    if (mode !== "ignore-sigterm") process.exit(0);
    // else: deliberately refuse to die, so only SIGKILL can end this process.
  });
}

// Announce readiness AFTER the signal handler is installed, so a test can wait
// for it and know SIGTERM will actually be observed rather than racing startup.
if (mode === "ready" || mode === "ignore-sigterm") process.stdout.write("READY\n");
if (mode === "garbage") process.stdout.write("<<not protocol output>>\n");

// Hold the event loop open until we are terminated.
setInterval(() => {}, 1 << 30);
