# Review process

Answer these in order:

1. What outcome does the PR claim?
2. What does the linked issue require, including edge cases and compatibility?
3. What changed outside that scope, and does it add risk?
4. Do tests cover new behavior, boundaries, regressions, and failure paths?
5. Do public docs, README examples, types, and doc comments still match?
6. Is every abstraction and dependency earned, or can the same result be simpler?
7. What existing callers, defaults, return values, timing, or resource usage can regress?
8. Do the relevant tests and build actually pass in the exact reviewed checkout?

Then trace each changed function's success and failure paths. Pay particular attention to partial operations: locks, handles, temp files, database writes, network retries, and cleanup must remain correct when the middle step fails.

Before reporting a finding, read enough surrounding code to demonstrate the failure. Confidence and severity are separate; report a confirmed narrow issue as Low rather than dropping it, and suppress unverified suspicions.

