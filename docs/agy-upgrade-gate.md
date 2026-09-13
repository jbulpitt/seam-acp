# AGY upgrade compatibility gate

Status: R10 implementation for [#266](https://github.com/jbulpitt/seam-acp/issues/266),
under the native AGY tracker [#256](https://github.com/jbulpitt/seam-acp/issues/256).

## Decision

An AGY artifact upgrade now needs two independent kinds of evidence before the
staging transaction moves its pins:

1. The existing prompt-free `agy --log-file <temporary> models` check proves
   this exact binary can start its language server and enumerate models.
2. A sanitized report from a separately approved canary proves the real Seam
   turn contract: stream subscription, thinking, MCP, usage, structured output,
   session continuity and complete cleanup.

This distinction comes from the macbook-pro incident in #371. AGY 1.2.2 had a
valid digest, immutable provenance, and working `--version`, yet its language
server rejected `StreamAgentStateUpdates` as unauthenticated because the new
CSRF token was available only to its IDE sidecar. Identity checks described the
binary correctly; they did not prove it could serve Seam.

There is no version allowlist or blocklist. The gate binds evidence to the exact
candidate version and digest. The labels 1.1.27, 1.1.28 and 1.2.0 are retained
as known-good regression shapes, and 1.2.2 as the known-bad incident shape, but
none is a runtime policy.

## Blast radius

The gate runs inside `applyAgyStaging` before the five AGY pins move. A refusal
removes only artifacts created by that attempted staging. The old pins and old
runtime remain authoritative, so an agy-only laptop stays up. Initial migration
of identical bytes is not reclassified as an upgrade; a changed digest is.

No force or bypass switch exists. A missing report, mismatched version/digest,
missing capability, failed capability, or incomparable performance sample set
refuses only the candidate upgrade with a named reason.

## Evidence format and privacy

`npm run agy:upgrade:gate -- --evidence <report.json> --version <version> --sha256 <digest>`
validates a report without launching AGY, changing pins, or contacting a
provider. `scripts/stage-agy-runtime.mjs --apply` accepts the same report as
`--upgrade-evidence <report.json>` when the candidate digest differs from the
currently pinned digest.

A report is schema version 1 and includes:

- `sanitized: true`, `evidenceLevel: "live-verified"`, and a UTC capture time;
- exact baseline and candidate versions and SHA-256 values;
- adapter commit, scenario version, host class, declared host load, and model;
- explicit capability verdicts and observation counts;
- sanitized native update shapes from which the gate computes an aggregate
  count of unknown fields without retaining or emitting values; and
- at least three paired baseline/candidate task observations.

Unknown native fields are counted but neither logged nor treated as a failure.
The evaluator emits only aggregate capability, drift, and performance data; it
never echoes raw report content. Private prompts, model output, credentials,
paths, host names, or conversation ids do not belong in the report.

The repository fixtures are synthetic and sanitized. A real candidate report
requires separate approval for disposable canaries, including the exact host,
model, prompt budget, allowed tools, cleanup, and stop conditions. Offline tests
cannot upgrade their own evidence level into a live claim.

## Performance means measurement, not a speculative threshold

Each paired task records startup-to-first-event, first-text,
completion-to-idle, cleanup, peak RSS, and peak child count under declared host
load. The gate requires identical ordered tasks and reports sample count, median
and observed tail (maximum) for baseline and candidate.

It deliberately does not decide that a candidate is faster or slower. Provider
latency and host contention make a synthetic threshold unstable, and one run is
explicitly rejected as evidence. Capability regression stops promotion;
performance measurement is a review input until repeated production canaries
justify a threshold with an operational consequence.

## Reconciliation with the original R10 plan

The old plan named an `agy-package` comparison harness. That adapter was removed
by #377, so preserving a comparison path with no production consumer would fail
the necessity test in `AGENTS.md`. R10 instead reuses the shipped native R1
capability contract and the R9 staging transaction. Recovery paths are not
retired by this change; only a successful, separately authorized migration can
justify that later decision.
