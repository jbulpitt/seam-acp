import { describe, it, expect } from "vitest";
import { makeMux } from "@seam/adapters";

describe("makeMux export from @seam/adapters", () => {
  it("is exported as a function", () => {
    expect(typeof makeMux).toBe("function");
  });

  it("returns attach, spawn, and sendCmd (slot mux surface)", () => {
    const mux = makeMux({ id: "export-probe" });
    expect(typeof mux.attach).toBe("function");
    expect(typeof mux.spawn).toBe("function");
    expect(typeof mux.sendCmd).toBe("function");
    expect(typeof mux.releaseStdin).toBe("function");
  });
});
