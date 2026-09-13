# Necessity audit: eight mechanisms (#307 proposal 3)

Audit baseline: `a7c2907`, 2026-09-12/13. This is the explicitly requested
bounded pass, **not** a claim to have reviewed every guard in 500 commits.
The scope was named before the detailed pass. History and callers were traced
for the recent R-series/cutover and September retention changes.

**Verdicts: seven keep with the answer recorded below; one delete, filed as
[#391](https://github.com/jbulpitt/seam-acp/issues/391).** No production mechanism
is deleted in this PR. One existing test is strengthened after the audit found
an unrelated refusal masking its intended evidence.

## Scope corrections, not credited deletions

Two initial candidates were already removed at this baseline:
`AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED` (#380) and
`agy-catalog-migration.ts` (#377). They were replaced with the live upgrade gate
and identity-restoration quarantine. These prior removals are not this audit's
work. The initial “execution-request pruning” label was incorrect: #381 concerns
`model_catalog_observations`; there is no execution-request pruner here. Item 8
audits the actual local-observation retirement rule.

## 1. AGY executable provenance and digest verification — KEEP

- **Delete on paper:** removing the configured artifact digest comparison in
  `verifyAgyManagedRuntimeArtifact` makes the replacement-bytes test accept a
  spawn instead of rejecting the modified installation. This is an actual
  fixture file replacement, not an assertion that a hash field exists. Separate
  descriptor-snapshot tests exercise rename-after-verification and concurrent
  use. The mutation does not prove that cached approved bytes became malicious;
  it proves that a changed configured installation stopped being rejected.
- **Reachable:** an installed artifact can be replaced or pins can disagree
  with bytes. `openVerifiedSnapshot` also addresses the verification-to-execution
  race. A valid hash does **not** establish protocol compatibility; #371 is the
  concrete counterexample, not a reason to discard artifact identity.
- **Production reach:** `index.ts` and bridge `inventory.ts` construct
  `makeAgyNativeRuntime`; `makeAgyProfile` uses its prepared launches for turns
  and catalog work. This is not a test-only verifier.
- **Reporting:** mismatch names `sha256`/configured artifact. `descriptor` and
  `immutable-path` describe execution binding, not health or an accomplished
  turn. The latter is explicitly the weaker platform route; do not relabel it
  “working” or “compatible.” The separate compatibility gate answers that.

Evidence: [runtime implementation](../packages/adapters/src/agy-native-runtime.ts),
[runtime tests](../test/agy-native-runtime.test.ts), especially “rejects replacement
bytes present before a descriptor-bound launch” and “executes the verified
descriptor snapshot after the configured path is renamed and replaced.”

## 2. AGY upgrade compatibility-evidence gate — KEEP

- **Delete on paper:** bypassing failed capability verdicts admits the sanitized
  1.2.2-shaped report whose stream subscription failed `unauthenticated`.
  `test/stage-agy-runtime.test.ts` additionally binds this gate to staging and
  asserts existing pins/bytes remain unchanged when it refuses the candidate.
- **Reachable:** an executable can enumerate models and pass provenance while
  breaking the rich stream. #371 established that exact state. Stdout fallback
  restores degraded service; it does not make lost thoughts/tools a full-parity
  upgrade. Performance samples likewise describe measured evidence, not a speed
  assertion fabricated from one run.
- **Production reach:** `applyAgyStaging` invokes `evaluateAgyUpgradeEvidence`
  when `plan.isUpgrade`, before writing new pins. The operator CLI accepts
  `--upgrade-evidence`; no running adapter depends on this gate at startup.
- **Reporting:** refusal names the failed capability and says the existing
  runtime remains pinned. Synthetic repository fixtures are rejected as live
  evidence. The evaluator validates an operator-supplied report; it does not
  independently run or authenticate a canary, and this audit ran none.

Evidence: [gate](../scripts/agy-upgrade-gate.mjs),
[staging call](../scripts/stage-agy-runtime.mjs),
[gate tests](../test/agy-upgrade-gate.test.ts),
[staging tests](../test/stage-agy-runtime.test.ts).

## 3. Optional `sandbox: true` native profile path — DELETE (filed #391)

- **Delete on paper:** removing conditional `--sandbox` emission leaves six of
  seven posture tests passing. The sole failure explicitly requests the optional
  flag and expects that flag back. That is a test of the mechanism's own shape,
  not evidence of production necessity. Other true-path tests cover optional
  MCP suppression; neither production factory enables that branch.
- **Reachable:** the exported API accepts the option, so tests and hypothetical
  external callers can enable it. There is **no in-repository production path**
  that does. A historical/future helper intention is not a current requirement.
- **Production reach:** `rg` over all package TypeScript finds only the option,
  default-false wiring, argv emission and two MCP-suppression branches in
  `profiles/agy.ts`. Both real `makeAgyProfile` construction sites omit it.
  The default launch policy itself remains real and must be kept.
- **Reporting:** “confines the vision sidecar to its private sandbox cwd” is an
  argv-only test name. The lifecycle document admits enforcement is unproven
  and production is unsandboxed. Its `--add-dir` “bounding” wording must not be
  treated as a demonstrated OS security boundary. Delete the unused option and
  its claims together; retain actual per-session MCP isolation and the explicit
  default permission posture.

Evidence: [option and branches](../packages/adapters/src/profiles/agy.ts),
[server factory](../packages/core/src/index.ts),
[bridge factory](../packages/bridge/src/inventory.ts),
[posture tests](../test/agy-sandbox-posture.test.ts),
[argv-only sidecar test](../test/agy-model-catalog.test.ts),
[recorded posture](agy-native-lifecycle.md).
The removal crosses an exported API and several fixture contracts; deleting
only flag emission would leave half a feature. The complete bounded removal
and acceptance criteria are filed in #391 rather than silently performed here.

## 4. AGY identity-restoration quarantine — KEEP; strengthen its test

- **Delete on paper:** without `needsAgyIdentityRebuild`, a migrated package or
  unknown handle can enter a normal fresh runtime plan before reconstruction.
  The original test had `profiles: []`: deletion merely changed its error to
  “unknown agent.” That was inadequate evidence of preventing a runnable plan.
  This PR supplies a valid fake profile/catalog and proves the same plan opens
  after a successful durable rebuild attachment, with zero child launches.
- **Reachable:** the migration explicitly clears incompatible handles and
  persists `rebuild_required=1`. The one-shot completion marker does not consume
  pending rebuilds, nor does a restart. Removal of the package adapter does not
  remove these persisted obligations. No assertion about current live row counts
  is made: this audit did not inspect production databases.
- **Production reach:** opt-in startup `AGY_NATIVE_RESTORE` invokes
  `planAgyIdentityMigration`/`applyAgyIdentityMigration`; normal admitted turns
  in the Discord orchestrator call `rebuildMigratedAgySession`. The router gate
  independently prevents alternate runtime-start paths bypassing that rebuild.
  Consumption of pending rows does not require the startup flag to remain on.
- **Reporting:** errors distinguish reconstruction required, changed binding,
  and failed attachment. A successful compare-and-swap attachment consumes the
  pending obligation; failed reconstruction retains it. This is recoverable
  migration state, not a permanent quarantine of all AGY usage.

Evidence: [planner/rebuild](../packages/core/src/core/agy-identity-migration.ts),
[durable ledger](../packages/core/src/core/session-store.ts),
[router](../packages/core/src/core/session-router.ts),
[admitted-turn caller](../packages/core/src/platforms/discord/orchestrator.ts),
[strengthened tests](../test/agy-identity-migration.test.ts).

## 5. Router preservation of native AGY handles on invalidation — KEEP

- **Delete on paper:** making the native branch take ordinary clearing changes
  the actual SQL `acpSessionId` from the durable key to an empty string in
  `agy-cutover.test.ts`. That loses the key into the preserved cascade map;
  it is not merely a log/flag assertion.
- **Reachable:** runtime/session failure can call invalidation with
  `clearAcpSession: true`. Native AGY's per-prompt language server is disposable
  while its cascade mapping is durable. The code records the earlier amnesia
  incident. The branch was revisited during the recent identity cutover even
  though that incident predates the audit window.
- **Production reach:** multiple orchestrator error/rebuild paths call
  `SessionRouter.invalidate` with this option; the native profile reloads the
  saved mapping on the next turn. The condition names current `agy`, not the
  removed `agy-package` implementation. A historical package test row is a
  negative fixture, not a production dependency.
- **Reporting:** logs say the AGY ACP/cascade ID was preserved, versus ordinary
  clearing for other agents. It does not claim the failed runtime survived.
  Keep the branch; package removal does not make native continuity historical.

Evidence: [invalidate](../packages/core/src/core/session-router.ts),
[callers](../packages/core/src/platforms/discord/orchestrator.ts),
[native mapping](../packages/adapters/src/profiles/agy.ts),
[cutover regression](../test/agy-cutover.test.ts).

## 6. Positive retirement/unavailability model refusal — KEEP

- **Delete on paper:** forcing `assessModelSelection.allowed=true` fails eight
  real configuration-proposal assertions across session, preset, channel and
  thread surfaces. Known retired/unavailable entries become persistable
  choices. Sixteen missing/available-evidence cases still pass: the distinction
  is positive negative evidence, not a requirement to have a warm cache.
- **Reachable:** provider catalogs can publish retired or unavailable models;
  aliases can still name them. Missing entries are also routine on cold remote
  bindings. Treating those two states alike caused #366's whole-binding refusal.
- **Production reach:** four `ConfigMutationService` proposal paths,
  `ThreadSessionControlService`, and `ModelCatalogService.resolve` consume the
  shared rule. This is not an unwired catalog advisory.
- **Reporting:** known bad choices report unavailability; absent evidence passes
  the typed ID unchanged with `verification: unverified`. `binding` verification
  means catalog evidence exists, not that a paid turn has succeeded. Keep this
  narrow, owner-required gate; do not restore cold-cache refusal.

Evidence: [shared rule](../packages/core/src/core/model-catalog/service.ts),
[config proposals](../packages/core/src/core/config-mutation.ts),
[thread changes](../packages/core/src/core/thread-session-control.ts),
[proposal tests](../test/config-mutation.test.ts),
[fifth-site tests](../test/thread-session-control.test.ts).

## 7. Dispatch done-artifact retention and pruning eligibility — KEEP

- **Delete on paper:** deleting retention entirely recreates unbounded cleartext
  accumulation. Deleting its proof predicate instead physically removes a
  fixture's undelivered artifact: expected `retained`, observed `pruned`.
  Terminal execution is not proof of onward delivery. The full resolver tests
  also cover failed children and separately authorized legacy expiry.
- **Reachable:** a worker can complete before its report reaches the destination;
  crashes can separate publication and delivery. #305/#306 documented both the
  backlog and the dangerous “settled means delivered” shortcut.
- **Production reach:** `index.ts` constructs `DoneRetention` with the canonical
  delivery resolver, attaches `resultPublished` to the dispatch watcher, and
  starts its background sweep. The resolver uses durable delegation/attempt
  delivery evidence, not just file age or a completed parent.
- **Reporting:** result states distinguish retained, pruned and missing;
  summaries include `dryRun`, counts and failures. Malformed/unknown artifacts
  remain recoverable and diagnostics avoid private body excerpts. Keep both
  pruning and the delivery-proof boundary; neither implies erasing SQL history.

Evidence: [retention](../packages/core/src/core/dispatch/done-retention.ts),
[canonical resolver](../packages/core/src/core/dispatch/done-reconcile.ts),
[production binding](../packages/core/src/index.ts),
[proof/physical-unlink tests](../test/dispatch-proof-retention.test.ts).

## 8. Local-only catalog observation retirement — KEEP

- **Delete on paper:** removing retirement leaves a removed local adapter
  advertised as current. Removing only `WHERE location = 'local'` instead marks
  the offline remote fixture retired, failing its durable fleet-preservation
  assertion. The same regression proves later local restoration recovers the
  retained snapshot without a provider call.
- **Reachable:** local adapter removal is positive evidence about that local
  binding; a laptop absent from local configuration can still be a valid remote
  fleet member. #381 recorded one local orphan among 21 observations and the
  destructive consequence of conflating those states. Those are issue evidence,
  not fresh production measurements by this audit.
- **Production reach:** `index.ts` passes the actual local profile IDs to
  `ModelCatalogService`; its constructor calls
  `ModelCatalogStore.reconcileConfiguredLocalAgents`. Remote connectivity and
  age never supply the retirement decision.
- **Reporting:** rows are marked, not deleted. `fleetSnapshot` explicitly shows
  `retired`; an offline remote binding keeps its last-known-good snapshot as
  `stale`. Reconfiguration clears the retirement marker. This narrow metadata
  lifecycle does not remove a host's usable agents.

Evidence: [store rule](../packages/core/src/core/model-catalog/store.ts),
[service/fleet reporting](../packages/core/src/core/model-catalog/service.ts),
[local profile producer](../packages/core/src/index.ts),
[removal/offline/restoration regression](../test/model-catalog.test.ts).

## Verification and limitations

No live provider calls, billable turns, remote-host access, or production-data
cleanup were used. Fixtures establish the named state transitions and output
contracts, not empirical sandbox enforcement or live upgrade parity.

Baseline focused invocation:

```sh
npx vitest run test/agy-native-runtime.test.ts test/agy-upgrade-gate.test.ts test/agy-sandbox-posture.test.ts test/agy-identity-migration.test.ts test/agy-cutover.test.ts test/config-mutation.test.ts test/thread-session-control.test.ts test/dispatch-proof-retention.test.ts test/model-catalog.test.ts --maxWorkers=2
```

Result: **9 files, 169 tests passed**. Strengthened migration fixture:
`npx vitest run test/agy-identity-migration.test.ts --maxWorkers=2` — **7 passed**.

Eight representative removal probes were run individually and restored. These
are not eight proofs of necessity: the sandbox failure is explicitly circular
with respect to production, and the original migration assertion needed repair.
No survivors were dropped from the record. The individual probes below all
exited 1 and were restored before validation: **8 mechanisms killed, zero
survivors**, plus a repeat of the strengthened quarantine fixture. A killed
mutation alone is not a KEEP verdict.

### Mutation commands and observed failures

Each command starts with `npx vitest run` and bounds workers to two:

- **Artifact digest:** remove the configured-artifact digest comparison.
  `npx vitest run test/agy-native-runtime.test.ts --maxWorkers=2 -t 'rejects replacement bytes'`
  — **1 failed, 9 skipped**; expected rejection, received a child process.
  This establishes refusal of changed installation bytes, not execution of
  malicious bytes instead of a cached approved snapshot.
- **Upgrade capability:** ignore a failed capability verdict.
  `npx vitest run test/agy-upgrade-gate.test.ts --maxWorkers=2 -t 'refuses the observed'`
  — **1 failed, 9 skipped**; incompatible evidence no longer throws.
- **Unused sandbox:** remove only conditional `--sandbox` emission.
  `npx vitest run test/agy-sandbox-posture.test.ts --maxWorkers=2`
  — **1 failed, 6 passed**; only the explicitly requested flag expectation
  fails. This does not establish production necessity or sandbox enforcement.
- **Identity quarantine:** bypass `needsAgyIdentityRebuild`.
  `npx vitest run test/agy-identity-migration.test.ts --maxWorkers=2 -t 'refuses runtime creation'`
  — original fixture **1 failed, 6 skipped**, but only because the error changed
  to `Unknown agent profile "agy"`. After strengthening the fixture, the same
  mutation gives **1 failed, 6 skipped** because the viable plan **does not
  throw**. The unrelated refusal no longer masks the behavior under audit.
- **Native handle:** take ordinary handle-clearing instead of AGY preservation.
  `npx vitest run test/agy-cutover.test.ts --maxWorkers=2 -t 'preserves native'`
  — **1 failed**; persisted continuation handle becomes an empty string.
- **Model retirement:** force `assessModelSelection.allowed=true`.
  `npx vitest run test/config-mutation.test.ts --maxWorkers=2 -t '#366'`
  — **8 failed, 16 passed, 56 skipped**; retired/unavailable choices become
  accepted across four configuration proposal paths.
- **Delivery proof:** remove `isArtifactDeletable` from the unlink decision.
  `npx vitest run test/dispatch-proof-retention.test.ts --maxWorkers=2 -t 'checks current proof'`
  — **1 failed, 7 skipped**; expected retained artifact is actually pruned.
- **Remote retirement:** replace the local-only SQL predicate with `1 = 1`.
  `npx vitest run test/model-catalog.test.ts --maxWorkers=2 -t 'retires only a positively'`
  — **1 failed, 18 skipped**; valid offline remote acquires a retirement marker.

### Required validation

`npm test -- --maxWorkers=2` — **265 files passed; 4,102 tests passed,
1 skipped, 5 todo (4,108 total)**, 421.05 seconds on the first full run.
The final-state repeat and its duration are recorded in the PR.
`npm run typecheck`, `npm run typecheck:agy`, and `npm run build` each exit 0;
the build compiles adapters, core, and bridge. None is a deployment command.

Shared-host load before verification: **4 logical CPUs**, load averages
**3.28 / 3.58 / 3.05**, **13,324 MiB available RAM**, **1,636 MiB swap used**.
The two-worker suite overlapped the typecheck/build sequence and other host
work. Durations are verification timings, not isolated performance claims.
