import net, { type Server } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";

async function socketIsLive(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}

/** Acquire a process-lifetime Unix-socket lease. A live prior process wins;
 * stale socket files are removed. This is identity/ownership, not health: the
 * controller separately waits for the bridge hello before admitting work. */
export async function acquireProcessLease(socketPath: string): Promise<Server | null> {
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    const stat = await fs.lstat(socketPath);
    if (!stat.isSocket()) throw new Error("bridge singleton path exists and is not a socket");
    if (await socketIsLive(socketPath)) return null;
    await fs.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const server = net.createServer((socket) => socket.end());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    server.close();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && await socketIsLive(socketPath)) {
      return null;
    }
    throw error;
  }
  await fs.chmod(socketPath, 0o600);
  const cleanup = (): void => { void fs.unlink(socketPath).catch(() => undefined); };
  process.once("exit", cleanup);
  return server;
}
