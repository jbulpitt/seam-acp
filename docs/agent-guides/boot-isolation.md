# Optional boot failures

An invalid optional component refuses its own work and logs the cause. It
does not prevent Discord or unrelated agents from starting. Mandatory bot
credentials and `REPOS_ROOT` still fail configuration validation.

## Configuration

- Invalid AGY field or runtime validation leaves AGY unavailable. Its original
  validation error is logged and retained for local AGY session refusals.
- `AGY_PIN=unpinned` ignores stale `AGY_CLI_PATH`, `AGY_OLD_CLI_PATH`,
  `AGY_BIN`, `AGY_VERSION`, `AGY_SHA256`, and `AGY_RUNTIME_ROOT`. The warning
  names keys, never their values. This does not enable unpinned mode implicitly.
- Boot drops invalid channel, thread or bridge preset entries individually,
  logging the entry and schema cause. The original file is not rewritten.
  Hot reload remains strict and retains its previous good maps on failure.
- A denied, parked or retired local `DEFAULT_AGENT` refuses new sessions that
  depend on it. Existing sessions and explicit agent presets are unaffected.
  New message refusals report the original cause before admission or parking.
  There is no replacement-agent fallback.
- `SEAM_MCP_ENABLED=false` disables Seam tool injection, not the execution
  bridge. Agents still run through their host's bridge and sessiond.
- Invalid GIF/brand URLs disable those decorations separately. Invalid
  `DISCORD_STATUS_THREAD_ID`, `CODEX_ENABLED`, or `SEAM_TEST_DRIVER_URL`
  disables that optional card, agent, or test client. Invalid extra Claude or
  Copilot profile entries are skipped individually. Valid siblings remain.
- An invalid `SEAM_GEMINI_TTS_VOICE` disables speech that depends on the env
  voice, without substituting Kore. A valid explicit thread voice still works.
- An unreadable, malformed, or schema-invalid whole preset file is retained
  unchanged and unavailable at boot. A later valid hot reload activates it;
  after that, invalid edits keep the last-good maps as before.

`/health` keeps its liveness response and adds `disabledFeatures`, an array of
`{ feature, cause }` records. This includes the original AGY/default-agent
causes and unavailable preset files; a successful preset reload clears its
boot refusal. Required credentials, repository validation and access-policy
validation remain fatal. Other settings keep their existing validation.

## AGY identity migration

An ambiguous record is left unchanged and refused with its classification
error. Other classifiable records migrate normally. Partial migration retains
before-images in the existing migration table, without the global completion
marker. Subsequent boots skip already-migrated records and retry classification
of the remainder. Repair the ownership conflict before retrying that session;
do not clear its conversation handle to hide the error.

## Invalid sessiond state

Malformed or unsupported-version state is retained beside the original path
as `<state-file>.refused-<uuid>`, mode `0600`. sessiond starts a new valid
registry and accepts new slots. Slots identified by surviving holder or resume
artifacts are refused, with the cause retained across subsequent restarts.
Their processes and resume records are not killed, respawned or removed:
without the saved identities, ownership cannot be verified.

The bridge skips subscriptions for these refused slots, names the cause, and
continues starting. The autostarted daemon's stderr also reaches the bridge
journal rather than being discarded.

Preserve the retained state for repair. Restoring a known-good registry must
be coordinated with the host operator; do not restore it over newly running
work. Update bridge and sessiond together. Older code does not understand the
retained refusal records and must not be used to resume unverified slots.

## Staging acceptance

Use the deployment's own `docs/local/` instructions. Reserve staging first,
snapshot its configuration privately, and let the operator run privileged
restarts. Do not change production. For each case, record the source revision,
boot result, journal cause, affected refusal and an unaffected real agent turn.

1. On main, demonstrate at least one boot failure with a reported setting.
2. On the candidate, boot with invalid AGY semantic and schema settings.
3. Boot unpinned AGY with stale pin keys; verify the warning and PATH selection.
4. Boot with one invalid preset alongside valid entries; verify valid entries
   survive and the invalid entry is named.
5. Boot separately with a denied, parked and retired default. Verify an explicit
   unaffected agent works and a new default-dependent session is refused.
6. Boot with an ambiguous synthetic AGY identity in an isolated fixture data
   directory. Verify that record is preserved and unrelated sessions work.
7. Boot with MCP disabled; run an unaffected agent through its actual bridge.
8. Boot sessiond with malformed and future-version fixture state. Verify the
   host's bridge starts, new sessions work, and old unverifiable work is not
   killed or silently restarted.
9. Restore the exact original configuration, return staging to main, restart
   through the operator, and confirm its health and a normal turn.

Use fixture storage for recovery corruption tests, never an active registry.
Report any omitted live checks; offline tests are not a staging boot proof.
