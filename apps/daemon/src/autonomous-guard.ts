import { isAbsolute, relative, resolve, sep } from 'node:path';

const DESTRUCTIVE_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(?:^|[;&|]\s*)rm\s+[^\n]*(?:-[A-Za-z]*r[A-Za-z]*|--recursive)\b/i,
    reason: 'recursive deletion',
  },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'git reset --hard' },
  {
    pattern: /\bgit\s+clean\s+[^\n]*(?:-[A-Za-z]*f[A-Za-z]*|--force)\b/i,
    reason: 'git clean --force',
  },
  {
    pattern: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?\b|\s-f\b|\s\+[^\s]+)/i,
    reason: 'force-push',
  },
];

export type AutonomousTool = {
  root: string;
  cwd: string;
  paths: string[];
  command?: string;
};

/** Guardrails retained when a managed host bypasses its own approval prompts. */
export function autonomousDenial(tool: AutonomousTool): string | undefined {
  const root = resolve(tool.root);
  const cwd = resolve(tool.cwd);
  const cwdFromRoot = relative(root, cwd);
  if (cwdFromRoot === '..' || cwdFromRoot.startsWith(`..${sep}`) || isAbsolute(cwdFromRoot)) {
    return `managed autonomy cannot run outside the repository: ${tool.cwd}`;
  }
  for (const path of tool.paths) {
    const candidate = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
    const fromRoot = relative(root, candidate);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      return `managed autonomy cannot edit outside the repository: ${path}`;
    }
  }
  if (!tool.command) return undefined;
  for (const denied of DESTRUCTIVE_COMMANDS) {
    if (denied.pattern.test(tool.command)) {
      return `managed autonomy blocked ${denied.reason}`;
    }
  }
  return undefined;
}
