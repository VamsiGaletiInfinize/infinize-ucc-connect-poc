import type { Caller } from '@ucc/types';
import { OTHER_TENANT, TENANT } from '../university/tenant.ts';

const ts = '2026-07-15T10:00:00.000Z';

/**
 * Demo callers, resolved from ANI (calling number) at contact start.
 *
 * Every phone number is fictional and reserved for the demo.
 */
export const CALLERS: Caller[] = [
  {
    // Enquiring about programmes; has no application and no protected data.
    id: 'caller-ananya',
    tenantId: TENANT.id,
    firstName: 'Ananya',
    lastName: 'Raghunathan',
    callerType: 'PROSPECT',
    phone: '+919812340001',
    email: 'ananya.raghunathan@example.com',
    createdAt: ts,
    updatedAt: ts,
  },
  {
    // The key demo caller: holds TWO active applications, so the AI must disambiguate.
    id: 'caller-rohan',
    tenantId: TENANT.id,
    firstName: 'Rohan',
    lastName: 'Mehta',
    callerType: 'APPLICANT',
    phone: '+919812340002',
    email: 'rohan.mehta@example.com',
    studentId: 'STU1001',
    dateOfBirth: '2001-04-18',
    createdAt: ts,
    updatedAt: ts,
  },
  {
    // Enrolled student with fee and hostel context.
    id: 'caller-priya',
    tenantId: TENANT.id,
    firstName: 'Priya',
    lastName: 'Venkatesan',
    callerType: 'STUDENT',
    phone: '+919812340003',
    email: 'priya.venkatesan@infinize.edu',
    studentId: 'STU0987',
    dateOfBirth: '2003-11-02',
    createdAt: ts,
    updatedAt: ts,
  },
  {
    // Parent of STU1001. Authorisation for a third party is still enforced server-side.
    id: 'caller-sunita',
    tenantId: TENANT.id,
    firstName: 'Sunita',
    lastName: 'Mehta',
    callerType: 'PARENT',
    phone: '+919812340004',
    email: 'sunita.mehta@example.com',
    relatedStudentIds: ['STU1001'],
    createdAt: ts,
    updatedAt: ts,
  },
  {
    // Applicant with a documents-pending application, targeted by the outbound campaign.
    id: 'caller-imran',
    tenantId: TENANT.id,
    firstName: 'Imran',
    lastName: 'Qureshi',
    callerType: 'APPLICANT',
    phone: '+919812340005',
    email: 'imran.qureshi@example.com',
    studentId: 'STU1042',
    dateOfBirth: '2002-02-09',
    createdAt: ts,
    updatedAt: ts,
  },
];

/**
 * A caller belonging to a DIFFERENT tenant, used to prove tenant isolation.
 * Their student id deliberately collides with nothing in Infinize University.
 */
export const CROSS_TENANT_CALLER: Caller = {
  id: 'caller-northgate-vikram',
  tenantId: OTHER_TENANT.id,
  firstName: 'Vikram',
  lastName: 'Nair',
  callerType: 'APPLICANT',
  phone: '+919812349999',
  email: 'vikram.nair@example.com',
  studentId: 'NG5501',
  createdAt: ts,
  updatedAt: ts,
};

export const ALL_CALLERS: Caller[] = [...CALLERS, CROSS_TENANT_CALLER];
