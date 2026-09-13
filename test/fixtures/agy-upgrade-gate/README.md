# AGY upgrade-gate fixtures

These fixtures freeze the compatibility distinction exposed by the #371
incident. AGY 1.2.2 could report its version and pass provenance verification,
but its `StreamAgentStateUpdates` subscription rejected the adapter as
`unauthenticated` because the new CSRF token was unavailable. Versions 1.1.27,
1.1.28 and 1.2.0 are the known-good labels from the incident record.

All other values are synthetic: hashes, task ids, counts, load declarations,
model ids and timings do not describe a real user, host or provider turn. The
test expands `$copy` and `capabilityOverride` solely to keep the immutable
fixture readable; the production gate accepts only a complete report produced
by a separately approved, sanitized live canary.

The timing values prove reporting mechanics, not comparative speed. R10 records
sample counts, medians and observed tails, but deliberately defines no synthetic
performance threshold.
