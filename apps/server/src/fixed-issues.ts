export interface FixedIssueReference {
  provider: 'github' | 'linear';
  identifier: string;
  url: string | null;
}

const closingDirective = /^\s*(?:[-*+]\s*)?(?:\[[ xX]\]\s*)?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(.+)$/i;
const linearIdentifier = '[A-Z][A-Z0-9]*-\\d+';
const linearUrl = new RegExp(`^https://linear\\.app/[^/\\s]+/issue/(${linearIdentifier})(?:/[^\\s,)]*)?`, 'i');
const markdownLinearLink = new RegExp(`^\\[(${linearIdentifier})\\]\\((https://linear\\.app/[^\\s)]+/issue/${linearIdentifier}(?:/[^\\s)]*)?)\\)`, 'i');
const bareLinearIdentifier = new RegExp(`^(${linearIdentifier})\\b`, 'i');
const referenceSeparator = /^(?:\s*,\s*|\s+and\s+)/i;

function normalizeLinearUrl(value: string): string {
  return value.replace(/[.;:]+$/, '');
}

/**
 * Extract only Linear issues named by an explicit closing directive in a PR body.
 * Plain issue mentions are deliberately ignored so backlinks cannot enter the list.
 */
export function extractLinearClosingReferences(body: string): FixedIssueReference[] {
  const references: FixedIssueReference[] = [];
  const seen = new Set<string>();

  for (const clause of body.split(/[\n;]/)) {
    const directive = clause.match(closingDirective);
    if (!directive?.[1]) continue;
    let remaining = directive[1].trim();

    while (remaining) {
      let identifier = '';
      let url: string | null = null;
      let consumed = '';
      const markdown = remaining.match(markdownLinearLink);
      const rawUrl = remaining.match(linearUrl);
      const bare = remaining.match(bareLinearIdentifier);

      if (markdown) {
        identifier = markdown[1]!.toUpperCase();
        url = normalizeLinearUrl(markdown[2]!);
        consumed = markdown[0];
      } else if (rawUrl) {
        identifier = rawUrl[1]!.toUpperCase();
        url = normalizeLinearUrl(rawUrl[0]);
        consumed = rawUrl[0];
      } else if (bare) {
        identifier = bare[1]!.toUpperCase();
        consumed = bare[0];
      } else {
        break;
      }

      if (!seen.has(identifier)) {
        seen.add(identifier);
        references.push({ provider: 'linear', identifier, url });
      }

      remaining = remaining.slice(consumed.length);
      const separator = remaining.match(referenceSeparator);
      if (!separator) break;
      remaining = remaining.slice(separator[0].length);
    }
  }

  return references;
}

export function fixedIssueReferences(
  repository: string,
  body: string,
  githubIssueNumbers: number[],
): FixedIssueReference[] {
  const github = [...new Set(githubIssueNumbers)]
    .filter((number) => Number.isInteger(number) && number > 0)
    .map((number) => ({
      provider: 'github' as const,
      identifier: `#${number}`,
      url: `https://github.com/${repository}/issues/${number}`,
    }));
  return [...github, ...extractLinearClosingReferences(body)];
}
