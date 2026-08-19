import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from '@ucc/config';
import { logger } from '@ucc/shared';
import type { TicketCategory, UccCall, UccTicket } from '@ucc/types';
import type { IdentityService } from '@ucc/services/identity';
import type { TicketService } from '@ucc/services/ticketing';
import type { EventService } from '@ucc/services/events';
import type { TranscriptService } from '@ucc/services/recording';
import { TOOL_SPECS, ToolExecutor, type ToolDependencies, type ToolResult } from './tools.ts';
import { buildSystemPrompt } from './prompt.ts';
import { classifyIntent } from './intent.ts';

export * from './tools.ts';
export * from './prompt.ts';
export * from './intent.ts';

export interface TurnResult {
  /** What the AI says back to the caller. */
  reply: string;
  /** Tool calls made during this turn, for the timeline and the demo UI. */
  toolsUsed: string[];
  escalated: boolean;
  callbackCreated: boolean;
  ticket: UccTicket;
}

interface StoredConversation {
  messages: Message[];
  greeted: boolean;
}

const MAX_TOOL_ITERATIONS = 6;

/**
 * AI orchestrator.
 *
 * Runs the Bedrock Converse tool-use loop. Two rules govern everything here:
 *
 *  1. The security context is REBUILT from persisted state before every tool call, so the
 *     conversation cannot talk its way into a protected record.
 *  2. When a required system is unavailable, the orchestrator escalates rather than
 *     answering — it never fabricates transactional data (constitution Principle IV).
 */
export class AiOrchestrator {
  private readonly client: BedrockRuntimeClient;
  private readonly tools: ToolExecutor;

  constructor(
    private readonly deps: ToolDependencies & {
      identity: IdentityService;
      tickets: TicketService;
      events: EventService;
      transcripts: TranscriptService;
    },
    client?: BedrockRuntimeClient,
  ) {
    this.client = client ?? new BedrockRuntimeClient({ region: config().AWS_REGION });
    this.tools = new ToolExecutor(deps);
  }

  /** Opening line for a new contact. */
  async greet(call: UccCall, ticket: UccTicket): Promise<string> {
    const caller = call.callerRefId
      ? await this.deps.identity.getCaller(call.tenantId, call.callerRefId)
      : null;

    const reply = caller
      ? `Thank you for calling Infinize University. Am I speaking with ${caller.firstName}? How can I help you today?`
      : 'Thank you for calling Infinize University. How can I help you today?';

    await this.deps.events.emit({
      tenantId: call.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      type: 'AI_GREETING',
      actor: 'AI',
      traceId: call.traceId,
      discriminator: `${call.id}:greeting`,
      payload: { identified: Boolean(caller) },
    });

    await this.deps.transcripts.append({
      call,
      uccTicketId: ticket.id,
      speaker: 'AI',
      kind: 'AI_CONVERSATION',
      content: reply,
    });

    await this.deps.repos.conversation.put(call.tenantId, call.id, {
      messages: [],
      greeted: true,
    } satisfies StoredConversation);

    return reply;
  }

  /**
   * Process one caller utterance.
   *
   * Returns the AI reply plus what happened, so the UI and the timeline both reflect the
   * real sequence of tool calls rather than a narrated summary.
   */
  async handleTurn(params: {
    call: UccCall;
    ticket: UccTicket;
    utterance: string;
  }): Promise<TurnResult> {
    const { call, utterance } = params;
    let ticket = params.ticket;

    await this.deps.transcripts.append({
      call,
      uccTicketId: ticket.id,
      speaker: 'CALLER',
      kind: 'AI_CONVERSATION',
      content: utterance,
    });

    // Classify intent for business routing. This is UCC's judgement, recorded on the case.
    const intent = classifyIntent(utterance);
    if (intent && ticket.intent !== intent.intent) {
      ticket = await this.deps.tickets.update(call.tenantId, ticket.id, {
        intent: intent.intent,
        category: intent.category,
      });
      await this.deps.events.emit({
        tenantId: call.tenantId,
        uccCallId: call.id,
        uccTicketId: ticket.id,
        type: 'INTENT_IDENTIFIED',
        actor: 'AI',
        traceId: call.traceId,
        discriminator: `${ticket.id}:${intent.intent}`,
        payload: { intent: intent.intent, category: intent.category },
      });
    }

    const stored =
      (await this.deps.repos.conversation.get<StoredConversation>(call.tenantId, call.id)) ?? {
        messages: [],
        greeted: false,
      };

    const messages: Message[] = [
      ...stored.messages,
      { role: 'user', content: [{ text: utterance }] },
    ];

    const toolsUsed: string[] = [];
    let escalated = false;
    let callbackCreated = false;
    let reply = '';

    const caller = call.callerRefId
      ? await this.deps.identity.getCaller(call.tenantId, call.callerRefId)
      : null;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      // Rebuild the security context every iteration: verification may have just changed.
      const ctx = await this.deps.identity.buildSecurityContext(call, ticket.id);

      let response;
      try {
        response = await this.client.send(
          new ConverseCommand({
            modelId: config().BEDROCK_MODEL_ID,
            system: [
              {
                text: buildSystemPrompt({
                  callerFirstName: caller?.firstName,
                  callerType: ctx.callerType,
                  identified: Boolean(ctx.callerId),
                  verified: ctx.verified,
                  direction: call.direction,
                }),
              },
            ],
            messages,
            toolConfig: {
              tools: TOOL_SPECS.map((spec) => ({ toolSpec: spec }) as Tool),
            },
            inferenceConfig: { maxTokens: 1024, temperature: 0.2 },
          }),
        );
      } catch (error) {
        // AI unavailable: fall back to a human rather than dropping the caller.
        logger.error('Bedrock invocation failed; escalating', {
          traceId: call.traceId,
          uccCallId: call.id,
          error: String(error),
        });
        return this.escalateOnFailure(call, ticket, 'The AI assistant is unavailable.');
      }

      const content = response.output?.message?.content ?? [];
      messages.push({ role: 'assistant', content });

      const toolUses = content.filter((block) => 'toolUse' in block && block.toolUse);
      const text = content
        .filter((block): block is ContentBlock.TextMember => 'text' in block)
        .map((block) => block.text)
        .join('\n')
        .trim();

      if (toolUses.length === 0) {
        reply = text;
        break;
      }

      const toolResults: ContentBlock[] = [];
      for (const block of toolUses) {
        const use = (block as { toolUse: { name?: string; toolUseId?: string; input?: unknown } })
          .toolUse;
        const name = use.name ?? 'unknown';
        toolsUsed.push(name);

        const result = await this.tools.execute(
          name,
          (use.input as Record<string, unknown>) ?? {},
          ctx,
        );

        if (result.control === 'ESCALATED') escalated = true;
        if (result.control === 'CALLBACK_CREATED') callbackCreated = true;

        toolResults.push({
          toolResult: {
            toolUseId: use.toolUseId!,
            content: [{ json: result.data as Record<string, unknown> }],
            status: result.ok ? 'success' : 'error',
          },
        } as ContentBlock);
      }

      messages.push({ role: 'user', content: toolResults });

      // Reload the ticket: a tool may have transitioned it (escalation, callback).
      ticket = await this.deps.tickets.get(call.tenantId, ticket.id);

      if (text) reply = text;
    }

    if (!reply) {
      reply =
        'Let me connect you with a colleague who can help with that.';
    }

    await this.deps.repos.conversation.put(call.tenantId, call.id, {
      messages,
      greeted: true,
    } satisfies StoredConversation);

    await this.deps.transcripts.append({
      call,
      uccTicketId: ticket.id,
      speaker: 'AI',
      kind: 'AI_CONVERSATION',
      content: reply,
    });

    await this.deps.events.emit({
      tenantId: call.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      type: 'AI_RESPONSE',
      actor: 'AI',
      traceId: call.traceId,
      discriminator: `${ticket.id}:reply:${Date.now()}`,
      payload: { toolsUsed, escalated, characters: reply.length },
    });

    // Keep verification status on the case in step with reality.
    const finalCtx = await this.deps.identity.buildSecurityContext(call, ticket.id);
    if (finalCtx.verified && ticket.verificationStatus !== 'VERIFIED') {
      await this.deps.tickets.setVerificationStatus(call.tenantId, ticket.id, 'VERIFIED');
      ticket = await this.deps.tickets.get(call.tenantId, ticket.id);
    }

    return { reply, toolsUsed, escalated, callbackCreated, ticket };
  }

  /** Mark the case AI-resolved when the caller's need was met without a human. */
  async resolveByAi(
    call: UccCall,
    ticket: UccTicket,
    summary: string,
  ): Promise<UccTicket> {
    if (ticket.status !== 'AI_HANDLING') return ticket;
    return this.deps.tickets.transition(call.tenantId, ticket.id, 'AI_RESOLVED', {
      actor: 'AI',
      reason: 'Resolved without human involvement',
      summary,
      resolution: summary,
    });
  }

  /**
   * Execute one tool on behalf of an EXTERNAL voice pipeline (Pipecat + Nova Sonic).
   *
   * When speech-to-speech runs outside this process, the model lives in Pipecat but
   * authorization must not. This is the single door back in: the security context is
   * rebuilt from PERSISTED state here, exactly as it is for the Converse path, so a
   * caller who has not verified is refused no matter which model asked (ADR-0002).
   *
   * Pipecat therefore holds no tool logic, no schemas of its own, and no ability to
   * decide what a caller may see. It transports audio and relays requests.
   */
  async executeToolForCall(params: {
    call: UccCall;
    ticket: UccTicket;
    name: string;
    input: Record<string, unknown>;
  }): Promise<{ result: ToolResult; ticket: UccTicket }> {
    const ctx = await this.deps.identity.buildSecurityContext(params.call, params.ticket.id);
    const result = await this.tools.execute(params.name, params.input, ctx);

    // A tool may have transitioned the ticket (escalation, callback), so return the
    // reloaded ticket rather than the caller's stale copy.
    const ticket = await this.deps.tickets.get(params.call.tenantId, params.ticket.id);
    return { result, ticket };
  }

  /** The tool catalogue, so an external pipeline uses one definition rather than a copy. */
  toolSpecs(): typeof TOOL_SPECS {
    return TOOL_SPECS;
  }

  /** Contact-flow fallback: escalate when the AI itself cannot run. */
  private async escalateOnFailure(
    call: UccCall,
    ticket: UccTicket,
    reason: string,
  ): Promise<TurnResult> {
    const category: TicketCategory = ticket.category ?? 'GENERAL_ENQUIRY';
    try {
      const result = await this.deps.routing.escalate({
        tenantId: call.tenantId,
        uccCallId: call.id,
        uccTicketId: ticket.id,
        category,
        reason,
        traceId: call.traceId,
      });
      return {
        reply:
          'I am having trouble reaching our systems. Let me pass you to a colleague who can help.',
        toolsUsed: [],
        escalated: true,
        callbackCreated: false,
        ticket: result.ticket,
      };
    } catch (error) {
      logger.error('Fallback escalation failed', {
        traceId: call.traceId,
        uccCallId: call.id,
        error: String(error),
      });
      return {
        reply: 'I am unable to continue right now. Please call back shortly.',
        toolsUsed: [],
        escalated: false,
        callbackCreated: false,
        ticket,
      };
    }
  }
}
