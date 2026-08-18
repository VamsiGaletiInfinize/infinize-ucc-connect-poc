import type { Application } from '@ucc/types';
import { OTHER_TENANT, TENANT } from '../university/tenant.ts';

/**
 * Protected transactional records — the university system of record.
 *
 * This data is served ONLY through the application APIs behind the authorization gate.
 * It is deliberately absent from the knowledge base corpus so that RAG can never be the
 * source of an application answer (constitution Principle IV).
 */
export const APPLICATIONS: Application[] = [
  {
    // Rohan Mehta, application 1 of 2 — the AI must not pick this one on its own.
    id: 'app-2026-001',
    tenantId: TENANT.id,
    applicationId: 'APP-2026-001',
    studentId: 'STU1001',
    program: 'M.Tech Computer Science',
    programLevel: 'POSTGRADUATE',
    term: 'Autumn 2026',
    status: 'UNDER_REVIEW',
    submittedAt: '2026-06-12T08:30:00.000Z',
    lastUpdatedAt: '2026-08-05T11:20:00.000Z',
    documents: [
      { name: 'Bachelor degree certificate', status: 'RECEIVED', receivedAt: '2026-06-12T08:30:00.000Z' },
      { name: 'Consolidated marksheet', status: 'RECEIVED', receivedAt: '2026-06-12T08:31:00.000Z' },
      { name: 'GATE scorecard', status: 'RECEIVED', receivedAt: '2026-06-14T06:10:00.000Z' },
      { name: 'Statement of purpose', status: 'RECEIVED', receivedAt: '2026-06-14T06:12:00.000Z' },
    ],
    scholarshipApplied: true,
    scholarshipStatus: 'UNDER_REVIEW',
    notes: 'Shortlisted for departmental review. Committee meets 22 August 2026.',
  },
  {
    // Rohan Mehta, application 2 of 2 — different programme, different outcome.
    id: 'app-2026-002',
    tenantId: TENANT.id,
    applicationId: 'APP-2026-002',
    studentId: 'STU1001',
    program: 'MBA (Business Analytics)',
    programLevel: 'POSTGRADUATE',
    term: 'Autumn 2026',
    status: 'ADMITTED',
    submittedAt: '2026-06-20T09:05:00.000Z',
    lastUpdatedAt: '2026-08-01T07:45:00.000Z',
    decisionDate: '2026-08-01T07:45:00.000Z',
    documents: [
      { name: 'Bachelor degree certificate', status: 'RECEIVED', receivedAt: '2026-06-20T09:05:00.000Z' },
      { name: 'CAT scorecard', status: 'RECEIVED', receivedAt: '2026-06-20T09:06:00.000Z' },
      { name: 'Work experience letter', status: 'RECEIVED', receivedAt: '2026-06-22T10:00:00.000Z' },
    ],
    outstandingFee: 185_000,
    scholarshipApplied: false,
    scholarshipStatus: 'NOT_APPLIED',
    notes: 'Offer issued. Seat acceptance fee due by 30 August 2026.',
  },
  {
    // Imran Qureshi — documents pending; the outbound reminder campaign targets this.
    id: 'app-2026-014',
    tenantId: TENANT.id,
    applicationId: 'APP-2026-014',
    studentId: 'STU1042',
    program: 'B.Tech Electronics and Communication',
    programLevel: 'UNDERGRADUATE',
    term: 'Autumn 2026',
    status: 'DOCUMENTS_PENDING',
    submittedAt: '2026-07-02T05:15:00.000Z',
    lastUpdatedAt: '2026-08-10T04:00:00.000Z',
    documents: [
      { name: 'Class XII marksheet', status: 'RECEIVED', receivedAt: '2026-07-02T05:15:00.000Z' },
      {
        name: 'Transfer certificate',
        status: 'PENDING',
        note: 'Not yet uploaded to the applicant portal.',
      },
      {
        name: 'Category certificate',
        status: 'PENDING',
        note: 'Required to confirm fee category.',
      },
    ],
    scholarshipApplied: true,
    scholarshipStatus: 'UNDER_REVIEW',
    notes: 'Document deadline 25 August 2026. Application will lapse if not completed.',
  },
  {
    // Priya Venkatesan — enrolled student, prior application retained for history.
    id: 'app-2025-311',
    tenantId: TENANT.id,
    applicationId: 'APP-2025-311',
    studentId: 'STU0987',
    program: 'B.Sc Data Science',
    programLevel: 'UNDERGRADUATE',
    term: 'Autumn 2025',
    status: 'ADMITTED',
    submittedAt: '2025-05-18T06:00:00.000Z',
    lastUpdatedAt: '2025-07-01T06:00:00.000Z',
    decisionDate: '2025-07-01T06:00:00.000Z',
    documents: [
      { name: 'Class XII marksheet', status: 'RECEIVED', receivedAt: '2025-05-18T06:00:00.000Z' },
      { name: 'Transfer certificate', status: 'RECEIVED', receivedAt: '2025-05-20T06:00:00.000Z' },
    ],
    outstandingFee: 42_500,
    scholarshipApplied: true,
    scholarshipStatus: 'AWARDED',
    notes: 'Merit scholarship awarded at 25% of tuition. Semester 3 fee outstanding.',
  },
];

/** Belongs to another tenant — must never be reachable from an Infinize University call. */
export const CROSS_TENANT_APPLICATION: Application = {
  id: 'app-ng-9001',
  tenantId: OTHER_TENANT.id,
  applicationId: 'APP-NG-9001',
  studentId: 'NG5501',
  program: 'M.Tech Mechanical Engineering',
  programLevel: 'POSTGRADUATE',
  term: 'Autumn 2026',
  status: 'ADMITTED',
  lastUpdatedAt: '2026-08-01T00:00:00.000Z',
  documents: [],
  scholarshipApplied: false,
};

export const ALL_APPLICATIONS: Application[] = [...APPLICATIONS, CROSS_TENANT_APPLICATION];
