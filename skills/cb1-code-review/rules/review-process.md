# Review process

Answer these in order:

1. What repository-local instructions and conventions apply to these files?
2. What outcome does the PR claim?
3. What does the linked issue require, including edge cases and compatibility?
4. What changed outside that scope, and does it add risk?
5. Do tests cover new behavior, boundaries, regressions, and failure paths?
6. Do public docs, README examples, types, schemas, and doc comments still match?
7. Is every abstraction and dependency earned, or can the same result be simpler?
8. What existing callers, defaults, return values, timing, persisted data, or resource usage can regress?
9. Do the relevant tests and build actually pass in the exact reviewed checkout?

Then trace each changed function's success and failure paths. Pay particular attention to partial operations: locks, handles, temp files, database writes, network retries, and cleanup must remain correct when the middle step fails.

Follow changed values across API, process, storage, and trust boundaries. Check both producers and consumers when a type, schema, default, or serialized format changes. Inspect call sites rather than assuming a function is used as its name suggests.

Before reporting a finding, read enough surrounding code to demonstrate the failure and confirm that the reviewed change introduced or worsened it. Confidence and severity are separate: suppress unverified suspicions rather than presenting them at a lower severity.
