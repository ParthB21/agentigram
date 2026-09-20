import { describe, expect, it } from 'vitest';
import { autonomousDenial } from './autonomous-guard.js';

const base = { root: '/repo', cwd: '/repo', paths: [] as string[] };

describe('managed autonomy guard', () => {
  it('confines structured edits to the repository', () => {
    expect(autonomousDenial({ ...base, paths: ['src/index.ts'] })).toBeUndefined();
    expect(autonomousDenial({ ...base, paths: ['/tmp/outside.ts'] })).toContain(
      'outside the repository',
    );
    expect(autonomousDenial({ ...base, cwd: '/tmp', paths: [] })).toContain(
      'outside the repository',
    );
  });

  it.each([
    'rm -rf build',
    'rm --recursive build',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'git push origin main --force',
    'git push -f origin main',
  ])('blocks destructive command: %s', (command) => {
    expect(autonomousDenial({ ...base, command })).toContain('managed autonomy blocked');
  });

  it('allows ordinary repository commands', () => {
    expect(autonomousDenial({ ...base, command: 'pnpm test' })).toBeUndefined();
    expect(autonomousDenial({ ...base, command: 'git status --short' })).toBeUndefined();
  });
});
