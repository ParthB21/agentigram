import { MCP_TOOL_NAMES, symbolKey, ValidationError } from '@agentigram/protocol';
import { describe, expect, it } from 'vitest';
import { buildToolDefs, parseToolCall, TOOL_DESCRIPTIONS } from './index.js';

describe('MCP tools', () => {
  it('advertises exactly the eight declared tools, each with a JSON Schema and description', () => {
    const defs = buildToolDefs();
    expect(defs.map((d) => d.name)).toEqual(MCP_TOOL_NAMES);
    for (const d of defs) {
      expect(d.inputSchema.type).toBe('object');
      expect(d.description.length).toBeGreaterThan(10);
    }
    expect(Object.keys(TOOL_DESCRIPTIONS)).toHaveLength(8);
  });

  it('can disable individual tools', () => {
    expect(buildToolDefs(new Set(['ask_context'])).map((d) => d.name)).not.toContain('ask_context');
  });

  it('exposes no way to run commands on a peer', () => {
    expect(buildToolDefs().every((d) => !/exec|shell|run_/.test(d.name))).toBe(true);
  });

  it('validates untrusted tool calls with the protocol schema', () => {
    const key = symbolKey('src/types/user.ts', 'User', 'id', 'property');
    expect(parseToolCall('announce_intent', { task: 't', files: [], symbols: [key] }).name).toBe(
      'announce_intent',
    );
    expect(() =>
      parseToolCall('announce_intent', { task: 't', files: [], symbols: ['nope'] }),
    ).toThrow(ValidationError);
    expect(() => parseToolCall('rm_rf', {})).toThrow(ValidationError);
    expect(() => parseToolCall('message_agent', { to: 'a', text: 'x'.repeat(5000) })).toThrow(
      ValidationError,
    );
    expect(parseToolCall('sync', undefined).name).toBe('sync');
  });
});
