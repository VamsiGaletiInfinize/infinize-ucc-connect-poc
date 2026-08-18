import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as connect from 'aws-cdk-lib/aws-connect';

/**
 * Amazon Connect contact centre, provisioned through CloudFormation.
 *
 * WHY THIS STACK EXISTS
 * ---------------------
 * Creating a Connect instance by hand fails: Amazon Connect asks IAM to create its
 * service-linked role on the caller's behalf, and SCP `p-qocf1ngi` explicitly denies
 * `iam:CreateServiceLinkedRole` for our principal. An explicit SCP deny cannot be granted
 * around — adding `iam:CreateRole` to the permission set addressed the identity-based half
 * and the SCP still refused.
 *
 * This organisation is built on Landing Zone Accelerator, where IAM roles are expected to be
 * created by CloudFormation under an approved execution role rather than by a human. So the
 * question is not "can this principal create the role" but "is the CloudFormation execution
 * role exempt from the SCP".
 *
 * That is what deploying this stack tests. Two possible outcomes, both useful:
 *
 *   SUCCEEDS — the SCP exempts the CFN execution role. The instance exists and everything
 *              below it (queues, routing profiles, agents) comes up with it.
 *   FAILS    — capture the exact CloudFormation error. If it again names `p-qocf1ngi` and
 *              `iam:CreateServiceLinkedRole`, the SCP denies every principal including
 *              CloudFormation, and only an Organizations administrator can move it.
 *
 * NOTE ON THE EXECUTION ROLE
 * --------------------------
 * A previous deploy of the sibling data-plane stack failed because SCP `p-44cydhdk` denies
 * the *CDK bootstrap* execution role (`cdk-hnb659fds-cfn-exec-role-*`). That role is not
 * necessarily the one the accelerator blesses. If `cdk deploy` is denied, hand
 * `connect-stack.template.json` (see `npm run cdk:synth:connect`) to the platform team to
 * deploy through the accelerator pipeline under its own execution role.
 *
 * EMAIL IS DELIBERATELY NOT ENABLED
 * ---------------------------------
 * The console wizard fails on `AmazonConnectEmailSESAccessRole` because it provisions the
 * email channel. This POC needs voice only, so that role is never required.
 */
export interface ConnectStackProps extends cdk.StackProps {
  /** Must be globally unique across all AWS accounts. */
  readonly instanceAlias?: string;
}

export class ConnectStack extends cdk.Stack {
  readonly instance: connect.CfnInstance;

  constructor(scope: Construct, id: string, props: ConnectStackProps = {}) {
    super(scope, id, props);

    const alias = props.instanceAlias ?? 'infinize-ucc-poc';

    // --- instance ---------------------------------------------------------

    this.instance = new connect.CfnInstance(this, 'UccInstance', {
      identityManagementType: 'CONNECT_MANAGED',
      instanceAlias: alias,
      attributes: {
        inboundCalls: true,
        outboundCalls: true,
        contactflowLogs: true,
        // Contact Lens, auto-resolve and early media are off: not needed for the POC and
        // each one widens the permission surface the SCP has to allow.
        contactLens: false,
        autoResolveBestVoices: false,
        useCustomTtsVoices: false,
      },
    });

    const instanceArn = this.instance.attrArn;

    // --- hours of operation ----------------------------------------------

    /** 24/7, so a demo is never blocked by the clock. Production would use real hours. */
    const hours = new connect.CfnHoursOfOperation(this, 'AlwaysOpen', {
      instanceArn,
      name: 'Infinize 24x7',
      description: 'Always open — POC demo hours',
      timeZone: 'Asia/Kolkata',
      config: (['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const).map(
        (day) => ({
          day,
          startTime: { hours: 0, minutes: 0 },
          endTime: { hours: 23, minutes: 59 },
        }),
      ),
    });

    // --- queues -----------------------------------------------------------

    /**
     * One queue per department, mirroring `data/university/tenant.ts`. The names must match
     * what UCC's routing service resolves, because UCC decides the department and Amazon
     * Connect owns the queue that department maps to.
     */
    const departments = [
      { key: 'Admissions', name: 'Admissions', description: 'Admissions enquiries and application support' },
      { key: 'FinancialAid', name: 'Financial Aid', description: 'Fees, scholarships and financial aid' },
      { key: 'TechnicalSupport', name: 'Technical Support', description: 'Applicant portal and technical issues' },
      { key: 'General', name: 'General Enquiries', description: 'General university enquiries' },
    ];

    const queues = new Map<string, connect.CfnQueue>();
    for (const d of departments) {
      // Referencing hours.attrHoursOfOperationArn gives CloudFormation the ordering
      // implicitly; no explicit dependency needed.
      const queue = new connect.CfnQueue(this, `Queue${d.key}`, {
        instanceArn,
        name: d.name,
        description: d.description,
        hoursOfOperationArn: hours.attrHoursOfOperationArn,
      });
      queues.set(d.key, queue);
    }

    // --- routing profiles -------------------------------------------------

    /**
     * Routing profiles mirror `data/agents/agents.ts`. Amazon Connect — not UCC — decides
     * which agent within a queue takes the contact; UCC only chooses the department.
     */
    const profiles = [
      { key: 'Admissions', name: 'Admissions Specialist', queues: ['Admissions'] },
      { key: 'AdmissionsGeneral', name: 'Admissions & General', queues: ['Admissions', 'General'] },
      { key: 'FinancialAid', name: 'Financial Aid Counsellor', queues: ['FinancialAid'] },
      { key: 'TechnicalSupport', name: 'Technical Support', queues: ['TechnicalSupport', 'General'] },
      { key: 'General', name: 'General Enquiries', queues: ['General', 'Admissions'] },
    ];

    for (const p of profiles) {
      new connect.CfnRoutingProfile(this, `Rp${p.key}`, {
        instanceArn,
        name: p.name,
        description: `${p.name} routing profile`,
        defaultOutboundQueueArn: queues.get(p.queues[0]!)!.attrQueueArn,
        mediaConcurrencies: [{ channel: 'VOICE', concurrency: 1 }],
        queueConfigs: p.queues.map((q, i) => ({
          queueReference: { channel: 'VOICE', queueArn: queues.get(q)!.attrQueueArn },
          priority: i + 1,
          delay: 0,
        })),
      });
    }

    // --- outputs ----------------------------------------------------------

    new cdk.CfnOutput(this, 'ConnectInstanceId', {
      value: this.instance.attrId,
      description: 'Set as CONNECT_INSTANCE_ID for the UCC API',
    });
    new cdk.CfnOutput(this, 'ConnectInstanceArn', { value: instanceArn });
    new cdk.CfnOutput(this, 'ConnectAccessUrl', {
      value: `https://${alias}.my.connect.aws/`,
      description: 'Amazon Connect admin console for contact flows and the agent CCP',
    });
  }
}
