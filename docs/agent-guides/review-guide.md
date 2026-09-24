# Review guide

Read this when you review a change or write a review brief. You don't need it
to implement one; `AGENTS.md` → *How we build here* covers that.

## 1. Run it first

Before reading the diff, run the change through the real path on the real
host: a real turn, a real restart, a real bridge. The test suite is not that
path. In September 2026, 5,000+ green tests coexisted with agy being fully
dead, and every agy-verifier bug that month was found on a host, none by the
suite. If you could not run it, say so as the first line of the review.

## 2. List what can be deleted

A review that only adds is half a review. For every guard, gate, retry,
state, quarantine, derived identifier, or reconciliation layer the change adds
or touches, ask:

1. **Delete it on paper. Which test fails, and what does that prove about
   production?** If no test fails, it's dead. If only a test restating its own
   shape fails, the test is circular.
2. **Is the failure it prevents reachable?** Name how the system gets into
   that state. If an earlier layer (a SQL constraint, a type, an upstream
   check) already makes it impossible, the check is only decoration, and
   decoration costs refusals.
3. **Is it reached in production?** Find the production call site that turns
   it on. If only tests enable it, the tests cover a path nobody runs.
4. **Does it report what actually happened?** Assert the content of an error
   or outcome, not just that one occurred.

"I cannot answer this" is a finding, not a pass. An addition needs an
observed failure behind it. "This could happen" isn't enough.

Examples from this repo:
- `--sandbox` was verified for weeks; it was never passed in production (#324).
- `agy-stream.ts` held the real error and threw a bare `protocol_error` (#371).
- `executionIdentity` hashed credential files, stranding turns whenever a
  token rotated (#302).
- A guard on `!acpSessionId` protected a state the schema forbids (#302).
- Controller shutdown killed the agent processes sessiond exists to keep
  alive, and an entire post-dispose drain phase was built to handle the
  aftermath (#631).

## 3. Rank the outcome

Code comments cite this ordering. Best to worst:

1. Works correctly.
2. Works with a labeled caveat.
3. One narrow operation fails with a clear, named reason, and can be recovered.
4. The whole capability fails.
5. Silently does the wrong thing.

Never accept 4 when 3 exists, and never accept 5. Before accepting 3, check
that 1 or 2 really isn't available: retry, reconnect, wait, fall back and
label it. Most of this repo's defects were someone choosing 3 or 4 because it
was easier to prove than 1. Examples:
- An unreadable catalog stopped a host accepting any work (#326).
- One adapter's failed verification killed the whole bridge (#330).
- A delivery predicate would have deleted 2,976 undelivered artifacts
  (#305/#306).

## 4. Empty reviews

A review that comes back empty, refused, or cut short is neither PASS nor
FAIL. Re-issue it and record in the PR that the first attempt returned
nothing. If the second attempt also returns nothing, move the review to a
different agent family, and record that too. Four QA turns were lost this way
in one day (#313), each indistinguishable on screen from "found nothing".

## 5. Briefs

Every brief asks: *what breaks if this mechanism is removed entirely?* and
*what did you run on the real host?* Keep briefs adversarial toward the change,
but aim the verbs at a named artifact, not the running system. Workers here
have host access and deploy authority.
