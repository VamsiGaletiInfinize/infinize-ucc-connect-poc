import { UccError, type CallSecurityContext, type TicketCategory } from '@ucc/types';
import { logger } from '@ucc/shared';
import type { ApplicationService } from '@ucc/services/applications';
import type { IdentityService } from '@ucc/services/identity';
import type { KnowledgeService } from '@ucc/services/knowledge';
import type { VerificationService } from '@ucc/services/verification';
import type { RoutingService } from '@ucc/services/routing';
import type { EventService } from '@ucc/services/events';
import type { Repositories } from '@ucc/services/store';

/** Bedrock Converse tool specification. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { json: Record<string, unknown> };
}

export interface ToolResult {
  ok: boolean;
  /** Returned to the model verbatim. Must never contain data the caller may not receive. */
  data: unknown;
  /** Set when the tool wants the orchestrator to take a control-flow action. */
  control?: 'ESCALATED' | 'CALLBACK_CREATED' | 'VERIFICATION_PENDING';
}

/**
 * Tool catalogue exposed to Bedrock.
 *
 * Descriptions tell the model what a tool does and when to reach for it. They are NOT the
 * security boundary — every protected tool re-checks authorization server-side, so a model
 * that ignores these instructions still cannot obtain protected data.
 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'search_public_knowledge',
    description:
      'Search Infinize University public information: admissions, programmes, application process, required documents, deadlines, fees, scholarships, financial aid, hostel, campus, student services and contact details. Use this for any general question that is not specific to one person.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The question to look up.' },
        },
        required: ['query'],
      },
    },
  },
  {
    name: 'get_caller_profile',
    description:
      'Return what is known about the current caller from the number they are calling from, including their name, caller type and whether their identity has been verified on this call. Contains no protected record data.',
    inputSchema: { json: { type: 'object', properties: {} } },
  },
  {
    name: 'request_identity_verification',
    description:
      'Start identity verification by sending a one-time passcode to the number registered on the caller record. Call this before attempting to access any application, fee or admission record.',
    inputSchema: { json: { type: 'object', properties: {} } },
  },
  {
    name: 'verify_identity',
    description:
      'Submit the one-time passcode the caller has read out. Returns whether verification succeeded.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The passcode the caller provided.' },
        },
        required: ['code'],
      },
    },
  },
  {
    name: 'get_applications',
    description:
      'List the applications on file for the verified caller. Returns application id, programme, term and status only. Use this when the caller has more than one application so you can ask which one they mean.',
    inputSchema: { json: { type: 'object', properties: {} } },
  },
  {
    name: 'get_application_status',
    description:
      'Get the full status of one application, including documents received or outstanding, decision date, outstanding fee and scholarship status. Requires a verified caller. If the caller has more than one application you MUST pass application_id — never guess which one they mean.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          application_id: {
            type: 'string',
            description: 'Application number such as APP-2026-001. Omit only if the caller has exactly one application.',
          },
        },
      },
    },
  },
  {
    name: 'request_human_agent',
    description:
      'Escalate the call to a human agent. Use when the caller asks for a person, when the request is outside what you can resolve, or when a system needed to answer is unavailable.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the call is being escalated.' },
          category: {
            type: 'string',
            enum: [
              'ADMISSIONS_SUPPORT',
              'APPLICATION_STATUS',
              'DOCUMENT_SUBMISSION',
              'FEES_AND_PAYMENTS',
              'SCHOLARSHIP',
              'FINANCIAL_AID',
              'HOSTEL_AND_CAMPUS',
              'TECHNICAL_SUPPORT',
              'GENERAL_ENQUIRY',
              'DEADLINE_REMINDER',
            ],
            description: 'Business category, used to select the department.',
          },
          summary: { type: 'string', description: 'Short summary of the caller’s need for the agent.' },
        },
        required: ['reason', 'category'],
      },
    },
  },
  {
    name: 'create_callback',
    description:
      'Queue a callback for the caller instead of waiting on hold. Use when no agent is available or the caller prefers a call back.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Business category for department selection.' },
          reason: { type: 'string' },
        },
        required: ['category'],
      },
    },
  },
];

export interface ToolDependencies {
  repos: Repositories;
  knowledge: KnowledgeService;
  identity: IdentityService;
  verification: VerificationService;
  applications: ApplicationService;
  routing: RoutingService;
  events: EventService;
}

/**
 * Server-side tool executor.
 *
 * SECURITY: `ctx` is rebuilt from persisted state before every tool call by the
 * orchestrator. Tools read verification and ownership from `ctx` and from the repositories
 * — never from model-supplied arguments. A model that asserts "the caller is verified"
 * changes nothing here.
 */
export class ToolExecutor {
  constructor(private readonly deps: ToolDependencies) {}

  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx: CallSecurityContext,
  ): Promise<ToolResult> {
    logger.info('AI tool invoked', {
      traceId: ctx.traceId,
      tenantId: ctx.tenantId,
      uccCallId: ctx.uccCallId,
      uccTicketId: ctx.uccTicketId,
      tool: name,
      verified: ctx.verified,
    });

    try {
      const result = await this.dispatch(name, input, ctx);
      logger.info('AI tool completed', {
        traceId: ctx.traceId,
        uccCallId: ctx.uccCallId,
        tool: name,
        ok: result.ok,
      });
      return result;
    } catch (error) {
      if (error instanceof UccError) {
        logger.warn('AI tool denied or failed', {
          traceId: ctx.traceId,
          uccCallId: ctx.uccCallId,
          tool: name,
          code: error.code,
        });
        // The model is told WHAT it may not do and why, but never receives the data.
        return {
          ok: false,
          data: {
            error: error.code,
            message: error.message,
            ...(error.details ?? {}),
          },
        };
      }
      logger.error('AI tool threw', {
        traceId: ctx.traceId,
        uccCallId: ctx.uccCallId,
        tool: name,
        error: String(error),
      });
      return {
        ok: false,
        data: {
          error: 'UPSTREAM_UNAVAILABLE',
          message: 'That system is temporarily unavailable. Escalate to a human agent.',
        },
      };
    }
  }

  private async dispatch(
    name: string,
    input: Record<string, unknown>,
    ctx: CallSecurityContext,
  ): Promise<ToolResult> {
    switch (name) {
      case 'search_public_knowledge':
        return this.searchKnowledge(String(input.query ?? ''), ctx);
      case 'get_caller_profile':
        return this.callerProfile(ctx);
      case 'request_identity_verification':
        return this.requestVerification(ctx);
      case 'verify_identity':
        return this.verifyIdentity(String(input.code ?? ''), ctx);
      case 'get_applications':
        return this.getApplications(ctx);
      case 'get_application_status':
        return this.getApplicationStatus(
          input.application_id ? String(input.application_id) : undefined,
          ctx,
        );
      case 'request_human_agent':
        return this.escalate(input, ctx);
      case 'create_callback':
        return this.createCallback(input, ctx);
      default:
        return { ok: false, data: { error: 'UNKNOWN_TOOL', message: `No tool named ${name}` } };
    }
  }

  // --- public information -------------------------------------------------

  private async searchKnowledge(query: string, ctx: CallSecurityContext): Promise<ToolResult> {
    const hits = await this.deps.knowledge.search(query, 4);

    await this.deps.events.emit({
      tenantId: ctx.tenantId,
      uccCallId: ctx.uccCallId,
      uccTicketId: ctx.uccTicketId,
      type: 'KB_RETRIEVAL',
      actor: 'AI',
      traceId: ctx.traceId,
      discriminator: `kb:${query.slice(0, 40)}:${Date.now()}`,
      payload: { query, hits: hits.length, topScore: hits[0]?.score ?? 0 },
    });

    if (hits.length === 0) {
      return {
        ok: false,
        data: {
          error: 'NO_RESULTS',
          message:
            'Nothing relevant was found in the public knowledge base. Do not guess — escalate to a human agent.',
        },
      };
    }

    return {
      ok: true,
      data: {
        passages: hits.map((h) => ({
          title: h.title,
          category: h.category,
          content: h.content,
          source: h.sourceUri,
          relevance: Number(h.score.toFixed(3)),
        })),
      },
    };
  }

  // --- identity -----------------------------------------------------------

  private async callerProfile(ctx: CallSecurityContext): Promise<ToolResult> {
    if (!ctx.callerId) {
      return {
        ok: true,
        data: {
          identified: false,
          caller_type: 'UNKNOWN',
          verified: false,
          note: 'This number is not recognised. Only public information may be shared.',
        },
      };
    }
    const caller = await this.deps.identity.getCaller(ctx.tenantId, ctx.callerId);
    return {
      ok: true,
      data: {
        identified: true,
        first_name: caller?.firstName,
        caller_type: caller?.callerType,
        // Reported from persisted state, so the model always sees the truth.
        verified: ctx.verified,
      },
    };
  }

  private async requestVerification(ctx: CallSecurityContext): Promise<ToolResult> {
    if (!ctx.callerId) {
      return {
        ok: false,
        data: {
          error: 'UNKNOWN_CALLER',
          message:
            'This number is not linked to any record, so identity cannot be verified. Escalate to a human agent.',
        },
      };
    }
    if (ctx.verified) {
      return { ok: true, data: { already_verified: true } };
    }

    const caller = await this.deps.identity.getCaller(ctx.tenantId, ctx.callerId);
    const challenge = await this.deps.verification.requestVerification({
      tenantId: ctx.tenantId,
      uccCallId: ctx.uccCallId,
      uccTicketId: ctx.uccTicketId,
      callerId: ctx.callerId,
      destination: caller?.phone ?? '',
      traceId: ctx.traceId,
    });

    return {
      ok: true,
      control: 'VERIFICATION_PENDING',
      data: {
        sent: true,
        masked_destination: challenge.maskedDestination,
        expires_at: challenge.expiresAt,
        instruction:
          'Ask the caller to read out the six digit passcode, then call verify_identity with it.',
      },
    };
  }

  private async verifyIdentity(code: string, ctx: CallSecurityContext): Promise<ToolResult> {
    const session = await this.deps.verification.activeSession(ctx.tenantId, ctx.uccCallId);
    if (!session) {
      return {
        ok: false,
        data: {
          error: 'NO_ACTIVE_SESSION',
          message: 'No passcode has been issued. Call request_identity_verification first.',
        },
      };
    }

    const result = await this.deps.verification.verify({
      tenantId: ctx.tenantId,
      uccCallId: ctx.uccCallId,
      uccTicketId: ctx.uccTicketId,
      sessionId: session.id,
      code,
      traceId: ctx.traceId,
    });

    return { ok: result.verified, data: { verified: result.verified, message: result.reason } };
  }

  // --- protected records --------------------------------------------------

  private async getApplications(ctx: CallSecurityContext): Promise<ToolResult> {
    const applications = await this.deps.applications.listForContact(ctx);
    return {
      ok: true,
      data: {
        count: applications.length,
        applications,
        ...(applications.length > 1
          ? {
              instruction:
                'The caller has more than one application. Ask which one they mean before calling get_application_status. Do not choose for them.',
            }
          : {}),
      },
    };
  }

  private async getApplicationStatus(
    applicationId: string | undefined,
    ctx: CallSecurityContext,
  ): Promise<ToolResult> {
    const view = await this.deps.applications.getStatusForContact(ctx, applicationId);
    return { ok: true, data: view };
  }

  // --- escalation ---------------------------------------------------------

  private async escalate(
    input: Record<string, unknown>,
    ctx: CallSecurityContext,
  ): Promise<ToolResult> {
    const category = (String(input.category ?? 'GENERAL_ENQUIRY') as TicketCategory);
    const result = await this.deps.routing.escalate({
      tenantId: ctx.tenantId,
      uccCallId: ctx.uccCallId,
      uccTicketId: ctx.uccTicketId,
      category,
      reason: String(input.reason ?? 'Caller requested a human agent'),
      summary: input.summary ? String(input.summary) : undefined,
      traceId: ctx.traceId,
    });

    return {
      ok: true,
      control: 'ESCALATED',
      data: {
        department: result.department.name,
        queue: result.department.queueName,
        queue_position: result.queuePosition,
        agent_assigned: result.agent
          ? `${result.agent.firstName} ${result.agent.lastName}`
          : null,
        callback_recommended: result.callbackRecommended,
        message: result.agent
          ? `Connecting the caller to ${result.department.name}.`
          : `No ${result.department.name} agent is free. Offer a callback.`,
      },
    };
  }

  private async createCallback(
    input: Record<string, unknown>,
    ctx: CallSecurityContext,
  ): Promise<ToolResult> {
    if (!ctx.callerId) {
      return {
        ok: false,
        data: { error: 'UNKNOWN_CALLER', message: 'A callback needs a recognised caller record.' },
      };
    }
    const caller = await this.deps.identity.getCaller(ctx.tenantId, ctx.callerId);
    const category = String(input.category ?? 'GENERAL_ENQUIRY') as TicketCategory;
    const department = await this.deps.routing.resolveDepartment(ctx.tenantId, category);

    const callback = await this.deps.routing.requestCallback({
      tenantId: ctx.tenantId,
      uccCallId: ctx.uccCallId,
      uccTicketId: ctx.uccTicketId,
      callerId: ctx.callerId,
      phone: caller?.phone ?? '',
      departmentId: department.id,
      traceId: ctx.traceId,
    });

    return {
      ok: true,
      control: 'CALLBACK_CREATED',
      data: {
        callback_id: callback.id,
        department: department.name,
        scheduled_for: callback.scheduledFor,
        message: 'A callback has been queued.',
      },
    };
  }
}
