export const NON_LIVE_TEST_INCLUDE = ["test/**/*.test.ts"] as const;
export const NON_LIVE_TEST_EXCLUDE = ["test/**/*.int.test.ts"] as const;
export const LIVE_TEST_INCLUDE = ["test/**/*.int.test.ts"] as const;

export function shouldRunLiveAcpTest(
  optIn: string | undefined,
  copilotAvailable: () => boolean
): boolean {
  return optIn === "1" && copilotAvailable();
}
