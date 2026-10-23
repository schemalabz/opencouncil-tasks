import { describe, it, expect } from 'vitest';
import { childEnv } from './childEnv.js';

describe('childEnv', () => {
  it('keeps only the variables ffmpeg needs', () => {
    const env = childEnv({
      PATH: '/usr/bin',
      HOME: '/home/app',
      LANG: 'C.UTF-8',
      FONTCONFIG_FILE: '/etc/fonts/fonts.conf',
      ANTHROPIC_API_KEY: 'secret',
      DO_SPACES_SECRET: 'secret',
      DATABASE_URL: 'postgres://secret',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/app',
      LANG: 'C.UTF-8',
      FONTCONFIG_FILE: '/etc/fonts/fonts.conf',
    });
  });

  it('omits allowlisted variables that are unset', () => {
    expect(childEnv({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' });
  });
});
