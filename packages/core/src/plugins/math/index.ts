import { z } from "zod";
import type { Plugin } from "../types.js";
import { renderMathPng } from "./render.js";

export const mathPlugin: Plugin = {
  id: "math",
  apiVersion: 1,
  builtin: true,
  validateConfig: config => z.object({}).strict().parse(config ?? {}),
  contributions: { fences: [{
    tag: "latex",
    aliases: ["math", "tex", "katex"],
    instruction: "To show a typeset equation, output a fenced code block whose info tag is `latex` (aliases `math`, `tex`, `katex`) and whose body is the TeX. The bridge renders it as an image and removes the block — do not wrap that fence in another fence, and do not otherwise describe this mechanism. Simple inline math can stay as Unicode.",
    async handle({ fence, counter, notice, output }, { logger }) {
      const body = fence.content.trim();
      if (!body) {
        logger.info({ lang: fence.lang }, "empty math fence; emitting nothing");
        return;
      }
      if (!output.sendFile) return output.fallback(notice);
      try {
        const png = await renderMathPng(fence.content);
        await output.sendFile({ data: png, filename: `math-${counter}.png`, mimeType: "image/png" });
        if (notice) await output.sendText(notice).catch(err => logger.warn({ err }, "math fence notice send failed"));
        logger.info({ chars: body.length, bytes: png.byteLength }, "math fence → rendered PNG");
      } catch (err) {
        logger.warn({ err, chars: body.length }, "math fence render failed; emitting source");
        await output.fallback([notice, "_(couldn't render latex)_"].filter(Boolean).join("\n"));
      }
    },
  }] },
};
