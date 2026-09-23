/**
 * #595 — sessiond outlives login sessions, so its socket and slot table must
 * never resolve into a session-scoped directory. The original defect was not a
 * crash: logind deleted /run/user/<uid> at last logout while the daemon kept
 * running and holding its socket fd, so reattachment was dead but every
 * process-level check still reported healthy.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { defaultSessiondPaths } from "../packages/bridge/src/sessiond-paths.js";

describe("defaultSessiondPaths", () => {
  it("never resolves under XDG_RUNTIME_DIR, even when one is offered", () => {
    const paths = defaultSessiondPaths({
      HOME: "/home/someone",
      XDG_RUNTIME_DIR: "/run/user/1001",
    });
    // The regression this file exists for: a login-scoped base is deleted out
    // from under a live daemon, taking slots.json with it.
    expect(paths.socketPath.startsWith("/run/user/")).toBe(false);
    expect(paths.statePath.startsWith("/run/user/")).toBe(false);
  });

  it("anchors both paths to HOME, whose lifetime matches the daemon's", () => {
    const paths = defaultSessiondPaths({ HOME: "/home/someone" });
    const expected = path.join("/home/someone", ".seam", "sessiond");
    expect(paths.socketPath).toBe(path.join(expected, "control.sock"));
    expect(paths.statePath).toBe(path.join(expected, "slots.json"));
  });

  it("honours explicit overrides so a managed RuntimeDirectory still wins", () => {
    // The controller's systemd unit sets RuntimeDirectory=seam-sessiond and
    // passes both paths. That directory IS durable for the unit's lifetime, so
    // it must keep working rather than being second-guessed here.
    const paths = defaultSessiondPaths({
      HOME: "/home/someone",
      SEAM_SESSIOND_SOCKET: "/run/seam-sessiond/control.sock",
      SEAM_SESSIOND_STATE: "/run/seam-sessiond/slots.json",
    });
    expect(paths.socketPath).toBe("/run/seam-sessiond/control.sock");
    expect(paths.statePath).toBe("/run/seam-sessiond/slots.json");
  });

  it("refuses loudly when it cannot resolve a durable directory", () => {
    // Falling back to tmpdir would reintroduce the same silent failure on any
    // host that reaps /tmp. Refusing is the point.
    expect(() => defaultSessiondPaths({ XDG_RUNTIME_DIR: "/run/user/1001" }))
      .toThrow(/HOME is unset/);
  });

  it("still refuses when only one override is supplied", () => {
    expect(() => defaultSessiondPaths({ SEAM_SESSIOND_SOCKET: "/run/x/control.sock" }))
      .toThrow(/HOME is unset/);
  });
});
