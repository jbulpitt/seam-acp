import { randomUUID } from "node:crypto";
import type { Stream } from "@agentclientprotocol/sdk";

/** Old responses belong to the previous caller, not this fresh adopted SDK. */
export function adoptedAcpStream(stream: Stream): Stream {
  const prefix = `seam-${randomUUID()}:`;
  const encode = (id: unknown) => `${prefix}${JSON.stringify(id)}`;
  const writer = stream.writable.getWriter();
  return {
    readable: stream.readable.pipeThrough(new TransformStream({
      transform(frame, controller) {
        if (!("method" in frame) && "id" in frame) {
          if (typeof frame.id !== "string" || !frame.id.startsWith(prefix)) return;
          frame = { ...frame, id: JSON.parse(frame.id.slice(prefix.length)) };
        }
        controller.enqueue(frame);
      },
    })),
    writable: new WritableStream({
      write(frame) {
        if ("method" in frame && "id" in frame) frame = { ...frame, id: encode(frame.id) };
        else if ("method" in frame && frame.method === "$/cancel_request") {
          const params = frame.params as { requestId: string | number };
          frame = { ...frame, params: { ...params, requestId: encode(params.requestId) } };
        }
        return writer.write(frame);
      },
      close: () => writer.close(),
      abort: reason => writer.abort(reason),
    }),
  };
}
