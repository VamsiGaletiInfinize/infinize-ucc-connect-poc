import { config } from '@ucc/config';
import { logger } from '@ucc/shared';
import { DynamoDocumentStore } from './dynamo-store.ts';
import { MemoryDocumentStore } from './memory-store.ts';
import type { DocumentStore } from './document-store.ts';
import { Repositories } from './repositories.ts';

export * from './document-store.ts';
export * from './memory-store.ts';
export * from './dynamo-store.ts';
export * from './repositories.ts';

/**
 * Select the persistence backend from configuration.
 *
 * DynamoDB is used when `UCC_PERSISTENCE=dynamodb` and a table name is present; otherwise
 * the in-memory store is used. Both enforce identical tenant-scoped key discipline.
 */
export function createDocumentStore(): DocumentStore {
  const cfg = config();
  if (cfg.UCC_PERSISTENCE === 'dynamodb' && cfg.UCC_TABLE_NAME) {
    logger.info('Using DynamoDB persistence', { table: cfg.UCC_TABLE_NAME, region: cfg.AWS_REGION });
    return new DynamoDocumentStore(cfg.UCC_TABLE_NAME, cfg.AWS_REGION);
  }
  logger.info('Using in-memory persistence');
  return new MemoryDocumentStore();
}

export function createRepositories(store?: DocumentStore): Repositories {
  return new Repositories(store ?? createDocumentStore());
}
