# AGY print-mode degradation (#371)

The native child's print stdout is retained (at most 1,000,000 bytes) until
subscription authority is decided. An explicit subscription auth/protocol
rejection before **any** update selects stdout for this same invocation. HTTP
200 alone does not commit stream authority: Connect can carry an error in its
end-of-stream envelope. Both nested `error` and direct code/message envelopes
are understood. There is no second prompt, child, or provider request.

The first decoded update commits stream authority, including idle/historical
updates. Ordinary stdout capture is then discarded and disabled; working-stream
thoughts, tool updates, planner responses and completion remain unchanged.
Structured-output calls retain their existing JSON stdout reader. An explicit
mid-stream rejection fails the turn with its cause; it never substitutes stdout
for partial streamed output. Existing natural socket-EOF handling is unchanged.

Only subscription auth/protocol rejection permits fallback. Quota exhaustion,
provider cancellation, malformed/oversized frames, startup failure, and the
existing host timeout/cancellation controls still refuse the affected turn.
Fallback waits for child **close**, not merely exit, to drain final stdout, and
requires successful exit and bounded output before delivering the answer.

Degradation is announced in an ACP message: streamed thoughts, tool updates and
permission prompts are unavailable. For schema-only callers the caveat is a
separate ACP thought notification, keeping result text valid JSON. The existing
native launch already uses `--dangerously-skip-permissions`; this change neither
introduces that flag nor changes sandbox, MCP configuration, or approval policy.
Fallback provides no interactive permission channel. Rich-stream features must
not be advertised as available in this mode.

The LS code/message survive as structured error fields and in the ACP error
message when fallback is unsafe. Both rejection and fallback are logged by the
adapter's `console.error` in the executing process (the bridge on remote
bindings), without a debug flag. Diagnostics use the existing credential/env
redactor and length limits; raw stderr, tokens, and full LS payloads are not
logged.

## Synthetic mutation evidence

No live provider calls or remote-host access were used. Each mutation was applied
alone, its test run exited 1 with the assertion below, and then it was restored.
Seven killed; zero survivors. The command prefix was:

```sh
npx vitest run test/agy-native-lifecycle.test.ts test/agy-stream-lifecycle.test.ts --maxWorkers=2
```

- Replace retained LS message with `discarded`; add `-t 'retains the language server code'`:
  `Tests 2 failed | 28 skipped (30)` — both EOS shapes lost `streamMessage`.
- Disable fallback; add `-t 'completes from stdout'`:
  `Tests 1 failed | 29 skipped (30)` — expected completion, received rejection.
- Remove the stream-committed guard; add `-t 'preserves a mid-stream'`:
  `Tests 1 failed | 29 skipped (30)` — expected rejection, received completion.
- Force stdout use on working streams; add `-t 'keeps a working stream'`:
  `Tests 1 failed | 29 skipped (30)` — working completion became a timeout
  waiting for stdout instead of completing through the stream.
- Replace the lost-feature warning; add `-t 'completes from stdout'`:
  `Tests 1 failed | 29 skipped (30)` — missing degradation-label assertion.
- Allow every EOS code to fall back; add `-t 'limits fallback to subscription'`:
  `Tests 1 failed | 29 skipped (30)` — quota refusal expected false, got true.
- Restore cause-stripping in `executePrompt`; run
  `npx vitest run test/agy-native-lifecycle.test.ts --maxWorkers=2 -t 'preserves a mid-stream'`:
  `Tests 1 failed | 19 skipped (20)` — expected `unauthenticated: missing CSRF token`,
  got `Internal error: native AGY protocol_error`.

The schema-only regression was added after this mutation campaign; the final
suite includes it as well.
