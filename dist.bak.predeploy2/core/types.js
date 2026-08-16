export function defaultSessionConfig(defaultModel, defaultPolicy = "ask") {
    return { model: defaultModel, permissionPolicy: defaultPolicy };
}
/**
 * Resolve the effective permission mode for a session, honoring (in order):
 *   1. The new `permissionPolicy` field
 *   2. The legacy `autoApprovePermissions` field — but only when it is `true`
 *      (`false` / missing both fall through so the new safer default wins)
 *   3. The bot-wide default
 */
export function resolvePermissionMode(cfg, defaultMode) {
    if (cfg.permissionPolicy)
        return cfg.permissionPolicy;
    if (cfg.autoApprovePermissions === true)
        return "always";
    return defaultMode;
}
/** Statuses considered still in flight by `listActiveDelegations`. */
export const DELEGATION_ACTIVE_STATUSES = [
    "dispatched",
    "running",
];
/** Max stored length of `promptPreview`; the store truncates on write. */
export const PROMPT_PREVIEW_MAX = 200;
//# sourceMappingURL=types.js.map