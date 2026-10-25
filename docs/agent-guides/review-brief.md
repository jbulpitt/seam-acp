# Review brief

Use this in review requests; the [review guide](review-guide.md) explains why.
Follow the current task's scope and authorization.

1. Exercise the relevant real path on the real host before reading the diff
   when it is in scope. Start the review with what ran, where, the result and
   limits. If it was not run, say so and why in the first line.
2. List what can be deleted before suggesting additions. What breaks if the
   mechanism is removed entirely?
3. For each proposed guard, retry, state or refusal, name an observed failure
   and its evidence. Is it reachable? Does the mechanism have a production
   caller and a behavioral test that fails without it? Explain what the test
   proves about production.
4. An empty, refused or cut-short review is neither PASS nor FAIL. Re-issue it
   and record the empty attempt in the PR. If the second attempt is also empty,
   change agent family, as the guide describes.
