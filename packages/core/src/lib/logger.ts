import { pino } from "pino";
import { bootObserver } from "./boot-observation.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "seam-acp" },
  hooks: {
    logMethod(args, method, level) {
      const binding = this.bindings();
      bootObserver.record(level, args, binding.comp ?? binding.mod);
      method.apply(this, args);
    },
  },
});

export type Logger = typeof logger;
