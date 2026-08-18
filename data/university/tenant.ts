import type { Department, Tenant } from '@ucc/types';

/**
 * Infinize University — the fictional demo tenant.
 *
 * No real university data is used anywhere in this repository.
 */
export const TENANT: Tenant = {
  id: 'infinize-university',
  name: 'Infinize University',
  shortName: 'Infinize',
  timezone: 'Asia/Kolkata',
  supportEmail: 'admissions@infinize.edu',
  supportPhone: '+918041002000',
  metadata: {
    established: '1998',
    campus: 'Whitefield, Bengaluru',
    accreditation: 'NAAC A++',
    academicYear: '2026-27',
    admissionsPortal: 'https://apply.infinize.edu',
    officeHours: 'Monday to Friday, 09:00-17:30 IST',
  },
};

/** A second tenant used exclusively to prove cross-tenant isolation in tests. */
export const OTHER_TENANT: Tenant = {
  id: 'northgate-institute',
  name: 'Northgate Institute of Technology',
  shortName: 'Northgate',
  timezone: 'Asia/Kolkata',
  supportEmail: 'help@northgate.edu',
  supportPhone: '+918041009000',
  metadata: { established: '2005', campus: 'Pune' },
};

export const DEPARTMENTS: Department[] = [
  {
    id: 'dept-admissions',
    tenantId: TENANT.id,
    code: 'ADMISSIONS',
    name: 'Admissions',
    description:
      'Applications, eligibility, entrance requirements, document verification, offers and enrolment.',
    queueId: 'queue-admissions',
    queueName: 'Admissions',
    slaSeconds: 60,
  },
  {
    id: 'dept-financial-aid',
    tenantId: TENANT.id,
    code: 'FINANCIAL_AID',
    name: 'Financial Aid',
    description:
      'Scholarships, education loans, fee waivers, instalment plans and financial hardship support.',
    queueId: 'queue-financial-aid',
    queueName: 'Financial Aid',
    slaSeconds: 90,
  },
  {
    id: 'dept-technical-support',
    tenantId: TENANT.id,
    code: 'TECHNICAL_SUPPORT',
    name: 'Technical Support',
    description:
      'Applicant portal access, password resets, document upload failures and payment gateway issues.',
    queueId: 'queue-technical-support',
    queueName: 'Technical Support',
    slaSeconds: 120,
  },
  {
    id: 'dept-general',
    tenantId: TENANT.id,
    code: 'GENERAL',
    name: 'General',
    description:
      'Campus information, hostel, transport, general enquiries and routing to the right team.',
    queueId: 'queue-general',
    queueName: 'General Enquiries',
    slaSeconds: 180,
  },
];

export const DEPARTMENT_BY_CODE = Object.fromEntries(
  DEPARTMENTS.map((d) => [d.code, d]),
) as Record<Department['code'], Department>;
