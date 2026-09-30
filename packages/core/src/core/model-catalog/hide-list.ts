import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../lib/logger.js";
import type { CatalogBinding } from "./service.js";

export function modelPatternMatches(pattern: string, binding: CatalogBinding, model: string): boolean {
  const colon = pattern.indexOf(":");
  const scope = colon < 0 ? null : pattern.slice(0, colon);
  const glob = colon < 0 ? pattern : pattern.slice(colon + 1);
  if (scope !== null) {
    const [agent, host] = scope.split("@");
    if (agent !== binding.agentId || (host !== undefined && host !== binding.location)) return false;
  }
  const escaped = glob.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(model);
}

export function normalizeModelPattern(pattern: string): string {
  const value = pattern.trim();
  if (!value || !/^(?:[^\s:@*]+(?:@[^\s:@*]+)?:)?[^\s:]+$/.test(value)) {
    throw new Error("Use [agent[@host]:]model-glob, with * wildcards in the model.");
  }
  return value;
}

/** Read on access so atomic file replacements are visible without a restart. */
export class ModelHideList {
  private patterns: string[] = [];
  private contents: string | undefined;

  constructor(readonly file: string, private readonly logger: Logger) {}

  list(): string[] {
    try {
      const contents = fs.readFileSync(this.file, "utf8");
      if (contents !== this.contents) {
        const parsed: unknown = JSON.parse(contents);
        if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
          throw new Error("model-hide.json must contain an array of patterns");
        }
        const next = [...new Set(parsed.map(normalizeModelPattern))];
        this.patterns = next;
        this.contents = contents;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.patterns = [];
        this.contents = undefined;
      } else {
        this.logger.warn({ err, file: this.file }, "model hide list reload failed; keeping previous list");
      }
    }
    return [...this.patterns];
  }

  hidden(binding: CatalogBinding, model: string): boolean {
    return this.list().some((pattern) => modelPatternMatches(pattern, binding, model));
  }

  change(action: "hide" | "unhide", pattern: string): { before: string[]; after: string[] } {
    const normalized = normalizeModelPattern(pattern);
    const before = this.list();
    const after = action === "hide"
      ? [...new Set([...before, normalized])]
      : before.filter((entry) => entry !== normalized);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(after, null, 2)}\n`, "utf8");
    fs.renameSync(temp, this.file);
    this.list();
    return { before, after };
  }
}
