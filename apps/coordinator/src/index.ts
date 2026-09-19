import { NotImplementedError } from '@clankergram/protocol';

/**
 * Part 1. The Cloudflare Worker + Durable Object (one per room) lands here. The real
 * coordinator must behave like `@clankergram/simulator`'s mock: assign `seq`, dedupe by id,
 * run `@clankergram/reducer`, replay from `lastSeq`. Durable Objects / Wrangler APIs must be
 * verified against current docs before use (CLAUDE.md rule 10).
 */
export function fetch(_request: Request): Promise<Response> {
  throw new NotImplementedError('coordinator.fetch (Part 1)');
}
