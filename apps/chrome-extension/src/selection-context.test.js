import { describe, expect, it } from 'vitest';
import { selectedLineCount, selectionLabel, selectionPromptContext } from './selection-context.js';

describe('GitHub selection context', () => {
  it('uses GitHub line metadata when available', () => {
    const selection = { text: 'first\nsecond', line: '10', endLine: '12', lineCount: 3, path: 'src/app.js', url: 'https://example.test' };
    expect(selectedLineCount(selection)).toBe(3);
    expect(selectionLabel(selection)).toBe('3 lines selected');
    expect(selectionPromptContext(selection)).toContain('Selected 3 lines from src/app.js:10-12');
    expect(selectionPromptContext(selection)).toContain('<selected_code>\nfirst\nsecond\n</selected_code>');
  });

  it('falls back to the selected text line count', () => {
    expect(selectionLabel({ text: 'one\ntwo', url: 'https://example.test' })).toBe('2 lines selected');
  });
});
