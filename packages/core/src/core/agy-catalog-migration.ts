import type { CatalogScope } from "@seam/adapters";
import type {
  ModelCatalogStore,
  PrepareCatalogBindingMigrationResult,
} from "./model-catalog/store.js";

export const AGY_CATALOG_IDENTITY_MIGRATION = "agy-package-local-binding-v1";
export const AGY_PACKAGE_CATALOG_SOURCE = "agy-models+antigravity-acp-selection";

/** Explicit #254 identity boundary; it never touches remote bindings or sessions. */
export function migrateAgyCatalogIdentity(
  store: ModelCatalogStore,
  packageScope: CatalogScope,
): PrepareCatalogBindingMigrationResult {
  if (
    packageScope.provider !== "google-antigravity" ||
    !packageScope.credentialProfile ||
    packageScope.policy !== "unsafe-ack-v1" ||
    !/^[a-f0-9]{64}$/.test(packageScope.fingerprint)
  ) {
    throw new Error("AGY package catalog migration requires the exact configured semantic scope");
  }
  return store.prepareBindingMigration({
    migrationId: AGY_CATALOG_IDENTITY_MIGRATION,
    sourceBinding: { agentId: "agy", location: "local" },
    targetBinding: { agentId: "agy-package", location: "local" },
    scopeKey: `scope:${packageScope.fingerprint}`,
    source: AGY_PACKAGE_CATALOG_SOURCE,
  });
}
