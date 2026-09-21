import { budgetForHost } from "./footprint.js";

export interface WarmSetHostOpt {
  id: string;
  budgetMb: number;
}

/**
 * Parse `WARM_SET_HOSTS`. Empty = opt-out (nobody is warmed).
 * `fhr-server,rhc-server=10000` — bare ids use measured host defaults.
 */
export function parseWarmSetHosts(raw: string): WarmSetHostOpt[] {
  const out: WarmSetHostOpt[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    const id = (eq === -1 ? part : part.slice(0, eq)).trim();
    const override = eq === -1 ? undefined : Number(part.slice(eq + 1).trim());
    if (!id || seen.has(id)) continue;
    if (override !== undefined && (!Number.isFinite(override) || override <= 0)) continue;
    seen.add(id);
    out.push({ id, budgetMb: budgetForHost(id, override) });
  }
  return out;
}
