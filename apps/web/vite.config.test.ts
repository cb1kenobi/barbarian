import { describe, expect, it } from 'vitest';
import config from './vite.config.js';

describe('Vite API proxy', () => {
  it('preserves the development dashboard host so it matches the browser origin', () => {
    expect(config.server?.proxy?.['/api']).toMatchObject({ changeOrigin: false });
  });
});
