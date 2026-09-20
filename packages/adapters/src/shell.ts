/**
 * What a shell command did to the working tree.
 *
 * Every host reports an edit made with its own edit tool, and none of them report one made with
 * `sed -i`, a redirect or `git checkout`. An agent that works through the shell is invisible to
 * collision detection, which is the one thing it must not be. This is a deliberately shallow
 * reading of the command line — no shell is run, nothing is expanded, and anything ambiguous is
 * dropped rather than guessed, because a wrong path here becomes a wrong collision.
 */

/** `git` subcommands that change tracked files in the working tree. */
const GIT_WRITING = new Set([
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'merge',
  'pull',
  'rebase',
  'reset',
  'restore',
  'revert',
  'stash',
  'switch',
]);
/** `s/a/b/`, `y/a/b/`, `3d` — a sed script, not one of its files. */
const SED_SCRIPT = /^[0-9,$~^]*[sy]\W|^[0-9,$]*[dp]$/;

export type ShellActivity = {
  /** Paths the command appears to have written. */
  writes: string[];
  /** `git commit`, `git checkout`, … when the command ran one that matters. */
  git?: string;
};

/**
 * Split on separators without splitting inside quotes, so `echo "a && b" > f` stays one command.
 */
function segments(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote) {
      current += char;
      if (char === quote && command[i - 1] !== '\\') quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === '&&' || pair === '||') {
      parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (char === ';' || char === '|' || char === '\n') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** `"src/a.ts"` -> `src/a.ts`; a path with a glob, a variable or a substitution is not a path. */
function literal(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const bare = token.replace(/^['"]|['"]$/g, '').trim();
  if (bare.length === 0) return undefined;
  if (/[*?$`]/.test(bare)) return undefined;
  if (bare.startsWith('-')) return undefined;
  if (bare === '/dev/null' || bare.startsWith('/dev/')) return undefined;
  return bare.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** Tokens of one command, keeping quoted runs together. */
function tokens(segment: string): string[] {
  return segment.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
}

/** Everything after the flags: the operands a write command acts on. */
function operands(rest: readonly string[]): string[] {
  return rest
    .filter((token) => !token.startsWith('-'))
    .map(literal)
    .filter((path): path is string => Boolean(path));
}

function redirects(segment: string): string[] {
  const found: string[] = [];
  // `> file` and `>> file`, but not `2>` or `2>&1`, which redirect a stream and not a file.
  for (const match of segment.matchAll(/(?<![0-9&])>>?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g)) {
    const path = literal(match[1]);
    if (path) found.push(path);
  }
  return found;
}

/** Paths a single command writes, and the git subcommand it ran. */
function readSegment(segment: string): ShellActivity {
  const writes = redirects(segment);
  const parts = tokens(segment);
  const [head = '', ...rest] = parts;
  const name = head.split('/').pop() ?? head;

  switch (name) {
    case 'tee':
      writes.push(...operands(rest));
      break;
    case 'touch':
    case 'patch':
      writes.push(...operands(rest));
      break;
    case 'rm':
      writes.push(...operands(rest));
      break;
    case 'sed':
      // Only `-i` edits in place; every other sed writes to stdout.
      if (rest.some((token) => token.startsWith('-i'))) {
        writes.push(...operands(rest).filter((path) => !SED_SCRIPT.test(path)));
      }
      break;
    case 'mv':
    case 'cp': {
      const paths = operands(rest);
      // The destination is written; the source is not. `mv a b c/` writes into c/.
      if (paths.length >= 2) writes.push(paths[paths.length - 1] as string);
      break;
    }
    case 'git': {
      const sub = rest.find((token) => !token.startsWith('-'));
      if (sub === 'commit') return { writes, git: 'git commit' };
      if (sub && GIT_WRITING.has(sub)) return { writes, git: `git ${sub}` };
      break;
    }
    default:
      break;
  }
  return { writes };
}

/**
 * Read a whole command line. Returns the paths it wrote and the most significant git subcommand
 * it ran, both deduplicated and in the order they appeared.
 */
export function shellActivity(command: string | undefined): ShellActivity {
  if (typeof command !== 'string' || command.length === 0) return { writes: [] };
  const writes: string[] = [];
  let git: string | undefined;
  for (const segment of segments(command)) {
    const found = readSegment(segment);
    writes.push(...found.writes);
    // A commit is the one worth reporting when a line does several things.
    if (found.git && (!git || found.git === 'git commit')) git = found.git;
  }
  return { writes: [...new Set(writes)], ...(git ? { git } : {}) };
}
