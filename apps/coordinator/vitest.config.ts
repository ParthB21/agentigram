import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Two projects: `core` is plain Node (fast, no Cloudflare); `workers` runs `*.do.test.ts` inside
// workerd against the real Durable Object, using the Cloudflare Vitest plugin (needs Node >= 22).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.do.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: { ROOM_SECRET: 'test-room-secret', WORKER_SECRET: 'test-worker-secret' },
            },
          }),
        ],
        test: { name: 'workers', include: ['src/**/*.do.test.ts'] },
      },
    ],
  },
});
