/** Fast-mode wire descriptors; support comes only from live configOptions. */

/** ACP session config id claude-agent-acp exposes Fast mode under. */
export const FAST_MODE_CONFIG_ID = "fast";
/** Select value that enables Fast; boolean options use the corresponding bool. */
export const FAST_MODE_ON = "on";
/** Value that disables Fast. */
export const FAST_MODE_OFF = "off";

/** Eligibility is not proof: the current model must advertise this option. */
export interface FastModeDescriptor {
  /** ACP session config id. */
  readonly configId: string;
  /** Value that enables it (`on`). */
  readonly onValue: string;
  /** Value that disables it (`off`). */
  readonly offValue: string;
  /** Omitted preserves Claude's fresh-session policy. */
  readonly applicationMode?: "live" | "newSession";
}

/** The descriptor every direct-Anthropic Claude profile declares. */
export const CLAUDE_FAST_MODE: FastModeDescriptor = {
  configId: FAST_MODE_CONFIG_ID,
  onValue: FAST_MODE_ON,
  offValue: FAST_MODE_OFF,
};

export const CODEX_FAST_MODE: FastModeDescriptor = {
  configId: "fast-mode",
  onValue: FAST_MODE_ON,
  offValue: FAST_MODE_OFF,
  applicationMode: "live",
};
