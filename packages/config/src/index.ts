import { z } from 'zod';

/**
 * Configuration is read from the environment only.
 *
 * Secrets are never committed, never embedded in source, and never shipped to the
 * frontend. In deployed environments the Lambda/task role supplies AWS credentials and
 * operational parameters come from SSM Parameter Store; locally they come from an
 * `.env` file that is git-ignored (`.env.example` documents the shape).
 */

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  AWS_REGION: z.string().default('us-east-1'),

  /** DynamoDB single table. Falls back to the in-memory store when unset. */
  UCC_TABLE_NAME: z.string().optional(),
  /** Private bucket for recordings and the KB vector index. */
  UCC_BUCKET_NAME: z.string().optional(),

  /** Bedrock inference profile used by the AI orchestrator. */
  BEDROCK_MODEL_ID: z.string().default('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
  BEDROCK_EMBEDDING_MODEL_ID: z.string().default('amazon.titan-embed-text-v2:0'),

  /** Amazon Connect. When absent the simulated telephony provider is used. */
  CONNECT_INSTANCE_ID: z.string().optional(),
  CONNECT_CONTACT_FLOW_ID: z.string().optional(),
  CONNECT_SOURCE_PHONE_NUMBER: z.string().optional(),

  /** Storage backend selection: 'dynamodb' | 'memory'. */
  UCC_PERSISTENCE: z.enum(['dynamodb', 'memory']).default('memory'),
  /** Telephony backend selection: 'connect' | 'simulated'. */
  UCC_TELEPHONY: z.enum(['connect', 'simulated']).default('simulated'),
  /** Retrieval backend: 'bedrock' uses live Titan embeddings; 'lexical' is an offline fallback. */
  UCC_RETRIEVAL: z.enum(['bedrock', 'lexical']).default('bedrock'),

  PORT: z.coerce.number().default(4000),
  /** Comma-separated allowed origins for the web app. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /** Salt for hashing verification codes. Supplied via SSM/Secrets Manager in deployment. */
  VERIFICATION_SALT: z.string().default('ucc-poc-local-salt'),

  /** Default tenant for the demo. */
  DEFAULT_TENANT_ID: z.string().default('infinize-university'),
});

export type UccConfig = z.infer<typeof schema> & {
  corsOrigins: string[];
  /** True when live AWS services should be used for AI and retrieval. */
  awsEnabled: boolean;
};

let cached: UccConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): UccConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const value = parsed.data;
  return {
    ...value,
    corsOrigins: value.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    awsEnabled: value.UCC_RETRIEVAL === 'bedrock',
  };
}

export function config(): UccConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test seam. */
export function resetConfig(): void {
  cached = null;
}
