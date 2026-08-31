const cruft = /(^|\s)(fix|feat|chore|refactor|docs|test)(\([^)]*\))?:\s*/i;

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
