import { promises as fs } from "node:fs";
import path from "node:path";
import { hashBridgeToken, mintBridgeToken } from "./bridge-pairing.js";

export interface LocalBridgeCredential {
  tokenHash: string;
}

/**
 * Durable controller-host bridge identity. The raw token stays in a private
 * file shared with the independently supervised local bridge and is never
 * passed in argv or logs. Losing it disconnects local capacity only; paired
 * remote bridges and non-agent control surfaces keep working (#575).
 */
export async function loadOrCreateLocalBridgeCredential(dataDir: string): Promise<LocalBridgeCredential> {
  const dir = path.join(dataDir, "local-bridge");
  const tokenPath = path.join(dir, "token");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  let token: string;
  try {
    token = (await fs.readFile(tokenPath, "utf8")).trim();
    if (!token) throw new Error("empty local bridge token");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    token = mintBridgeToken();
    try {
      await fs.writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      token = (await fs.readFile(tokenPath, "utf8")).trim();
      if (!token) throw new Error("empty local bridge token");
    }
  }
  await fs.chmod(tokenPath, 0o600);
  return { tokenHash: hashBridgeToken(token) };
}
