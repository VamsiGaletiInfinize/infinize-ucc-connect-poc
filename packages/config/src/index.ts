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

  /**
   * Twilio. Used when UCC_TELEPHONY=twilio.
   *
   * Amazon Connect is blocked org-wide by SCP p-qocf1ngi (ADR-0004), so Twilio provides
   * telephony, queueing (TaskRouter) and the agent voice endpoint (Voice JS SDK). Bedrock
   * still does all reasoning, so caller data never reaches a third-party model.
   *
   * The auth token is a secret: it is read from the environment only, never logged, and
   * never sent to the browser. The browser receives short-lived Access Tokens instead.
   */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  /** E.164 number callers dial. */
  TWILIO_PHONE_NUMBER: z.string().optional(),
  /** TaskRouter workspace that owns the queues and workers. */
  TWILIO_WORKSPACE_SID: z.string().optional(),
  /** Workflow that routes escalated tasks to the right department queue. */
  TWILIO_WORKFLOW_SID: z.string().optional(),
  /** TwiML App backing the browser softphone. */
  TWILIO_TWIML_APP_SID: z.string().optional(),
  /** API key pair used to mint browser Access Tokens without exposing the auth token. */
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  /** Public base URL Twilio calls back on, e.g. an ngrok tunnel in development. */
  PUBLIC_BASE_URL: z.string().optional(),

  /** Storage backend selection: 'dynamodb' | 'memory'. */
  UCC_PERSISTENCE: z.enum(['dynamodb', 'memory']).default('memory'),
  /**
   * Which voice pipeline carries the AI leg.
   *
   *   'conversationrelay'  Twilio does STT and TTS; UCC runs Bedrock Converse per turn.
   *                        Managed, stateless per turn, ~2-3s per exchange.
   *   'pipecat'            An external Pipecat service runs Amazon Nova Sonic
   *                        speech-to-speech over Twilio Media Streams. ~433ms measured,
   *                        model-level barge-in, but a long-lived stateful stream.
   *
   * Both paths execute tools through the SAME UCC gate, so the security boundary does not
   * move with the model.
   */
  UCC_VOICE: z.enum(['conversationrelay', 'pipecat']).default('conversationrelay'),
  /** Public wss URL of the Pipecat service. Required when UCC_VOICE=pipecat. */
  PIPECAT_WS_URL: z.string().optional(),

  /**
   * Shared credential proving that a caller of the voice bridge IS the voice pipeline.
   *
   * The bridge executes privileged tools, so it must not be reachable by anything that can
   * simply reach the API. This proves the service; a per-call session token proves the
   * stream is entitled to the case it names. Both are required (ADR-0008).
   *
   * Required when UCC_VOICE=pipecat, and validated at startup rather than on the first
   * tool call of the first real caller.
   */
  UCC_VOICE_SERVICE_TOKEN: z.string().optional(),

  /**
   * Who owns queueing and agent selection.
   *
   *   'ucc'        UCC decides the department AND the agent, then asks the provider to
   *                connect that specific person. One source of truth for agent state.
   *   'taskrouter' Twilio TaskRouter owns the queue and picks the worker; UCC supplies
   *                only the department.
   *
   * The POC defaults to 'ucc'. Running both at once caused a real defect: UCC assigned an
   * agent and reported AGENT_CONNECTED while TaskRouter had no worker registered, so the
   * supervisor dashboard showed a connection that did not exist and the caller was never
   * transferred. Agent state must have exactly one owner.
   */
  UCC_ROUTING: z.enum(['ucc', 'taskrouter']).default('ucc'),

  /** Telephony backend selection: 'twilio' | 'connect' | 'simulated'. */
  UCC_TELEPHONY: z.enum(['twilio', 'connect', 'simulated']).default('simulated'),
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
