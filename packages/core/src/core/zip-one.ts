/**
 * Pack a single file into a ZIP (STORE or DEFLATE). Used by `/seam upload pull`
 * when the raw file exceeds Discord's attachment cap.
 */
import { deflateRawSync, crc32 } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function zipOneFile(absPath: string): Promise<Buffer> {
  const name = path.basename(absPath);
  const uncompressed = await readFile(absPath);
  const crc = crc32(uncompressed) >>> 0;
  const compressed = deflateRawSync(uncompressed);
  const useDeflate = compressed.byteLength < uncompressed.byteLength;
  const payload = useDeflate ? compressed : uncompressed;
  const method = useDeflate ? 8 : 0;
  const nameBuf = Buffer.from(name, "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.byteLength, 18);
  local.writeUInt32LE(uncompressed.byteLength, 22);
  local.writeUInt16LE(nameBuf.byteLength, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.byteLength, 20);
  central.writeUInt32LE(uncompressed.byteLength, 24);
  central.writeUInt16LE(nameBuf.byteLength, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42); // relative offset of local header = 0

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.byteLength + nameBuf.byteLength, 12);
  end.writeUInt32LE(local.byteLength + nameBuf.byteLength + payload.byteLength, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([local, nameBuf, payload, central, nameBuf, end]);
}
