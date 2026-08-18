import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface UccStackProps extends cdk.StackProps {
  /** Amazon Connect instance id, when one exists. Grants are scoped to it. */
  connectInstanceId?: string;
}

/**
 * Infinize UCC POC infrastructure.
 *
 * Provisions only what the POC actually uses (constitution Principle VIII): one DynamoDB
 * table, one private bucket, scoped IAM, parameters and log groups. No service is added
 * merely because it appears on an architecture diagram.
 */
export class UccStack extends cdk.Stack {
  readonly table: dynamodb.Table;
  readonly bucket: s3.Bucket;
  readonly appRole: iam.Role;

  constructor(scope: Construct, id: string, props: UccStackProps = {}) {
    super(scope, id, props);

    // --- persistence ------------------------------------------------------

    /**
     * Single-table design.
     *   PK = TENANT#<tenantId>#COL#<collection>
     *   SK = <id>
     *
     * Tenant isolation is structural: the partition key contains the tenant, so a query
     * cannot cross a tenant boundary. GSI1 supports listing every record of one type
     * across a tenant for the operational dashboards.
     */
    this.table = new dynamodb.Table(this, 'UccTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // POC only. Production: RETAIN.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'collection', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- storage ----------------------------------------------------------

    /**
     * Private bucket for call recordings and the knowledge base vector index.
     * Recording binaries live here and never in DynamoDB (spec FR-015).
     */
    this.bucket = new s3.Bucket(this, 'UccArtifacts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          id: 'recording-retention',
          prefix: 'recordings/',
          expiration: cdk.Duration.days(90),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- secrets ----------------------------------------------------------

    /**
     * Salt for hashing verification codes.
     *
     * SCP CONSTRAINT: this organisation denies `secretsmanager:CreateSecret`
     * (SCP `p-44cydhdk`), so AWS Secrets Manager cannot be used here. The salt lives in an
     * SSM SecureString parameter created out of band — CloudFormation cannot create
     * SecureString parameters in any case, so this would be a two-step process regardless.
     *
     * `scripts/provision-salt.sh` creates it. The role below is granted read access only.
     *
     * Production note: Secrets Manager remains the better home for this (native rotation,
     * cross-region replication). Restore it if the SCP is relaxed.
     */
    const saltParameterName = '/ucc/poc/verification-salt';
    const saltParameterArn = cdk.Stack.of(this).formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: saltParameterName.replace(/^\//, ''),
    });

    /**
     * Resource names are published as stack outputs rather than SSM parameters.
     *
     * SCP CONSTRAINT: `ssm:DeleteParameter` is denied (SCP `p-jj9834lr`), so any
     * stack-managed SSM parameter would make the stack undeletable. Outputs carry the same
     * information without that trap.
     */

    // --- runtime role -----------------------------------------------------

    /**
     * Least-privilege application role.
     *
     * Explicitly NOT AdministratorAccess. Each grant below is the narrowest that the
     * corresponding module actually needs.
     */
    this.appRole = new iam.Role(this, 'UccAppRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      ),
      description: 'Runtime role for the Infinize UCC API',
    });

    this.table.grantReadWriteData(this.appRole);
    this.bucket.grantReadWrite(this.appRole);

    // Read-only access to the out-of-band verification salt parameter.
    this.appRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadVerificationSalt',
        actions: ['ssm:GetParameter'],
        resources: [saltParameterArn],
      }),
    );

    // Bedrock: inference on the specific models used, nothing else.
    this.appRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInference',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-*`,
        ],
      }),
    );

    // Amazon Connect: scoped to one instance when it exists.
    if (props.connectInstanceId) {
      this.appRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ConnectContactOperations',
          actions: [
            'connect:StartOutboundVoiceContact',
            'connect:StartTaskContact',
            'connect:StopContact',
            'connect:UpdateContactAttributes',
            'connect:DescribeContact',
            'connect:GetContactAttributes',
          ],
          resources: [
            `arn:aws:connect:${this.region}:${this.account}:instance/${props.connectInstanceId}/*`,
          ],
        }),
      );
    }

    this.appRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Observability',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'cloudwatch:PutMetricData'],
        resources: ['*'],
      }),
    );

    /**
     * No explicit log group is provisioned.
     *
     * SCP CONSTRAINT: the CDK CloudFormation execution role is denied `logs:CreateLogGroup`
     * (SCP `p-44cydhdk`), though the interactive developer role is not. Lambda and ECS
     * create their own log groups on first write, so an explicit one buys only a retention
     * setting. Retention is set out of band by `scripts/set-log-retention.sh`.
     */

    // --- outputs ----------------------------------------------------------

    new cdk.CfnOutput(this, 'UccTableName', { value: this.table.tableName });
    new cdk.CfnOutput(this, 'UccBucketName', { value: this.bucket.bucketName });
    new cdk.CfnOutput(this, 'UccAppRoleArn', { value: this.appRole.roleArn });
    new cdk.CfnOutput(this, 'VerificationSaltParameter', { value: saltParameterName });
  }
}
