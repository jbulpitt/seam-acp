/** Binary download responses must retain Google's cause on the original error. */
export function googleDownloadError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const response = (error as Error & { response?: { data?: unknown } }).response;
  const data = response?.data;
  const bytes = data instanceof ArrayBuffer ? Buffer.from(data)
    : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : undefined;
  if (!bytes) return error;
  try {
    const decoded = JSON.parse(bytes.toString("utf8"));
    const cause = (Array.isArray(decoded) ? decoded[0] : decoded)?.error?.message;
    if (typeof cause === "string") {
      error.message = cause;
      response!.data = decoded;
    }
  } catch { /* Non-JSON bodies retain the original transport error. */ }
  return error;
}
