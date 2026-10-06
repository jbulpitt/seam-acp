import { ProbeError, type CodexUsageData } from "@seam/adapters";

/** Live account limits win; fallback observations are compared across the same account. */
export async function readCodexAccountUsage(options: {
  location: string;
  locations: readonly string[];
  credentialProfile?: string;
  read(location: string, mode: "live" | "snapshot", signal?: AbortSignal): Promise<CodexUsageData>;
  signal?: AbortSignal;
}): Promise<CodexUsageData> {
  const checkAbort = () => { if (options.signal?.aborted) throw options.signal.reason ?? new Error("Codex usage cancelled"); };
  checkAbort();
  let live: CodexUsageData | undefined;
  let liveError: string;
  try {
    live = await options.read(options.location, "live", options.signal);
    checkAbort();
    if (live.ok) return live;
    liveError = live.error ?? "Codex live rate-limit read returned no data";
  } catch (error) {
    checkAbort();
    if (error instanceof ProbeError && error.code === "cancelled") throw error;
    liveError = error instanceof Error ? error.message : String(error);
  }
  const locations = [...new Set([options.location, ...options.locations])];
  const results = await Promise.allSettled(locations.map(location => options.read(location, "snapshot", options.signal)));
  checkAbort();
  const snapshots = results.flatMap((result, index) => result.status === "fulfilled"
    ? [{ location: locations[index]!, data: result.value }] : []);
  const account = live?.credentialProfile ?? options.credentialProfile ??
    snapshots.find(snapshot => snapshot.location === options.location)?.data.credentialProfile;
  const eligible = snapshots.filter(({ location, data }) => data.ok &&
    (account && account !== "default" ? data.credentialProfile === account : location === options.location));
  const timestamp = (data: CodexUsageData): number => {
    const at = Date.parse(data.source?.observedAt ?? "");
    return Number.isFinite(at) ? at : -Infinity;
  };
  eligible.sort((a, b) => timestamp(b.data) - timestamp(a.data));
  if (eligible[0]) return { ...eligible[0].data, liveError };
  const failures = results.flatMap((result, index) => {
    const error = result.status === "rejected" ? result.reason : result.value.error;
    return error ? [`${locations[index]}: ${error instanceof Error ? error.message : String(error)}`] : [];
  });
  return { ok: false, plan: null, primary: null, secondary: null, credits: null,
    error: [liveError, ...failures].join("; "), ...(live?.source ? { source: live.source } : {}),
  };
}
