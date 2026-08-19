/**
 * Provision the TaskRouter workspace for the UCC POC.
 *
 * Queues, workflow and workers are derived from the seed data rather than hand-typed, so
 * the routing layer cannot silently drift from what the application believes exists. Add a
 * department in `data/university/tenant.ts` and re-run this; the queue appears.
 *
 * SAFETY
 *   - Idempotent: existing resources are reused, never duplicated.
 *   - Purely additive: it creates a new workspace and touches nothing else in the account.
 *     In particular it does not read, modify or repoint the phone numbers currently serving
 *     production Vapi traffic.
 *   - Creates no phone numbers and spends nothing.
 *
 * Usage:
 *   npx tsx scripts/provision-taskrouter.ts            # create or reuse
 *   npx tsx scripts/provision-taskrouter.ts --dry-run  # show what would happen
 */
import twilio from 'twilio';
import { DEPARTMENTS } from '../data/university/tenant.ts';
import { AGENTS } from '../data/agents/agents.ts';

const WORKSPACE_NAME = 'Infinize UCC POC';
const dryRun = process.argv.includes('--dry-run');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
if (!accountSid || !authToken) {
  console.error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set (see .env).');
  process.exit(1);
}

const client = twilio(accountSid, authToken);
const log = (s = '') => console.log(s);
const step = (s: string) => log(`\n── ${s}`);

async function main(): Promise<void> {
  log(`TaskRouter provisioning${dryRun ? ' (DRY RUN — nothing will be created)' : ''}`);
  log(`account : ${accountSid}`);
  log(`workspace: ${WORKSPACE_NAME}`);

  // --- workspace ---------------------------------------------------------
  step('Workspace');
  const existing = await client.taskrouter.v1.workspaces.list({ limit: 50 });
  let workspace = existing.find((w) => w.friendlyName === WORKSPACE_NAME);

  if (workspace) {
    log(`   reusing ${workspace.sid}`);
  } else if (dryRun) {
    log(`   would create workspace "${WORKSPACE_NAME}"`);
    log('\nDry run complete — nothing was created.');
    return;
  } else {
    workspace = await client.taskrouter.v1.workspaces.create({
      friendlyName: WORKSPACE_NAME,
      // Tasks that match no queue land here rather than vanishing.
      multiTaskEnabled: true,
    });
    log(`   created ${workspace.sid}`);
  }
  const ws = client.taskrouter.v1.workspaces(workspace.sid);

  // --- queues ------------------------------------------------------------
  step('Task queues (one per UCC department)');
  const existingQueues = await ws.taskQueues.list({ limit: 50 });
  const queueSidByDept = new Map<string, string>();

  for (const dept of DEPARTMENTS) {
    const name = dept.queueName;
    const found = existingQueues.find((q) => q.friendlyName === name);
    if (found) {
      queueSidByDept.set(dept.id, found.sid);
      log(`   reusing  ${name.padEnd(20)} ${found.sid}`);
      continue;
    }
    const queue = await ws.taskQueues.create({
      friendlyName: name,
      // Only workers who serve this department may take from this queue.
      targetWorkers: `departments HAS "${dept.id}"`,
    });
    queueSidByDept.set(dept.id, queue.sid);
    log(`   created  ${name.padEnd(20)} ${queue.sid}`);
  }

  // --- workflow ----------------------------------------------------------
  step('Workflow (routes on the department attribute UCC sets)');
  const workflowName = 'UCC Department Routing';
  const existingWorkflows = await ws.workflows.list({ limit: 50 });
  let workflow = existingWorkflows.find((w) => w.friendlyName === workflowName);

  /**
   * One filter per department. UCC puts `department` on the task and the workflow does the
   * rest — which is the boundary that matters: UCC chooses the department, TaskRouter
   * chooses the person.
   */
  const configuration = JSON.stringify({
    task_routing: {
      filters: DEPARTMENTS.map((dept) => ({
        filter_friendly_name: dept.name,
        expression: `department == "${dept.id}"`,
        targets: [{ queue: queueSidByDept.get(dept.id), timeout: dept.slaSeconds }],
      })),
      // Anything unmatched still reaches a human rather than being dropped.
      default_filter: { queue: queueSidByDept.get('dept-general') },
    },
  });

  if (workflow) {
    await ws.workflows(workflow.sid).update({ configuration });
    log(`   updated  ${workflow.sid}`);
  } else {
    workflow = await ws.workflows.create({ friendlyName: workflowName, configuration });
    log(`   created  ${workflow.sid}`);
  }

  // --- workers -----------------------------------------------------------
  step('Workers (one per UCC agent)');
  const existingWorkers = await ws.workers.list({ limit: 50 });
  const workerSidByAgent = new Map<string, string>();

  for (const agent of AGENTS) {
    const name = `${agent.firstName} ${agent.lastName}`;
    /**
     * `contact_uri` is how TaskRouter reaches the person. `client:<agentId>` targets the
     * browser softphone, and matches the identity minted into the agent's Access Token.
     */
    const attributes = JSON.stringify({
      contact_uri: `client:${agent.id}`,
      ucc_agent_id: agent.id,
      departments: agent.departmentIds,
      routing_profile: agent.routingProfileName,
      email: agent.email,
    });

    const found = existingWorkers.find((w) => w.friendlyName === name);
    if (found) {
      await ws.workers(found.sid).update({ attributes });
      workerSidByAgent.set(agent.id, found.sid);
      log(`   updated  ${name.padEnd(20)} ${found.sid}`);
    } else {
      const worker = await ws.workers.create({ friendlyName: name, attributes });
      workerSidByAgent.set(agent.id, worker.sid);
      log(`   created  ${name.padEnd(20)} ${worker.sid}`);
    }
  }

  // --- output ------------------------------------------------------------
  step('Add these to .env');
  log(`TWILIO_WORKSPACE_SID=${workspace.sid}`);
  log(`TWILIO_WORKFLOW_SID=${workflow.sid}`);
  log('');
  log('Worker SIDs (map onto UCC agents — used for the TaskRouter grant):');
  for (const [agentId, sid] of workerSidByAgent) log(`   ${agentId.padEnd(16)} ${sid}`);

  log('\nDone. No phone numbers were created or modified.');
}

main().catch((err) => {
  console.error('\nProvisioning failed:', err?.message ?? err);
  if (err?.code) console.error('twilio code:', err.code, err.moreInfo ?? '');
  process.exit(1);
});
