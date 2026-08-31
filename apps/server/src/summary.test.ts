import { describe, expect, it } from 'vitest';
import { simplify } from './summary.js';

describe('simplify', () => {
  it('removes conventional-commit cruft and keeps the first useful sentence', () => {
    expect(simplify('fix(storage): prevent stale handles', 'This stops readers from reusing a closed handle.\n\n## Details\nMore text.'))
      .toBe('prevent stale handles. This stops readers from reusing a closed handle.');
  });

  it('falls back to the cleaned title', () => {
    expect(simplify('chore: update docs', '')).toBe('update docs');
  });
});
