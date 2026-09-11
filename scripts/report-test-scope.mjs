const scope = process.argv[2];

if (scope === "non-live") {
  console.log(
    "Test scope: bounded non-live suite (**/*.int.test.ts excluded; no provider requests)."
  );
} else if (scope === "live") {
  console.log(
    "Test scope: explicitly opted-in live integration suite (provider requests may be billable)."
  );
} else {
  throw new Error(`Unknown test scope: ${scope ?? "missing"}`);
}
