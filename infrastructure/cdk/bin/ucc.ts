#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { UccStack } from '../lib/ucc-stack.ts';

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
