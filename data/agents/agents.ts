import type { Agent } from '@ucc/types';
import { TENANT } from '../university/tenant.ts';

const ts = '2026-08-01T09:00:00.000Z';

/**
 * Contact centre agents.
 *
 * `routingProfileId` mirrors the Amazon Connect routing profile that determines which
 * queues an agent serves — UCC stores the mapping for business context but Connect
 * remains the routing authority (constitution Principle I).
 */
export const AGENTS: Agent[] = [
  {
    id: 'agent-aditya',
    tenantId: TENANT.id,
    firstName: 'Aditya',
    lastName: 'Sharma',
    email: 'aditya.sharma@infinize.edu',
    routingProfileId: 'rp-admissions',
    routingProfileName: 'Admissions Specialist',
    departmentIds: ['dept-admissions'],
    status: 'AVAILABLE',
    maxConcurrentContacts: 1,
    createdAt: ts,
    updatedAt: ts,
  },
  {
    id: 'agent-sarah',
    tenantId: TENANT.id,
    firstName: 'Sarah',
    lastName: 'Fernandes',
    email: 'sarah.fernandes@infinize.edu',
    routingProfileId: 'rp-admissions-general',
    routingProfileName: 'Admissions & General',
    departmentIds: ['dept-admissions', 'dept-general'],
    status: 'AVAILABLE',
    maxConcurrentContacts: 1,
    createdAt: ts,
    updatedAt: ts,
  },
  {
    id: 'agent-michael',
    tenantId: TENANT.id,
    firstName: 'Michael',
    lastName: "D'Souza",
    email: 'michael.dsouza@infinize.edu',
    routingProfileId: 'rp-financial-aid',
    routingProfileName: 'Financial Aid Counsellor',
    departmentIds: ['dept-financial-aid'],
    status: 'AVAILABLE',
    maxConcurrentContacts: 1,
    createdAt: ts,
    updatedAt: ts,
  },
  {
    id: 'agent-kavya',
    tenantId: TENANT.id,
    firstName: 'Kavya',
    lastName: 'Iyer',
    email: 'kavya.iyer@infinize.edu',
    routingProfileId: 'rp-technical-support',
    routingProfileName: 'Technical Support',
    departmentIds: ['dept-technical-support', 'dept-general'],
    status: 'AVAILABLE',
    maxConcurrentContacts: 2,
    createdAt: ts,
    updatedAt: ts,
  },
  {
    id: 'agent-john',
    tenantId: TENANT.id,
    firstName: 'John',
    lastName: 'Mathew',
    email: 'john.mathew@infinize.edu',
    routingProfileId: 'rp-general',
    routingProfileName: 'General Enquiries',
    departmentIds: ['dept-general', 'dept-admissions'],
    status: 'OFFLINE',
    maxConcurrentContacts: 1,
    createdAt: ts,
    updatedAt: ts,
  },
];
