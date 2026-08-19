import { config } from '@ucc/config';
import { logger, resetTicketCounter } from '@ucc/shared';
import { createRepositories, MemoryDocumentStore, Repositories } from '@ucc/services/store';
import { EventService } from '@ucc/services/events';
import { TicketService } from '@ucc/services/ticketing';
import { CallSessionTokenService, VerificationService } from '@ucc/services/verification';
import { IdentityService } from '@ucc/services/identity';
import { ApplicationService } from '@ucc/services/applications';
import { KnowledgeService } from '@ucc/services/knowledge';
import { CallService } from '@ucc/services/calls';
import { RoutingService } from '@ucc/services/routing';
import { AgentService } from '@ucc/services/agents';
import { RecordingService, TranscriptService } from '@ucc/services/recording';
import { RealtimeHub } from '@ucc/services/realtime';
import { OutboundService } from '@ucc/services/outbound';
import { AiOrchestrator } from '@ucc/services/ai';
import {
  createTelephonyProvider,
  type TelephonyProvider,
} from '@ucc/services/telephony';
import type { DocumentStore } from '@ucc/services/store';
import { seedTenant } from './seed.ts';

/**
 * Composition root.
 *
 * Modules are wired explicitly here rather than resolved through a framework, so the
 * dependency direction is visible: nothing below `IdentityService` can bypass the
 * authorization gate, because nothing below it holds a reference to the repositories that
 * would let it.
 */
export interface Container {
  repos: Repositories;
  events: EventService;
  tickets: TicketService;
  verification: VerificationService;
  sessionTokens: CallSessionTokenService;
  identity: IdentityService;
  applications: ApplicationService;
  knowledge: KnowledgeService;
  calls: CallService;
  routing: RoutingService;
  agents: AgentService;
  recordings: RecordingService;
  transcripts: TranscriptService;
  realtime: RealtimeHub;
  outbound: OutboundService;
  ai: AiOrchestrator;
  telephony: TelephonyProvider;
  tenantId: string;
}

export interface BuildOptions {
  store?: DocumentStore;
  telephony?: TelephonyProvider;
  /** Skip Bedrock embedding at startup (tests). */
  skipKnowledgeInit?: boolean;
  seed?: boolean;
}

export async function buildContainer(options: BuildOptions = {}): Promise<Container> {
  const cfg = config();
  const store = options.store ?? undefined;
  const repos = createRepositories(store);

  const events = new EventService(repos);
  const tickets = new TicketService(repos, events);
  const verification = new VerificationService(repos, events);
  const sessionTokens = new CallSessionTokenService(repos);
  const identity = new IdentityService(repos, verification);
  const applications = new ApplicationService(repos, identity, events);
  const knowledge = new KnowledgeService(cfg.DEFAULT_TENANT_ID);
  const telephony = options.telephony ?? createTelephonyProvider();
  const calls = new CallService(repos, events, tickets, identity, telephony);
  const routing = new RoutingService(repos, events, tickets, calls, telephony);
  const agents = new AgentService(repos, events, tickets, calls);
  const recordings = new RecordingService(repos, events);
  const transcripts = new TranscriptService(repos, events);
  const realtime = new RealtimeHub(events);

  const ai = new AiOrchestrator({
    repos,
    knowledge,
    identity,
    verification,
    applications,
    routing,
    events,
    tickets,
    transcripts,
  });

  const outbound = new OutboundService(repos, calls, tickets, ai);

  realtime.start();

  if (options.seed !== false) {
    resetTicketCounter();
    await seedTenant(repos);
  }

  if (!options.skipKnowledgeInit) {
    await knowledge.initialize();
  }

  logger.info('UCC container ready', {
    persistence: cfg.UCC_PERSISTENCE,
    telephony: telephony.name,
    telephonyLive: telephony.isLive(),
    retrieval: knowledge.isLexicalFallback() ? 'lexical' : 'bedrock-embeddings',
    model: cfg.BEDROCK_MODEL_ID,
  });

  return {
    repos,
    events,
    tickets,
    verification,
    sessionTokens,
    identity,
    applications,
    knowledge,
    calls,
    routing,
    agents,
    recordings,
    transcripts,
    realtime,
    outbound,
    ai,
    telephony,
    tenantId: cfg.DEFAULT_TENANT_ID,
  };
}

/** Convenience for tests: in-memory store, simulated telephony, no embedding calls. */
export async function buildTestContainer(
  overrides: BuildOptions = {},
): Promise<Container> {
  return buildContainer({
    store: new MemoryDocumentStore(),
    skipKnowledgeInit: true,
    ...overrides,
  });
}
