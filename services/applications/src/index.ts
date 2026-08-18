import {
  UccError,
  ambiguous,
  notAuthorized,
  upstreamUnavailable,
  verificationRequired,
  type Application,
  type CallSecurityContext,
} from '@ucc/types';
import { logger } from '@ucc/shared';
import type { Repositories } from '@ucc/services/store';
import type { EventService } from '@ucc/services/events';
import type { IdentityService } from '@ucc/services/identity';

/** Public-safe projection of an application. Internal notes are never exposed. */
export interface ApplicationView {
  applicationId: string;
  program: string;
  programLevel: Application['programLevel'];
  term: string;
  status: Application['status'];
  submittedAt?: string;
  lastUpdatedAt: string;
  decisionDate?: string;
  documents: Application['documents'];
  outstandingFee?: number;
  scholarshipStatus?: Application['scholarshipStatus'];
}

/** Minimal projection used when the AI must ask which application the caller means. */
export interface ApplicationSummary {
  applicationId: string;
  program: string;
  term: string;
  status: Application['status'];
}

export const toView = (a: Application): ApplicationView => ({
  applicationId: a.applicationId,
  program: a.program,
  programLevel: a.programLevel,
  term: a.term,
  status: a.status,
  submittedAt: a.submittedAt,
  lastUpdatedAt: a.lastUpdatedAt,
  decisionDate: a.decisionDate,
  documents: a.documents,
  outstandingFee: a.outstandingFee,
  scholarshipStatus: a.scholarshipStatus,
});

export const toSummary = (a: Application): ApplicationSummary => ({
  applicationId: a.applicationId,
  program: a.program,
  term: a.term,
  status: a.status,
});

/**
 * University application APIs — the authoritative source for transactional data.
 *
 * This service NEVER consults the knowledge base (constitution Principle IV). If the
 * upstream record store is unavailable it raises `UPSTREAM_UNAVAILABLE` so the caller
 * escalates to a human rather than answering from memory or inference.
 */
export class ApplicationService {
  /** Test/demo seam: forces the upstream to fail so the escalation path can be proven. */
  private failureMode = false;

  constructor(
    private readonly repos: Repositories,
    private readonly identity: IdentityService,
    private readonly events: EventService,
  ) {}

  /** Simulate a university API outage (demo scenario: API failure must escalate). */
  setFailureMode(enabled: boolean): void {
    this.failureMode = enabled;
    logger.warn('Application API failure mode changed', { enabled });
  }

  isFailing(): boolean {
    return this.failureMode;
  }

  private assertUpstreamHealthy(): void {
    if (this.failureMode) throw upstreamUnavailable('The university application system');
  }

  /**
   * List the applications this contact is authorised to see.
   *
   * Requires verification. Returns summaries only — enough for the AI to ask which
   * application the caller means, without disclosing status detail prematurely.
   */
  async listForContact(ctx: CallSecurityContext): Promise<ApplicationSummary[]> {
    this.assertUpstreamHealthy();

    if (!ctx.callerId) {
      throw verificationRequired(
        'We could not identify you from this number. Identity verification is required.',
      );
    }
    if (!ctx.verified) {
      throw verificationRequired(
        'Identity verification is required before application details can be shared.',
      );
    }

    const studentIds = await this.identity.accessibleStudentIds(ctx);
    if (studentIds.length === 0) return [];

    const results: Application[] = [];
    for (const studentId of studentIds) {
      results.push(...(await this.repos.application.byStudent(ctx.tenantId, studentId)));
    }

    await this.events.emit({
      tenantId: ctx.tenantId,
      uccCallId: ctx.uccCallId,
      uccTicketId: ctx.uccTicketId,
      type: 'APPLICATION_LOOKUP',
      actor: 'AI',
      traceId: ctx.traceId,
      discriminator: `list:${Date.now()}`,
      payload: { count: results.length },
    });

    return results.map(toSummary);
  }

  /**
   * Fetch one application's status.
   *
   * `applicationId` is OPTIONAL. When the caller holds more than one application and has
   * not specified which, this raises `AMBIGUOUS_RESOURCE` carrying the choices — the AI
   * must ask, and must never pick on the caller's behalf (spec SC-4).
   */
  async getStatusForContact(
    ctx: CallSecurityContext,
    applicationId?: string,
  ): Promise<ApplicationView> {
    this.assertUpstreamHealthy();

    if (!ctx.verified) {
      throw verificationRequired(
        'Identity verification is required before application details can be shared.',
      );
    }

    const accessible = await this.accessibleApplications(ctx);

    if (accessible.length === 0) {
      throw new UccError(
        'NOT_FOUND',
        'No application records were found for you at this institution.',
        404,
      );
    }

    let target: Application | undefined;

    if (applicationId) {
      // Resolve strictly within the set this contact is authorised to see. An id the
      // caller does not own is reported as not-authorised, never fetched and filtered.
      target = accessible.find(
        (a) => a.applicationId.toUpperCase() === applicationId.trim().toUpperCase(),
      );
      if (!target) {
        // Re-run the full gate so the denial is explicit and audited.
        const candidate = await this.repos.application.byApplicationId(
          ctx.tenantId,
          applicationId.trim().toUpperCase(),
        );
        if (candidate) {
          const decision = await this.identity.authorizeApplicationAccess(ctx, candidate);
          logger.warn('Application access denied', {
            traceId: ctx.traceId,
            tenantId: ctx.tenantId,
            uccCallId: ctx.uccCallId,
            code: decision.code,
          });
          throw notAuthorized(decision.reason);
        }
        throw new UccError('NOT_FOUND', `Application ${applicationId} was not found.`, 404);
      }
    } else if (accessible.length > 1) {
      throw ambiguous(
        'More than one application is on file. Ask the caller which one they mean.',
        accessible.map(toSummary),
      );
    } else {
      target = accessible[0];
    }

    const decision = await this.identity.authorizeApplicationAccess(ctx, target!);
    if (decision.effect === 'DENY') {
      logger.warn('Application access denied at final gate', {
        traceId: ctx.traceId,
        tenantId: ctx.tenantId,
        uccCallId: ctx.uccCallId,
        code: decision.code,
      });
      throw notAuthorized(decision.reason);
    }

    await this.events.emit({
      tenantId: ctx.tenantId,
      uccCallId: ctx.uccCallId,
      uccTicketId: ctx.uccTicketId,
      type: 'APPLICATION_STATUS_RETURNED',
      actor: 'AI',
      traceId: ctx.traceId,
      discriminator: `${target!.applicationId}:${Date.now()}`,
      payload: { applicationId: target!.applicationId, status: target!.status },
    });

    return toView(target!);
  }

  /** Applications this contact passes the authorization gate for. */
  private async accessibleApplications(ctx: CallSecurityContext): Promise<Application[]> {
    const studentIds = await this.identity.accessibleStudentIds(ctx);
    const out: Application[] = [];
    for (const studentId of studentIds) {
      for (const app of await this.repos.application.byStudent(ctx.tenantId, studentId)) {
        const decision = await this.identity.authorizeApplicationAccess(ctx, app);
        if (decision.effect === 'ALLOW') out.push(app);
      }
    }
    return out;
  }

  /** Unfiltered read for administrative/demo surfaces. Not reachable from AI tools. */
  listAll(tenantId: string) {
    return this.repos.application.list(tenantId);
  }
}
