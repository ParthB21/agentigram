import { NotImplementedError } from '@clankergram/protocol';

/** Part 3. GitHub App webhook handler; posts the `clankergram/contracts` check run on each PR. */
export function handleWebhook(_name: string, _payload: unknown): Promise<void> {
  throw new NotImplementedError('github.handleWebhook (Part 3)');
}
