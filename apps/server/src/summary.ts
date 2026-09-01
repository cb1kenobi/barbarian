const cruft = /(^|\s)(fix|feat|chore|refactor|docs|test)(\([^)]*\))?:\s*/i;

function cleanMarkdown(value: string): string {
  return value
    .replace(/<!--[^]*?-->/g, '')
    .replace(/```[^]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[>*_`|]/g, '')
    .replace(/\r/g, '')
    .trim();
}

function usefulParagraphs(value: string): string[] {
  return cleanMarkdown(value)
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#{1,6}\s+[^\n]+\n?/, '').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 24 && !/^(generated|signed|review-coverage|human-review-need)\b/i.test(part));
}

function shortExplanation(value: string, limit = 330): string {
  const sentences = value.split(/(?<=[.!?])\s+/).filter(Boolean);
  const selected = (sentences.slice(0, 2).join(' ') || value).trim();
  return selected.length <= limit ? selected : `${selected.slice(0, limit - 1).trimEnd()}…`;
}

export function simplify(title: string, body = ''): string {
  const cleanTitle = title.replace(cruft, '').replace(/\s+/g, ' ').trim();
  const firstSentence = body
    .replace(/<!--[^]*?-->/g, '')
    .replace(/```[^]*?```/g, '')
    .replace(/[#>*_`\[\]]/g, '')
    .split(/(?<=[.!?])\s|\n{2,}/)
    .map((part) => part.trim())
    .find((part) => part.length >= 20 && part.length <= 180);
  if (!firstSentence) return cleanTitle;
  return `${cleanTitle}. ${firstSentence}`.slice(0, 240);
}

export function explainPullRequest(title: string, body = ''): string {
  const cleanTitle = title.replace(cruft, '').replace(/\s+/g, ' ').trim();
  const sections = [...body.matchAll(/^#{1,6}\s+(.+?)\s*$\n([^]*?)(?=^#{1,6}\s+|$)/gm)]
    .map((match) => ({ heading: match[1]?.trim() || '', body: usefulParagraphs(match[2] || '').join(' ') }))
    .filter((section) => section.body);
  const paragraphs = usefulParagraphs(body);
  const problemSection = sections.find((section) => /problem|why|context|motivation|root cause|summary/i.test(section.heading));
  const solutionSection = sections.find((section) => /solution|fix|implementation|approach|what changed|changes/i.test(section.heading));
  const problem = shortExplanation(problemSection?.body || paragraphs[0] || cleanTitle);
  const fallbackSolution = paragraphs.find((paragraph) => paragraph !== paragraphs[0])
    || `This change updates the code so ${cleanTitle.charAt(0).toLowerCase()}${cleanTitle.slice(1)}.`;
  const solution = shortExplanation(solutionSection?.body || fallbackSolution);
  return `Problem: ${problem}\n\nSolution: ${solution}`;
}
