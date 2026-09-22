/**
 * How an AGY host chooses its binary (#510).
 *
 * `pinned` is the content-addressed artifact: root-owned, re-hashed at
 * spawn, and on Linux executed from the verified snapshot so a later rewrite
 * cannot change the child. That path stays. Reapplying it is configuration.
 *
 * `unpinned` is not what you get by deleting AGY_CLI_PATH, AGY_SHA256, and
 * AGY_VERSION. Those three missing is a misconfigured pin and must keep
 * failing. Unpinned is this explicit value, and it means the ordinary `agy`
 * on PATH: a self-updating executable with no digest. A file that was one
 * version when someone looked can be another by the time it runs. That is
 * the writable-path replacement #415 describes, and #505 is why a standing
 * pin is not the default answer to it.
 */
export const AGY_PIN_UNPINNED = "unpinned";
export const AGY_PIN_PINNED = "pinned";

export const AGY_UNPINNED_GIVE_UP =
  "Unpinned AGY runs the ordinary agy on PATH and does not check a digest. " +
  "On Linux the pinned path executes the verified bytes from a snapshot, so a swap after verification cannot change the child. " +
  "This mode does not do that: a binary that checked as one version can be another by the time it runs, which is the writable-path replacement a pin exists to catch. " +
  "The pin is still available. Unset AGY_PIN and set AGY_CLI_PATH, AGY_SHA256, AGY_VERSION, and AGY_RUNTIME_ROOT together.";

/** Identity of a content-addressed pin. AGY_DEFAULT_MODEL is not one of these. */
export const AGY_IDENTITY_PIN_KEYS = [
  "AGY_CLI_PATH",
  "AGY_OLD_CLI_PATH",
  "AGY_BIN",
  "AGY_SHA256",
  "AGY_VERSION",
  "AGY_RUNTIME_ROOT",
] as const;

export type AgyPinMode = typeof AGY_PIN_PINNED | typeof AGY_PIN_UNPINNED;

export function standingAgyPinKeys(env: Readonly<Record<string, string | undefined>>): string[] {
  return AGY_IDENTITY_PIN_KEYS.filter((key) => Boolean(env[key]?.trim()));
}

export function readAgyPinMode(raw: string | undefined): AgyPinMode | "absent" {
  const value = raw?.trim() ?? "";
  if (!value) return "absent";
  if (value === AGY_PIN_PINNED || value === AGY_PIN_UNPINNED) return value;
  throw new Error(
    `Invalid configuration: AGY_PIN must be "${AGY_PIN_PINNED}" or "${AGY_PIN_UNPINNED}". ` +
    "Omitting AGY_CLI_PATH, AGY_SHA256, and AGY_VERSION does not unpin agy.",
  );
}
