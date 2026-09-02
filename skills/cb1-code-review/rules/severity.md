# Finding severity

Severity measures impact if the problem occurs. Confidence measures whether the problem is real. Report only high-confidence findings, then assign severity from impact:

- **Critical** — expected use can cause widespread compromise, irreversible data loss, or loss of control with no practical mitigation. Must block merge.
- **High** — a likely path causes a serious security, data-integrity, availability, or core-correctness failure. Should block merge.
- **Medium** — a real functional regression occurs under plausible but limited conditions, or recovery is available. Normally fix before merge.
- **Low** — a localized correctness, compatibility, performance, or maintainability defect with modest impact and a concrete failure mode.
- **Nit** — a non-functional issue that violates an established repository convention. Omit subjective preferences and cosmetic churn.

Judge the actual changed behavior, not the size of the diff. A one-line authorization bypass can be Critical; a large refactor can have no findings. Missing tests are evidence, not automatically a finding: report them only when they leave a specific regression or contract unprotected.
