// Imported first by index.ts: modules below read process.env at load time.
import { describeBridgeConfig, loadBridgeConfig } from "./bridge-config.js";

console.error(describeBridgeConfig(loadBridgeConfig()));
