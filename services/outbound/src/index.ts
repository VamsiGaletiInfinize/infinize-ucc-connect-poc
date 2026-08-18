import { notFound, type OutboundCampaign, type UccCall, type UccTicket } from '@ucc/types';
import { logger, newId, nowIso } from '@ucc/shared';
import type { Repositories } from '@ucc/services/store';
import type { CallService } from '@ucc/services/calls';
import type { TicketService } from '@ucc/services/ticketing';
import type { AiOrchestrator } from '@ucc/services/ai';

export interface CampaignRunResult {
  campaign: OutboundCampaign;
  contacts: { call: UccCall; ticket: UccTicket; opening: string }[];
}

/**
 * Outbound campaigns.
 *
 * Every outbound contact is a case exactly like an inbound one — same UccCall, same
 * UccTicket, same timeline (constitution Principle II). The demo campaign is an
 * application deadline reminder targeting applicants with outstanding documents.
 */
export class OutboundService {
  constructor(
    private readonly repos: Repositories,
    private readonly calls: CallService,
    private readonly tickets: TicketService,
    private readonly ai: AiOrchestrator,
  ) {}

  async createDeadlineReminderCampaign(tenantId: string): Promise<OutboundCampaign> {
    const department = await this.repos.department.byCode(tenantId, 'ADMISSIONS');
    if (!department) throw notFound('Department', 'ADMISSIONS');

    // Target applicants whose applications still have outstanding documents. The target
    // list comes from the system of record, not from a hand-written list.
    const applications = await this.repos.application.list(tenantId);
    const pending = applications.filter(
      (a) =>
        a.status === 'DOCUMENTS_PENDING' ||
        a.documents.some((d) => d.status === 'PENDING'),
    );

    const callers = await this.repos.caller.list(tenantId);
    const targets = callers.filter((c) =>
      pending.some((a) => a.studentId === c.studentId),
    );

    const campaign: OutboundCampaign = {
      id: newId('cmp'),
      tenantId,
      name: 'Application Deadline Reminder — Autumn 2026',
      description:
        'Reminds applicants with outstanding documents that the document submission deadline is 25 August 2026.',
      category: 'DEADLINE_REMINDER',
      departmentId: department.id,
      status: 'DRAFT',
      targetCallerIds: targets.map((c) => c.id),
      callIds: [],
      createdAt: nowIso(),
    };

    await this.repos.campaign.put(campaign);
    logger.info('Outbound campaign created', {
      tenantId,
      campaignId: campaign.id,
      targets: targets.length,
    });
    return campaign;
  }

  /** Dial every target. Each contact opens its own UccCall and UccTicket. */
  async runCampaign(tenantId: string, campaignId: string): Promise<CampaignRunResult> {
    const campaign = await this.repos.campaign.get(tenantId, campaignId);
    if (!campaign) throw notFound('Campaign', campaignId);

    const running: OutboundCampaign = {
      ...campaign,
      status: 'RUNNING',
      startedAt: nowIso(),
    };
    await this.repos.campaign.put(running);

    const contacts: CampaignRunResult['contacts'] = [];

    for (const callerId of campaign.targetCallerIds) {
      const caller = await this.repos.caller.get(tenantId, callerId);
      if (!caller) continue;

      const { call, ticket } = await this.calls.startOutbound({
        tenantId,
        callerId,
        destinationPhoneNumber: caller.phone,
        category: campaign.category,
        departmentId: campaign.departmentId,
      });

      // Capture the updated ticket: the caller of this method must see the campaign's
      // classification and priority, not the defaults the call opened with.
      const enriched = await this.tickets.update(tenantId, ticket.id, {
        category: campaign.category,
        priority: 'HIGH',
        intent: 'DEADLINE_REMINDER',
        summary: `Outbound reminder: document submission deadline for ${caller.firstName} ${caller.lastName}.`,
      });

      const opening = await this.ai.greet(call, enriched);
      contacts.push({ call, ticket: enriched, opening });
    }

    const completed: OutboundCampaign = {
      ...running,
      status: 'COMPLETED',
      completedAt: nowIso(),
      callIds: contacts.map((c) => c.call.id),
    };
    await this.repos.campaign.put(completed);

    logger.info('Outbound campaign completed', {
      tenantId,
      campaignId,
      contacts: contacts.length,
    });

    return { campaign: completed, contacts };
  }

  list(tenantId: string) {
    return this.repos.campaign.list(tenantId);
  }

  get(tenantId: string, campaignId: string) {
    return this.repos.campaign.get(tenantId, campaignId);
  }
}
