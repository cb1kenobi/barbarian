interface IssueProgressMetadata {
  in_progress_source: string | null;
  in_progress_pr: string | null;
  in_progress_pr_draft: boolean;
  in_progress_branch: string | null;
  fixed_by: string | null;
  duplicate_of: string | null;
}

export function issueProgress(item: IssueProgressMetadata): string | null {
  if (item.in_progress_source === 'pull_request') {
    const number = item.in_progress_pr?.match(/\/pull\/(\d+)/)?.[1];
    if (!number) return 'In progress · linked PR';
    return `In progress · PR #${number}${item.in_progress_pr_draft ? ' (draft)' : ''}`;
  }
  if (item.in_progress_source === 'local_branch') return `In progress · local ${item.in_progress_branch}`;
  if (item.in_progress_source === 'label') return 'In progress · GitHub label';
  if (item.fixed_by) return 'Linked PR merged';
  if (item.duplicate_of) return `Duplicate: ${item.duplicate_of}`;
  return null;
}
