import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { buildContainer, type Container } from '../apps/ucc-api/src/bootstrap/container.ts';
import { MemoryDocumentStore } from '@ucc/services/store';
import { SimulatedConnectProvider } from '@ucc/services/telephony';
import { AiOrchestrator } from '@ucc/services/ai';
import { resetConfig } from '@ucc/config';

export const PHONE = {
  prospect: '+919812340001',
  applicantTwoApps: '+919812340002',
  student: '+919812340003',
  parent: '+919812340004',
  applicantPendingDocs: '+919812340005',
  unknown: '+919800000000',
};

export const TENANT = 'infinize-university';
export const OTHER_TENANT = 'northgate-institute';

/**
 * Scripted Bedrock stub.
 *
 * Tests must assert on OUR logic, not on a language model's word choice. The stub returns
 * a deterministic sequence of Converse responses — including tool-use blocks — so the
 * orchestrator's control flow, the tool executor and the authorization gate are all
 * exercised for real while the model itself is held constant.
 */
export interface ScriptStep {
  /** Tool the model should request on this step. */
  tool?: { name: string; input?: Record<string, unknown> };
  /** Text the model should reply with. */
  text?: string;
}

export class ScriptedBedrockClient {
  private index = 0;
  readonly calls: unknown[] = [];

  constructor(private readonly script: ScriptStep[]) {}

  async send(command: any): Promise<any> {
    this.calls.push(command?.input);
    const step = this.script[this.index] ?? { text: 'No further scripted response.' };
    this.index += 1;

    const content: any[] = [];
    if (step.tool) {
      content.push({
        toolUse: {
          toolUseId: `tool-${this.index}`,
          name: step.tool.name,
          input: step.tool.input ?? {},
        },
      });
    }
    if (step.text) content.push({ text: step.text });

    return { output: { message: { role: 'assistant', content } } };
  }

  reset(script?: ScriptStep[]): void {
    this.index = 0;
    if (script) (this as any).script = script;
  }
}

export interface TestHarness extends Container {
  simulated: SimulatedConnectProvider;
  bedrock: ScriptedBedrockClient;
  /** Replace the scripted model responses for the next turn(s). */
  script(steps: ScriptStep[]): void;
}

/**
 * Build a fully-wired container for tests: in-memory store, simulated telephony,
 * lexical retrieval (no network), scripted Bedrock.
 */
export async function createHarness(script: ScriptStep[] = []): Promise<TestHarness> {
  process.env.UCC_PERSISTENCE = 'memory';
  process.env.UCC_TELEPHONY = 'simulated';
  process.env.UCC_RETRIEVAL = 'lexical';
  process.env.LOG_LEVEL = 'error';
  resetConfig();

  const simulated = new SimulatedConnectProvider();
  const container = await buildContainer({
    store: new MemoryDocumentStore(),
    telephony: simulated,
    skipKnowledgeInit: false,
  });

  const bedrock = new ScriptedBedrockClient(script);

  // Swap in the scripted client. The orchestrator is otherwise the production one.
  const ai = new AiOrchestrator(
    {
      repos: container.repos,
      knowledge: container.knowledge,
      identity: container.identity,
      verification: container.verification,
      applications: container.applications,
      routing: container.routing,
      events: container.events,
      tickets: container.tickets,
      transcripts: container.transcripts,
    },
    bedrock as unknown as BedrockRuntimeClient,
  );

  return Object.assign(container, {
    ai,
    simulated,
    bedrock,
    script: (steps: ScriptStep[]) => bedrock.reset(steps),
  });
}

/** Start an inbound contact and return the call, ticket and harness. */
export async function startCall(h: TestHarness, phone: string, contactId = `contact-${Math.random()}`) {
  return h.calls.startInbound({
    tenantId: h.tenantId,
    providerContactId: contactId,
    callerPhoneNumber: phone,
  });
}

/** Drive a contact all the way to verified, without going through the model. */
export async function verifyCall(h: TestHarness, callId: string, ticketId: string, callerId: string) {
  const challenge = await h.verification.requestVerification({
    tenantId: h.tenantId,
    uccCallId: callId,
    uccTicketId: ticketId,
    callerId,
    destination: '+919812340002',
    traceId: 'test-trace',
  });
  return h.verification.verify({
    tenantId: h.tenantId,
    uccCallId: callId,
    uccTicketId: ticketId,
    sessionId: challenge.sessionId,
    code: '123456',
    traceId: 'test-trace',
  });
}
