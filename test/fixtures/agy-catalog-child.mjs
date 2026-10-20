import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
register({ tsconfig: path.join(root, "tsconfig.json") });
const { makeAgyUnpinnedRuntime, makeAgyProfile } = await import(path.join(root, "packages/adapters/src/index.ts"));
const profile = makeAgyProfile({
  runtime: makeAgyUnpinnedRuntime({ credentialScope: "antigravity-oauth:durable-test", cwd: process.env.SEAM_TEST_DATA }),
  defaultModel: "fixture-native-model", dataDir: process.env.SEAM_TEST_DATA, exposeGlobalStaging: false,
});
const child = profile.spawn();
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin);
const stop = () => child.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdin.on("end", stop);
child.on("exit", () => process.exit(0));
