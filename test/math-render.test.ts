import { describe, it, expect } from "vitest";
import { renderMathPng } from "../packages/core/src/plugins/math/render.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf: Buffer): boolean {
  return buf.subarray(0, 8).equals(PNG_SIG) && buf.byteLength > 100;
}

describe("renderMathPng", () => {
  it("typesets Euler's identity to a PNG", async () => {
    const buf = await renderMathPng("e^{i\\pi}+1=0");
    expect(isPng(buf)).toBe(true);
  });

  it("typesets a denser display fixture to a PNG", async () => {
    const tex = "\\begin{aligned} a &= b+c \\\\ x &= \\frac{1}{2} \\end{aligned}";
    const buf = await renderMathPng(tex);
    expect(isPng(buf)).toBe(true);
  });

  it("throws on empty or whitespace-only body", async () => {
    await expect(renderMathPng("")).rejects.toThrow(/empty/i);
    await expect(renderMathPng("   \n\t  ")).rejects.toThrow(/empty/i);
  });

  it("throws on a 4001-char body (D9)", async () => {
    await expect(renderMathPng("x".repeat(4001))).rejects.toThrow(/4000/);
  });

  it("throws on invalid TeX rather than rendering an error box", async () => {
    await expect(renderMathPng("\\notARealMacro{")).rejects.toThrow();
  });
});
