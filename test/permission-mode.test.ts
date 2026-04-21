import { describe, it, expect } from "vitest";
import { resolvePermissionMode } from "../src/core/types.js";

describe("resolvePermissionMode", () => {
  it("uses new field when present", () => {
    expect(resolvePermissionMode({ permissionPolicy: "always" }, "ask")).toBe("always");
    expect(resolvePermissionMode({ permissionPolicy: "ask" }, "deny")).toBe("ask");
    expect(resolvePermissionMode({ permissionPolicy: "deny" }, "always")).toBe("deny");
  });

  it("treats legacy autoApprovePermissions=true as 'always'", () => {
    expect(resolvePermissionMode({ autoApprovePermissions: true }, "ask")).toBe("always");
  });

  it("ignores legacy autoApprovePermissions=false (falls through to default)", () => {
    expect(resolvePermissionMode({ autoApprovePermissions: false }, "ask")).toBe("ask");
    expect(resolvePermissionMode({ autoApprovePermissions: false }, "deny")).toBe("deny");
  });

  it("falls back to bot-wide default when neither field is set", () => {
    expect(resolvePermissionMode({}, "ask")).toBe("ask");
    expect(resolvePermissionMode({}, "deny")).toBe("deny");
    expect(resolvePermissionMode({}, "always")).toBe("always");
  });

  it("prefers new field over legacy field when both present", () => {
    expect(
      resolvePermissionMode(
        { permissionPolicy: "deny", autoApprovePermissions: true },
        "ask"
      )
    ).toBe("deny");
  });
});
