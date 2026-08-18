import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const r = (p: string) => path.resolve(root, p);

export default defineConfig({
  resolve: {
    alias: {
      '@ucc/types': r('packages/types/src/index.ts'),
      '@ucc/shared': r('packages/shared/src/index.ts'),
      '@ucc/config': r('packages/config/src/index.ts'),
      '@ucc/services/store': r('services/store/src/index.ts'),
      '@ucc/services/ai': r('services/ai/src/index.ts'),
      '@ucc/services/identity': r('services/identity/src/index.ts'),
      '@ucc/services/verification': r('services/verification/src/index.ts'),
      '@ucc/services/applications': r('services/applications/src/index.ts'),
      '@ucc/services/calls': r('services/calls/src/index.ts'),
      '@ucc/services/events': r('services/events/src/index.ts'),
      '@ucc/services/routing': r('services/routing/src/index.ts'),
      '@ucc/services/ticketing': r('services/ticketing/src/index.ts'),
      '@ucc/services/knowledge': r('services/knowledge/src/index.ts'),
      '@ucc/services/telephony': r('services/telephony/src/index.ts'),
      '@ucc/services/agents': r('services/agents/src/index.ts'),
      '@ucc/services/outbound': r('services/outbound/src/index.ts'),
      '@ucc/services/recording': r('services/recording/src/index.ts'),
      '@ucc/services/realtime': r('services/realtime/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'threads',
  },
});
