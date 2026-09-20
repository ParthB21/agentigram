import { describe, expect, it } from 'vitest';
import { failClosedDenial, isPreToolEvent } from './fail-closed.js';

const base = { hook_event_name: 'PreToolUse', cwd: '/repo' };
const write = { ...base, tool_name: 'Write', tool_input: { file_path: 'CLAUDE.md' } };
const shell = { ...base, tool_name: 'Bash', tool_input: { command: 'ls' } };

describe('failClosedDenial', () => {
  it('denies a file write when the daemon cannot be asked', () => {
    const denial = failClosedDenial('claude', write, 'timed out') as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(denial.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denial.hookSpecificOutput.permissionDecisionReason).toMatch(/^STOP\./);
    expect(denial.hookSpecificOutput.permissionDecisionReason).toContain('CLAUDE.md');
  });

  it('lets calls that name no file through, so a dead daemon does not brick the agent', () => {
    expect(failClosedDenial('claude', shell, 'timed out')).toBeUndefined();
  });

  it('answers gemini in its own shape', () => {
    const denial = failClosedDenial(
      'gemini-cli',
      { ...base, tool_name: 'write_file', tool_input: { file_path: 'a.md' } },
      'x',
    ) as { decision: string };
    expect(denial.decision).toBe('deny');
  });

  it('refuses nothing it cannot read', () => {
    expect(failClosedDenial('claude', { nonsense: true }, 'x')).toBeUndefined();
  });

  it('only pre-tool events can be refused', () => {
    expect(isPreToolEvent('PreToolUse')).toBe(true);
    expect(isPreToolEvent('PostToolUse')).toBe(false);
  });
});
