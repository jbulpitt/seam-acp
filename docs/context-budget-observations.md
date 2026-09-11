# Context-budget observations (#291 / #292)

An observed **prompt budget** is input capacity, not the total context window.
For Copilot Astra/Sol the independently sourced dimensions are 400000 total,
272000 prompt and 128000 output. Copilot Sonnet 5/Opus 5 are
264000/200000/64000; Gemini 3.8 Flash is 265536/200000/65536.
Codex's effective 258400 and direct Claude's native 1M belong to their own
bindings. None of these numbers should be substituted for another provider.
The unsourced 1050000 research figure is not a budget authority.

## Recording and lookup

- `SessionStore.contextBudgets` retains the latest sample per
  `agentId, location, acpSessionId, model, requestedTier, observedTier`.
  Unknown tiers remain JSON null; the SQL key uses an internal empty sentinel.
- A sample has distinct `promptBudget`, `totalWindow`, `outputAllocation`,
  `requestedTier`, `observedTier`, raw `used`, source and timestamp.
  `previousPromptBudget` records the preceding sample's limit for the same key.
- ACP `usage_update.size` supplies **only promptBudget**. It does not establish
  totalWindow, outputAllocation or observedTier; those fields remain null.
  We do not infer total/output by arithmetic or copy a model-family catalog
  into observed fields. The numerical test matrix uses explicitly supplied
  synthetic dimensions, not a claim of additional ACP telemetry.
- Ordinary turns and all `injectTurn` dispatch paths record on receipt, below
  the status UI. Silent and isolated runs retain their own rows. Live runs
  also update `lastContextUsage` with the complete observation, but only if
  the thread still has that binding/session/model/launch tier.
- Model aliases resolve only through the exact binding's operational catalog.
  Legacy caches lacking provenance cannot supply a budget. Rebuild no longer
  reads the model-intelligence `context_window` fallback: that field does not
  establish a provider-qualified prompt limit.
- Current observations override catalog estimates, even when smaller.
  A decrease is recorded and logged; neither panel takes a maximum with its
  previous size. Used-token high-water display remains cosmetic; persistence
  retains the actual sample, including zero after compaction.
- Codex rollout `model_context_window` is explicitly marked observed.
  Inferred side-channel limits (for example a Claude model-table lookup)
  remain display estimates and cannot overwrite ACP budget observations.

## Tier limits

Local Copilot profiles record an optional selection from their existing launch
arguments, `--context default|long_context` (also `--context=...`).
This adds no launch flag and makes no model request. ACP does not acknowledge
the tier, so `observedTier` remains null even after a launch request.
Unadvertised remote launch selections remain unknown rather than being guessed.
A changed selection cannot reuse a cache from the previous selection.

No telemetry is backfilled for historical dispatches. Isolated-session rows
survive provider session deletion; this is latest-per-identity storage, not a
per-event history. Provider/account configuration outside the named binding
and real provider tier acknowledgment remain outside this change.

## Offline regression rationale (#307)

Each new parameterized check has its protection/deletion consequence beside it:

- Numeric matrix: total/output capacity or another provider's limit cannot
  become input capacity.
- Identity matrix: changing provider, host, ACP session, model or requested tier
  cannot reuse the old measurement.
- Unqualified cache/metadata: prevents the ambiguous bare-model leak.
- SQLite reopen and decrease: smaller limits and zero-used samples survive.
- Requested/observed tier keys: a launch request never fabricates confirmation.
- Invalid measurements: invalid identities, numbers and empty tiers cannot
  corrupt keys or silently turn into JSON nulls.
- Launch parsing: records optional intent for both supported flag spellings.
- Ordinary pipeline: a larger inferred side-channel limit cannot inflate ACP.
- Silent live dispatch: recording does not depend on a panel.
- Isolated dispatch: retains telemetry without overwriting the authoring thread.
- Retired owner/reset: late callbacks cannot overwrite the replacement cache.
- Runtime model/tier change: attribution follows the selected execution.
- Panel decrease: a prior/catalog size cannot conceal smaller served input.
- Codex side channel: the real rollout limit retains observation provenance.
- Rebuild: only qualified prompt capacity determines the reconstruction budget.

The offline suite must exclude `test/acp.int.test.ts` (billable).
No tests here contact providers; runtime transport is synthetic.
