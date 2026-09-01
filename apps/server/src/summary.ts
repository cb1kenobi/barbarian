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

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sentenceCandidates(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length >= 20 && !/^https?:\/\/\S+$/i.test(sentence))
    .map((sentence) => truncateAtWord(sentence, 300));
}

function truncateAtWord(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const shortened = value.slice(0, limit - 1).replace(/\s+\S*$/, '').trimEnd();
  return `${shortened || value.slice(0, limit - 1).trimEnd()}…`;
}

function joinCompleteSentences(sentences: string[], limit = 680): string {
  const selected: string[] = [];
  for (const sentence of sentences) {
    const candidate = [...selected, sentence].join(' ');
    if (candidate.length <= limit) {
      selected.push(sentence);
      continue;
    }
    if (!selected.length) selected.push(truncateAtWord(sentence, limit));
    break;
  }
  return selected.join(' ');
}

function markdownSections(body: string): Array<{ heading: string; body: string }> {
  return [...body.matchAll(/^#{1,6}[ \t]+([^\r\n]+?)[ \t]*\r?\n([\s\S]*?)(?=^#{1,6}[ \t]+|(?![\s\S]))/gm)]
    .map((match) => ({ heading: match[1]?.trim() || '', body: usefulParagraphs(match[2] || '').join(' ') }))
    .filter((section) => section.body);
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

export function summarizePullRequest(title: string, body = ''): string {
  const cleanTitle = title.replace(cruft, '').replace(/\s+/g, ' ').trim();
  const normalizedTitle = normalizedText(cleanTitle);
  const paragraphs = usefulParagraphs(body)
    .filter((paragraph) => !/(?:🤖\s*)?generated with|review checklist|test plan/i.test(paragraph));
  const sections = markdownSections(body)
    .filter((section) => !/test|checklist|screenshots?|documentation/i.test(section.heading));
  const preferredSections = sections.filter((section) =>
    /summary|overview|description|what this is|problem|why|context|motivation|root cause|solution|fix|implementation|approach|what changed|changes/i.test(section.heading),
  );
  const firstHeading = body.search(/^#{1,6}[ \t]+/m);
  const intro = firstHeading > 0 ? usefulParagraphs(body.slice(0, firstHeading))[0] : undefined;
  const sources = (preferredSections.length
    ? [intro, ...preferredSections.map((section) => section.body)]
    : paragraphs.slice(0, 2))
    .filter((source): source is string => Boolean(source));
  const seenSources = new Set<string>();
  const seenSentences = new Set<string>();
  const sentences: string[] = [];

  for (const [index, source] of sources.entries()) {
    const normalizedSource = normalizedText(source);
    if (!normalizedSource || seenSources.has(normalizedSource)) continue;
    seenSources.add(normalizedSource);
    const desiredFromSource = sources.length === 1 || index === sources.length - 1 ? 2 : 1;
    const sourceLimit = Math.min(desiredFromSource, 4 - sentences.length);
    let selectedFromSource = 0;
    for (const sentence of sentenceCandidates(source)) {
      const normalizedSentence = normalizedText(sentence);
      if (!normalizedSentence || normalizedSentence === normalizedTitle || seenSentences.has(normalizedSentence)) continue;
      seenSentences.add(normalizedSentence);
      sentences.push(sentence);
      selectedFromSource += 1;
      if (sentences.length === 4 || selectedFromSource === sourceLimit) break;
    }
    if (sentences.length === 4) break;
  }

  if (!sentences.length) return 'No additional description was provided.';
  return joinCompleteSentences(sentences);
}

export function explainPullRequest(title: string, body = ''): string {
  const cleanTitle = title.replace(cruft, '').replace(/\s+/g, ' ').trim();
  const sections = markdownSections(body);
  const paragraphs = usefulParagraphs(body);
  const problemSection = sections.find((section) => /problem|why|context|motivation|root cause|summary/i.test(section.heading));
  const solutionSection = sections.find((section) => /solution|fix|implementation|approach|what changed|changes/i.test(section.heading));
  const problem = shortExplanation(problemSection?.body || paragraphs[0] || cleanTitle);
  const fallbackSolution = paragraphs.find((paragraph) => paragraph !== paragraphs[0])
    || `This change updates the code so ${cleanTitle.charAt(0).toLowerCase()}${cleanTitle.slice(1)}.`;
  const solution = shortExplanation(solutionSection?.body || fallbackSolution);
  return `Problem: ${problem}\n\nSolution: ${solution}`;
}
