import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleWebhook, parseAttribution, verifyWebhookSignature } from './index.js';

describe('@clankergram/github', () => {
  it('verifies webhook signatures', () => {
    const body = '{"ok":true}';
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
    expect(verifyWebhookSignature(body, signature, 'secret')).toBe(true);
    expect(verifyWebhookSignature(body, signature, 'wrong')).toBe(false);
  });

  it('attributes commits and converts workflow results', async () => {
    expect(parseAttribution('work\n\nAgentigram-Run: r1\nAgentigram-Model: gpt', 'abc')).toEqual({
      commit: 'abc',
      runId: 'r1',
      model: 'gpt',
    });
    const result = await handleWebhook('workflow_run', {
      workflow_run: {
        head_sha: 'abc',
        conclusion: 'success',
        head_commit: { message: 'Agentigram-Run: r1' },
      },
    });
    expect(result.events).toEqual([
      { type: 'CI_RESULT', commit: 'abc', status: 'pass', runId: 'r1' },
    ]);
  });
});
