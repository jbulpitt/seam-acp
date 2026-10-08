const invalidArgument = Symbol("invalid argument");

/** Classify validation failures without replacing the original error. */
export function invalidArgumentError<T extends Error>(error: T): T {
  Object.defineProperty(error, invalidArgument, { value: true });
  return error;
}

export function isInvalidArgumentError(error: unknown): error is Error {
  return error instanceof Error && invalidArgument in error;
}
