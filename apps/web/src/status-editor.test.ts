import { describe, expect, it } from 'vitest';
import { editStatusText } from './status-editor';

describe('status editor keyboard behavior', () => {
  it('continues a bulleted list when Enter is pressed', () => {
    const value = '- Fix the sync bug';
    expect(editStatusText(value, value.length, value.length, 'Enter')).toEqual({
      value: '- Fix the sync bug\n- ',
      selectionStart: 21,
      selectionEnd: 21,
    });
  });

  it('preserves indentation and the bullet marker', () => {
    const value = '  * Review the PR';
    expect(editStatusText(value, value.length, value.length, 'Enter')?.value)
      .toBe('  * Review the PR\n  * ');
  });

  it('leaves Enter alone on a normal line', () => {
    expect(editStatusText('Normal status', 13, 13, 'Enter')).toBeNull();
  });

  it('inserts two spaces at the cursor when Tab is pressed', () => {
    expect(editStatusText('- item', 2, 2, 'Tab')).toEqual({
      value: '-   item',
      selectionStart: 4,
      selectionEnd: 4,
    });
  });

  it('indents every selected line by two spaces', () => {
    const value = '- first\n- second';
    expect(editStatusText(value, 0, value.length, 'Tab')).toEqual({
      value: '  - first\n  - second',
      selectionStart: 2,
      selectionEnd: value.length + 4,
    });
  });
});
