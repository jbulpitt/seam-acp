/**
 * Newline-delimited reader that stays linear in the message size: chunks are
 * kept as they arrive and joined once per line. Concatenating on every chunk
 * made a 37 MB photo prompt take longer than the 10 s request timeout.
 */
export function createNdjsonReader(onLine: (line: Buffer) => void, maxLineBytes: number) {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  return {
    /** Returns false when a line exceeds `maxLineBytes`; the caller drops the connection. */
    push(chunk: Buffer): boolean {
      let start = 0;
      let newline = chunk.indexOf(0x0a, start);
      while (newline !== -1) {
        const tail = chunk.subarray(start, newline);
        const line = pending.length ? Buffer.concat([...pending, tail], pendingBytes + tail.length) : tail;
        pending = [];
        pendingBytes = 0;
        if (line.length > maxLineBytes) return false;
        if (line.length) onLine(line);
        start = newline + 1;
        newline = chunk.indexOf(0x0a, start);
      }
      if (start < chunk.length) {
        const rest = chunk.subarray(start);
        pending.push(rest);
        pendingBytes += rest.length;
        if (pendingBytes > maxLineBytes) return false;
      }
      return true;
    },
    pendingBytes: () => pendingBytes,
  };
}
