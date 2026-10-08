import { afterEach } from "vitest";
import { pino } from "pino";
import { SessionRouter } from "../../packages/core/src/core/session-router.js";
import { SessionStore } from "../../packages/core/src/core/session-store.js";
import { fixtureModelCatalog } from "../model-catalog-fixture.js";
import type { Logger } from "../../packages/core/src/lib/logger.js";

const closeStores: Array<() => void> = [];
const logger = pino({ level: "silent" }) as unknown as Logger;

afterEach(() => {
  for (const close of closeStores.splice(0)) close();
});

export function testSessionStore<T extends object>(overrides: T) {
  const store = new SessionStore(":memory:");
  closeStores.push(store.close.bind(store));
  const { turnAttempts, scheduledOccurrences, ...methods } = overrides as T & {
    turnAttempts?: object;
    scheduledOccurrences?: object;
  };
  Object.assign(store.turnAttempts, turnAttempts);
  Object.assign(store.scheduledOccurrences, scheduledOccurrences);
  return Object.assign(store, methods) as SessionStore & T;
}

export function testSessionRouter<T extends object>(overrides: T) {
  return Object.assign(new SessionRouter({
    logger,
    store: testSessionStore({}),
    profiles: [],
    modelCatalog: fixtureModelCatalog([]),
    defaultAgentId: "fixture",
    defaultModel: "default",
    defaultCwd: "/repo",
  }), overrides);
}
