import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DocumentStore } from './document-store.ts';

/**
 * DynamoDB single-table implementation.
 *
 * Key design:
 *   PK = TENANT#<tenantId>#COL#<collection>
 *   SK = <id>
 *
 * Listing a collection is a Query on PK — it never scans, and it cannot cross a tenant
 * boundary because the tenant is baked into the partition key.
 *
 * `putIfAbsent` uses a conditional write (`attribute_not_exists(PK)`), which is how event
 * idempotency is enforced at the storage layer rather than in application logic.
 */
export class DynamoDocumentStore implements DocumentStore {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    region: string,
    client?: DynamoDBClient,
  ) {
    const base = client ?? new DynamoDBClient({ region });
    this.doc = DynamoDBDocumentClient.from(base, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  private pk(collection: string, tenantId: string): string {
    return `TENANT#${tenantId}#COL#${collection}`;
  }

  async get<T>(collection: string, tenantId: string, id: string): Promise<T | null> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: this.pk(collection, tenantId), SK: id },
      }),
    );
    return (res.Item?.data as T) ?? null;
  }

  async put<T extends object>(
    collection: string,
    tenantId: string,
    id: string,
    item: T,
  ): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: this.pk(collection, tenantId),
          SK: id,
          tenantId,
          collection,
          data: item,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  async putIfAbsent<T extends object>(
    collection: string,
    tenantId: string,
    id: string,
    item: T,
  ): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: this.pk(collection, tenantId),
            SK: id,
            tenantId,
            collection,
            data: item,
            updatedAt: new Date().toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }

  async list<T>(collection: string, tenantId: string): Promise<T[]> {
    const out: T[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'PK' },
          ExpressionAttributeValues: { ':pk': this.pk(collection, tenantId) },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of res.Items ?? []) out.push(item.data as T);
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return out;
  }

  async delete(collection: string, tenantId: string, id: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: this.pk(collection, tenantId), SK: id },
      }),
    );
  }
}
