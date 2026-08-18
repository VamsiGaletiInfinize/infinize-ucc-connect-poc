import type { DocumentStore } from './document-store.ts';

/**
 * In-memory implementation.
 *
 * Used for tests and for local demo runs without AWS. It enforces exactly the same
 * tenant-scoped key discipline as the DynamoDB implementation, so a test that passes here
 * exercises the same isolation guarantee.
 */
export class MemoryDocumentStore implements DocumentStore {
  private readonly items = new Map<string, unknown>();

  private key(collection: string, tenantId: string, id: string): string {
    return `TENANT#${tenantId}#COL#${collection}#ID#${id}`;
  }

  private prefix(collection: string, tenantId: string): string {
    return `TENANT#${tenantId}#COL#${collection}#ID#`;
  }

  async get<T>(collection: string, tenantId: string, id: string): Promise<T | null> {
    const found = this.items.get(this.key(collection, tenantId, id));
    return found ? (structuredClone(found) as T) : null;
  }

  async put<T extends object>(
    collection: string,
    tenantId: string,
    id: string,
    item: T,
  ): Promise<void> {
    this.items.set(this.key(collection, tenantId, id), structuredClone(item));
  }

  async putIfAbsent<T extends object>(
    collection: string,
    tenantId: string,
    id: string,
    item: T,
  ): Promise<boolean> {
    const k = this.key(collection, tenantId, id);
    if (this.items.has(k)) return false;
    this.items.set(k, structuredClone(item));
    return true;
  }

  async list<T>(collection: string, tenantId: string): Promise<T[]> {
    const prefix = this.prefix(collection, tenantId);
    const out: T[] = [];
    for (const [k, v] of this.items) {
      if (k.startsWith(prefix)) out.push(structuredClone(v) as T);
    }
    return out;
  }

  async delete(collection: string, tenantId: string, id: string): Promise<void> {
    this.items.delete(this.key(collection, tenantId, id));
  }

  /** Test helper. */
  clear(): void {
    this.items.clear();
  }

  /** Test helper. */
  size(): number {
    return this.items.size;
  }
}
