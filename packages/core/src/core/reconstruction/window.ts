import { ReconstructionUnavailableError } from "./types.js";

export function resolveDestinationContextWindow(opts: {
  destinationModel: string;
  lastContextUsage?: { model: string; size: number };
  staticContextLimit?: number;
}): number {
  const usage = opts.lastContextUsage;
  if (
    usage &&
    usage.model === opts.destinationModel &&
    Number.isFinite(usage.size) &&
    usage.size > 0
  ) {
    return Math.floor(usage.size);
  }
  if (opts.staticContextLimit && opts.staticContextLimit > 0) {
    return Math.floor(opts.staticContextLimit);
  }
  throw new ReconstructionUnavailableError(
    `Rebuild cannot resolve a context window for model \`${opts.destinationModel}\`. ` +
      `No matching live usage and no static contextLimit are available.`
  );
}
