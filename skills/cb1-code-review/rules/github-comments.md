# GitHub review comments

Fetch existing inline comments, submitted reviews, and top-level comments first. Skip any finding whose root cause and impact were already described, whether it came from a human or an agent. Re-check the current head before treating an older comment as applicable or resolved.

Post all new inline findings as one review against the exact head SHA. Anchor only to changed lines: `RIGHT` for added or changed lines, `LEFT` for removed lines. If the underlying bug is on an unchanged line, anchor to the nearest changed line in the same hunk and name the true location in the body. Do not comment on unrelated pre-existing defects.

Each comment is concise:

```text
**High: concise problem**

Concrete failure and when it occurs.

Suggested fix: the smallest specific correction.
```

Do not put a reviewer name or signature in a machine-readable comment body returned to Barbarian; the server appends the configured Review Name and reviewed commit. When posting directly without Barbarian, use `<review name> reviewed <short SHA>` if a review name was explicitly provided, or `Reviewed <short SHA>` otherwise. Never substitute the application or AI-provider name.

Use a GitHub suggestion block only for a literal replacement. Use `COMMENT` for informational findings and `REQUEST_CHANGES` only when the user asked the reviewer to submit that formal verdict. A clean review updates Barbarian's local status only and must not post a top-level comment or submitted review to GitHub.
