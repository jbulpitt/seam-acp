import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.resolve("tsx/package.json"));
const { build } = require("esbuild") as typeof import("esbuild");

export interface SessionExecutables {
  holderPath: string;
  adapterChildPath: string;
}

// Compile current source before native startup deadlines begin; no dist is read.
export async function prepareSessionExecutables() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const cache = path.join(root, "cache");
  await fs.mkdir(cache, { recursive: true });
  const directory = await fs.mkdtemp(path.join(cache, "saved-session-executables-"));
  const holderPath = path.join(directory, "slot-holder-source.mjs");
  const adapterChildPath = path.join(directory, "adapter-child-source.mjs");
  const legacyAdapterChildPath = path.join(directory, "adapter-child-legacy.mjs");
  const entries = [
    { outfile: holderPath, contents: `
      import { ownTestHolder } from "./test/helpers/test-slot-holders.mjs";
      ownTestHolder();
      await import("./packages/bridge/src/slot-holder.ts");` },
    { outfile: adapterChildPath, contents: 'await import("./packages/bridge/src/adapter-child.ts");' },
    { outfile: legacyAdapterChildPath, contents: String.raw`
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...args) => {
        const text = String(chunk).replace(/,"reconcileSupported":true/g, "");
        return write(text, ...args);
      };
      await import("./packages/bridge/src/adapter-child.ts");` },
  ];
  await Promise.all(entries.map(({ outfile, contents }) => build({
    stdin: { contents, resolveDir: root, sourcefile: path.basename(outfile), loader: "js" },
    outfile, bundle: true, platform: "node", format: "esm", target: "node22",
    packages: "external", alias: { "@seam/adapters": path.join(root, "packages/adapters/src/index.ts") },
    sourcemap: "inline", logLevel: "silent",
  })));
  return { holderPath, adapterChildPath, legacyAdapterChildPath,
    close: () => fs.rm(directory, { recursive: true, force: true }) };
}
