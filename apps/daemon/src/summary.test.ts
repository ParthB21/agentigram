import { describe, expect, it } from 'vitest';
import { toolLabel } from './daemon.js';

describe('toolLabel', () => {
  it('drops the command the adapter packs into a Bash tool name', () => {
    expect(toolLabel('Bash: cd /repo && sed -n 1,40p src/types/user.ts')).toBe('a shell command');
    expect(toolLabel('Bash')).toBe('a shell command');
    expect(toolLabel('shell')).toBe('a shell command');
  });

  it('reduces an MCP triple to the tool it names', () => {
    expect(toolLabel('mcp__agentigram__announce_intent')).toBe('announce intent');
    expect(toolLabel('mcp__filesystem__read_file')).toBe('read file');
  });

  it('leaves an ordinary tool alone and never returns empty', () => {
    expect(toolLabel('update_plan')).toBe('update_plan');
    expect(toolLabel('')).toBe('a tool');
  });
});
