// Keep the card count and Findings history on the same set of retained rounds.
export const reviewRoundFilterSql = "task LIKE 'code_review:%' AND status IN ('complete', 'failed', 'cancelled')";
export const reviewRoundKeySql = "CASE WHEN COALESCE(owner, '')<>'' THEN 'owner:' || owner ELSE 'run:' || id END";
