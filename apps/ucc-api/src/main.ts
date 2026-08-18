import { config } from '@ucc/config';
import { logger } from '@ucc/shared';
import { buildContainer } from './bootstrap/container.ts';
import { createServer } from './server.ts';

async function main(): Promise<void> {
  const cfg = config();
  const container = await buildContainer();
  const app = await createServer(container);

  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  logger.info('UCC API listening', { port: cfg.PORT, tenantId: container.tenantId });

  const shutdown = async (signal: string) => {
    logger.info('Shutting down', { signal });
    container.realtime.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('Fatal startup error', { error: String(error) });
  process.exit(1);
});
