import type { TicketCategory } from '@ucc/types';

export interface IntentClassification {
  intent: string;
  category: TicketCategory;
}

/**
 * Business intent classification.
 *
 * Deliberately deterministic rather than model-driven: intent drives DEPARTMENT ROUTING,
 * which is a business rule UCC owns (constitution Principle I). A rule table is auditable,
 * costs nothing, and cannot drift between model versions. The model still decides what to
 * say; it does not decide which department a case belongs to.
 *
 * Production note: for a larger intent taxonomy this becomes a classifier with the same
 * interface, still owned by UCC and still auditable.
 */
const RULES: { intent: string; category: TicketCategory; patterns: RegExp[] }[] = [
  {
    intent: 'APPLICATION_STATUS',
    category: 'APPLICATION_STATUS',
    patterns: [
      /\b(application|admission)\b.*\b(status|update|progress|decision|result)\b/i,
      /\b(status|update|progress)\b.*\b(application|admission)\b/i,
      /\bhave i (got|been) (in|admitted|selected|accepted)\b/i,
      /\bwas i (admitted|selected|accepted|rejected)\b/i,
    ],
  },
  {
    intent: 'DOCUMENT_SUBMISSION',
    category: 'DOCUMENT_SUBMISSION',
    patterns: [
      /\b(document|certificate|marksheet|transcript)s?\b.*\b(need|required|submit|upload|pending|missing)\b/i,
      /\bwhat documents\b/i,
      /\b(upload|submit)\b.*\b(document|certificate)\b/i,
    ],
  },
  {
    intent: 'SCHOLARSHIP_ENQUIRY',
    category: 'SCHOLARSHIP',
    patterns: [/\bscholarship/i, /\bmerit award\b/i, /\bstipend\b/i],
  },
  {
    intent: 'FINANCIAL_AID_ENQUIRY',
    category: 'FINANCIAL_AID',
    patterns: [/\bfinancial aid\b/i, /\beducation loan\b/i, /\bfee waiver\b/i, /\bhardship\b/i],
  },
  {
    intent: 'FEES_ENQUIRY',
    category: 'FEES_AND_PAYMENTS',
    patterns: [
      /\b(fee|fees|tuition|payment|instal?ment|due)\b/i,
      /\bhow much (does|do|is|are)\b.*\bcost\b/i,
    ],
  },
  {
    intent: 'TECHNICAL_SUPPORT',
    category: 'TECHNICAL_SUPPORT',
    patterns: [
      /\b(portal|website|login|log in|sign in|password|otp not|reset)\b/i,
      /\b(upload|payment)\b.*\b(fail|error|not working|stuck)\b/i,
      /\bcan(no|')?t (log|sign) in\b/i,
    ],
  },
  {
    intent: 'HOSTEL_CAMPUS_ENQUIRY',
    category: 'HOSTEL_AND_CAMPUS',
    patterns: [/\bhostel\b/i, /\baccommodation\b/i, /\bcampus\b/i, /\bmess\b/i, /\btransport\b/i],
  },
  {
    intent: 'ADMISSIONS_SUPPORT',
    category: 'ADMISSIONS_SUPPORT',
    patterns: [
      /\b(admission|apply|application|eligibility|entrance|programme|program|course|deadline)\b/i,
      /\bspeak (to|with)\b.*\badmissions?\b/i,
    ],
  },
];

export function classifyIntent(utterance: string): IntentClassification | null {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(utterance))) {
      return { intent: rule.intent, category: rule.category };
    }
  }
  return null;
}

/** True when the caller is explicitly asking for a person. */
export function isHumanRequest(utterance: string): boolean {
  return /\b(speak|talk|connect|transfer|put me)\b.*\b(agent|human|person|someone|officer|advisor|representative|counsell?or)\b/i.test(
    utterance,
  ) || /\b(human|real person|live agent)\b/i.test(utterance);
}
