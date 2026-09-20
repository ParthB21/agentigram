import { describe, expect, it } from 'vitest';
import { shellActivity } from './shell.js';

describe('shellActivity', () => {
  it('sees a redirect as a write', () => {
    expect(shellActivity("printf '# hi\\n' > README.md").writes).toEqual(['README.md']);
    expect(shellActivity('cat a.ts >> src/b.ts').writes).toEqual(['src/b.ts']);
  });

  it('ignores a stream redirect and /dev/null', () => {
    expect(shellActivity('npm test 2>&1').writes).toEqual([]);
    expect(shellActivity('rg foo src 2>/dev/null').writes).toEqual([]);
    expect(shellActivity('node x.js > /dev/null').writes).toEqual([]);
  });

  it('reads each command in a chain', () => {
    const found = shellActivity('cd repo && sed -i "s/a/b/" src/a.ts && echo done > out.txt');
    expect(found.writes).toEqual(['src/a.ts', 'out.txt']);
  });

  it('does not split inside quotes', () => {
    expect(shellActivity('echo "a && b" > note.txt').writes).toEqual(['note.txt']);
  });

  it('treats sed without -i as a read', () => {
    expect(shellActivity("sed -n '1,40p' src/a.ts").writes).toEqual([]);
  });

  it('takes the destination of a move or copy, not the source', () => {
    expect(shellActivity('mv src/old.ts src/new.ts').writes).toEqual(['src/new.ts']);
    expect(shellActivity('cp a.ts b.ts').writes).toEqual(['b.ts']);
  });

  it('counts a delete as a change to the tree', () => {
    expect(shellActivity('rm -rf src/dead.ts').writes).toEqual(['src/dead.ts']);
  });

  it('names the git subcommand that changed the tree', () => {
    expect(shellActivity('git commit -m "wip"').git).toBe('git commit');
    expect(shellActivity('git checkout main').git).toBe('git checkout');
    expect(shellActivity('git add . && git commit -m x && git push').git).toBe('git commit');
  });

  it('says nothing about a git command that reads', () => {
    expect(shellActivity('git status --porcelain').git).toBeUndefined();
    expect(shellActivity('git log --oneline -5').git).toBeUndefined();
  });

  it('drops anything it would have to guess at', () => {
    expect(shellActivity('rm -rf $BUILD_DIR').writes).toEqual([]);
    expect(shellActivity('rm -f dist/*.js').writes).toEqual([]);
    expect(shellActivity(undefined).writes).toEqual([]);
  });
});
