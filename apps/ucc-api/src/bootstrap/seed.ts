import { logger } from '@ucc/shared';
import type { Repositories } from '@ucc/services/store';
import { DEPARTMENTS, OTHER_TENANT, TENANT } from '../../../../data/university/tenant.ts';
import { AGENTS } from '../../../../data/agents/agents.ts';
import { ALL_CALLERS } from '../../../../data/callers/callers.ts';
import { ALL_APPLICATIONS } from '../../../../data/applications/applications.ts';

/**
 * Load the Infinize University demo tenant.
 *
 * A second tenant (Northgate Institute) and one of its applicants are seeded deliberately
 * so tenant isolation is proven against real data rather than asserted.
 */
export async function seedTenant(repos: Repositories): Promise<void> {
  await repos.tenant.put(TENANT);
  await repos.tenant.put(OTHER_TENANT);

  for (const department of DEPARTMENTS) await repos.department.put(department);
  for (const agent of AGENTS) await repos.agent.put(agent);
  for (const caller of ALL_CALLERS) await repos.caller.put(caller);
  for (const application of ALL_APPLICATIONS) await repos.application.put(application);

  logger.info('Demo tenant seeded', {
    tenantId: TENANT.id,
    departments: DEPARTMENTS.length,
    agents: AGENTS.length,
    callers: ALL_CALLERS.length,
    applications: ALL_APPLICATIONS.length,
  });
}

export { TENANT, OTHER_TENANT, DEPARTMENTS, AGENTS };
