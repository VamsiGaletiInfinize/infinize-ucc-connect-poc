import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import { config } from '@ucc/config';
import { logger, newTraceId } from '@ucc/shared';
import { UccError, InvalidTicketTransitionError } from '@ucc/types';
import { ZodError } from 'zod';
import type { Container } from './bootstrap/container.ts';
import { registerCallRoutes } from './routes/calls.ts';
import { registerTicketRoutes } from './routes/tickets.ts';
import { registerApplicationRoutes } from './routes/applications.ts';
import { registerOperationRoutes } from './routes/operations.ts';
import { registerTwilioRoutes } from './routes/twilio.ts';
import { registerAgentVoiceRoutes } from './routes/agent-voice.ts';

export async function createServer(c: Container): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  // Twilio posts webhooks as application/x-www-form-urlencoded, and ConversationRelay
  // needs a websocket. Both are registered before routes so the decorators exist.
  await app.register(formbody);
  await app.register(websocket);

  await app.register(cors, {
    origin: config().corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Correlation id on every request, echoed to the client for cross-system tracing.
  app.addHook('onRequest', async (request, reply) => {
    const traceId = (request.headers['x-trace-id'] as string) || newTraceId();
    (request as { traceId?: string }).traceId = traceId;
    reply.header('x-trace-id', traceId);
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info('http', {
      traceId: (request as { traceId?: string }).traceId,
      method: request.method,
      path: request.url,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });

  /**
   * Central error mapping.
   *
   * Denials return the typed code so tests and the UI can assert on it, and the message is
   * always caller-safe — it says what is required, never whether the protected resource
   * exists.
   */
  app.setErrorHandler((error, request, reply) => {
    const traceId = (request as { traceId?: string }).traceId;

    if (error instanceof UccError) {
      return reply
        .code(error.status)
        .send({ error: error.code, message: error.message, details: error.details, traceId });
    }
    if (error instanceof InvalidTicketTransitionError) {
      return reply
        .code(409)
        .send({ error: error.code, message: error.message, traceId });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION_FAILED',
        message: 'Request body failed validation',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        traceId,
      });
    }

    logger.error('Unhandled API error', {
      traceId,
      path: request.url,
      error: String(error),
    });
    return reply
      .code(500)
      .send({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred', traceId });
  });

  app.get('/health', async () => ({
    status: 'ok',
    tenantId: c.tenantId,
    telephony: c.telephony.name,
    telephonyLive: c.telephony.isLive(),
    knowledgeChunks: c.knowledge.size(),
    retrieval: c.knowledge.isLexicalFallback() ? 'LEXICAL_FALLBACK' : 'BEDROCK_EMBEDDINGS',
    model: config().BEDROCK_MODEL_ID,
    persistence: config().UCC_PERSISTENCE,
  }));

  /** Realtime stream: live call, agent, queue and ticket changes. */
  app.get('/api/realtime', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': config().corsOrigins[0] ?? '*',
    });

    const send = (message: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(message)}\n\n`);
    };

    const unsubscribe = c.realtime.subscribe(send);
    const heartbeat = setInterval(
      () => send({ type: 'HEARTBEAT', at: new Date().toISOString() }),
      15_000,
    );

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    // Keep the handler open for the lifetime of the connection.
    await new Promise<void>((resolve) => request.raw.on('close', resolve));
  });

  registerCallRoutes(app, c);
  registerTicketRoutes(app, c);
  registerApplicationRoutes(app, c);
  registerOperationRoutes(app, c);
  registerTwilioRoutes(app, c);
  registerAgentVoiceRoutes(app, c);

  return app;
}
