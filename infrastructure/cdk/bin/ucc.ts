#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { UccStack } from '../lib/ucc-stack.ts';
import { ConnectStack } from '../lib/connect-stack.ts';

const app = new cdk.App();

new UccStack(app, 'InfinizeUccPocStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Infinize Unified Contact Center POC — Amazon Connect + Bedrock',
  // Supplied once an Amazon Connect instance exists; IAM grants scope to it.
  connectInstanceId: process.env.CONNECT_INSTANCE_ID,
  tags: {
    Project: 'infinize-ucc-connect-poc',
    Environment: 'poc',
    Owner: 'infinize-platform',
  },
});

/**
 * Amazon Connect, in its own stack so it can be deployed independently of the data plane —
 * and, if our CDK execution role is denied by SCP, handed to the platform team as a plain
 * CloudFormation template for the accelerator pipeline.
 */
new ConnectStack(app, 'InfinizeUccConnectStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Infinize UCC POC — Amazon Connect instance, queues and routing profiles',
  instanceAlias: process.env.CONNECT_INSTANCE_ALIAS,
  tags: {
    Project: 'infinize-ucc-connect-poc',
    Environment: 'poc',
    Owner: 'infinize-platform',
  },
});
