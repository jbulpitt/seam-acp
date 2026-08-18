/**
 * Typeset a TeX body to a PNG for Discord (issue #79).
 *
 * Isolated here so the orchestrator never imports MathJax. Engine init is a
 * lazy singleton — first equation pays the cost, not process start.
 *
 * MathJax SVG uses `currentColor` and `ex` units. We pin an explicit Discord
 * dark-mode fill and a concrete font-size/viewport before resvg, otherwise
 * glyphs render invisible or black on dark backgrounds.
 */
import { Resvg } from "@resvg/resvg-js";
import { isMathFenceLang } from "./agent-conventions.js";

export { isMathFenceLang };

export const MATH_MAX_TEX_CHARS = 4000;
export const MATH_RENDER_TIMEOUT_MS = 2000;

const DISCORD_DARK_FILL = "#dcddde";
const FONT_SIZE_PX = 16;
const PADDING_PX = 20;
const RASTER_SCALE = 4;
/** MathJax SVG user-units per em. Used to convert viewBox → CSS px. */
const MATHJAX_UNITS_PER_EM = 1000;

type Engine = {
  convertToSvg: (tex: string) => string;
};

let engine: Engine | undefined;
let enginePromise: Promise<Engine> | undefined;

async function getEngine(): Promise<Engine> {
  if (engine) return engine;
  if (!enginePromise) {
    enginePromise = initEngine().catch((err) => {
      enginePromise = undefined;
      throw err;
    });
  }
  engine = await enginePromise;
  return engine;
}

async function initEngine(): Promise<Engine> {
  const [
    { mathjax },
    { TeX },
    { SVG },
    { liteAdaptor },
    { RegisterHTMLHandler },
    { AllPackages },
  ] = await Promise.all([
    import("mathjax-full/js/mathjax.js"),
    import("mathjax-full/js/input/tex.js"),
    import("mathjax-full/js/output/svg.js"),
    import("mathjax-full/js/adaptors/liteAdaptor.js"),
    import("mathjax-full/js/handlers/html.js"),
    import("mathjax-full/js/input/tex/AllPackages.js"),
  ]);

  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const html = mathjax.document("", {
    InputJax: new TeX({
      packages: AllPackages,
      tags: "none",
      // Prefer a throw over an merror glyph so callers can fail-open to source.
      formatError: (_jax: unknown, err: { message?: string }) => {
        throw new Error(err?.message ? `TeX error: ${err.message}` : "TeX error");
      },
    }),
    OutputJax: new SVG({ fontCache: "none" }),
  });
  return {
    convertToSvg: (tex: string) => adaptor.innerHTML(html.convert(tex, { display: true })),
  };
}

/**
 * Pin fill + concrete viewport so `currentColor` / `ex` resolve, then add
 * ~20px padding. Rasterize at 4× for high-DPI sharpness.
 */
function prepareSvg(svg: string): string {
  let out = svg.replace(/currentColor/gi, DISCORD_DARK_FILL);

  const vbMatch = /viewBox="([^"]+)"/i.exec(out);
  const parts = vbMatch?.[1]?.trim().split(/[\s,]+/).map(Number) ?? [];
  const minX = parts[0];
  const minY = parts[1];
  const vbW = parts[2];
  const vbH = parts[3];
  if (
    minX !== undefined &&
    minY !== undefined &&
    vbW !== undefined &&
    vbH !== undefined &&
    [minX, minY, vbW, vbH].every(Number.isFinite)
  ) {
    const padUnits = (PADDING_PX * MATHJAX_UNITS_PER_EM) / FONT_SIZE_PX;
    const newMinX = minX - padUnits;
    const newMinY = minY - padUnits;
    const newW = vbW + 2 * padUnits;
    const newH = vbH + 2 * padUnits;
    const pxW = (vbW * FONT_SIZE_PX) / MATHJAX_UNITS_PER_EM + 2 * PADDING_PX;
    const pxH = (vbH * FONT_SIZE_PX) / MATHJAX_UNITS_PER_EM + 2 * PADDING_PX;
    out = out.replace(/viewBox="[^"]+"/i, `viewBox="${newMinX} ${newMinY} ${newW} ${newH}"`);
    if (/\bwidth="/i.test(out)) {
      out = out.replace(/\bwidth="[^"]+"/i, `width="${pxW}px"`);
    } else {
      out = out.replace(/<svg\b/i, `<svg width="${pxW}px"`);
    }
    if (/\bheight="/i.test(out)) {
      out = out.replace(/\bheight="[^"]+"/i, `height="${pxH}px"`);
    } else {
      out = out.replace(/<svg\b/i, `<svg height="${pxH}px"`);
    }
  }

  if (!/\bfont-size=/i.test(out) && !/font-size:/i.test(out)) {
    out = out.replace(/<svg\b/i, `<svg font-size="${FONT_SIZE_PX}px"`);
  }
  return out;
}

function rasterizeSvg(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: RASTER_SCALE },
    background: "rgba(0,0,0,0)",
  });
  return Buffer.from(resvg.render().asPng());
}

async function renderMathPngInner(tex: string): Promise<Buffer> {
  const { convertToSvg } = await getEngine();
  const raw = convertToSvg(tex);
  if (!raw || !/<svg\b/i.test(raw)) {
    throw new Error("MathJax produced no SVG");
  }
  const png = rasterizeSvg(prepareSvg(raw));
  if (png.byteLength < 8) {
    throw new Error("resvg produced an empty PNG");
  }
  return png;
}

/** Typeset `tex` (display mode) to a PNG buffer. Throws on empty, oversize,
 *  invalid TeX, engine failure, or a ~2s timeout. */
export async function renderMathPng(tex: string): Promise<Buffer> {
  const body = tex.trim();
  if (!body) {
    throw new Error("empty math body");
  }
  if (tex.length > MATH_MAX_TEX_CHARS || body.length > MATH_MAX_TEX_CHARS) {
    throw new Error(`math body exceeds ${MATH_MAX_TEX_CHARS} characters`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`math render timed out after ${MATH_RENDER_TIMEOUT_MS}ms`)),
      MATH_RENDER_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([renderMathPngInner(body), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
