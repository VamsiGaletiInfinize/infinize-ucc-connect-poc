/**
 * Structured JSON logger with mandatory redaction.
 *
 * Constitution Principle V: logs MUST NEVER contain OTP values, credentials, secrets, or
 * unnecessary student PII. Redaction is applied centrally here rather than trusted to
 * every call site, because a call site that forgets is a security incident.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are always replaced, at any depth. */
const REDACTED_KEYS = new Set([
  'otp',
  'otpcode',
  'otphash',
  'code',
  'password',
  'secret',
  'token',
  'accesstoken',
  'sessiontoken',
  'authorization',
  'awsaccesskeyid',
  'awssecretaccesskey',
  'awssessiontoken',
  'apikey',
  'credentials',
  'ssn',
  'dateofbirth',
  'dob',
]);

/** Keys that are partially masked rather than removed, so logs stay useful. */
const MASKED_KEYS = new Set(['phone', 'callerid', 'email', 'maskeddestination']);

const REDACTED = '[REDACTED]';

/** +919876543210 -> +91******3210 ; alice@x.com -> a****@x.com */
export function maskValue(value: string): string {
  if (value.includes('@')) {
    const [local = '', domain = ''] = value.split('@');
    const head = local.slice(0, 1);
    return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
  }
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}${'*'.repeat(Math.max(value.length - 7, 0))}${value.slice(-4)}`;
}

/**
 * Recursively redact a log payload.
 *
 * A six-digit standalone number in any string is scrubbed as a defensive measure against
 * an OTP reaching a log line through an unexpected field (e.g. a transcript turn).
 */
export function redact(input: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') return scrubOtpLikeSequences(input);
  if (typeof input === 'number' || typeof input === 'boolean') return input;

  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));

  if (input instanceof Error) {
    return { name: input.name, message: scrubOtpLikeSequences(input.message) };
  }

  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
      if (REDACTED_KEYS.has(normalized)) {
        out[key] = REDACTED;
      } else if (MASKED_KEYS.has(normalized) && typeof value === 'string') {
        out[key] = maskValue(value);
      } else {
        out[key] = redact(value, depth + 1);
      }
    }
    return out;
  }

  return String(input);
}

/** Replace bare 4-8 digit sequences, which is the shape of an OTP. */
function scrubOtpLikeSequences(text: string): string {
  return text.replace(/(?<!\d)\d{4,8}(?!\d)/g, (match) =>
    // Preserve years and obvious non-secrets to keep logs readable.
    /^(19|20)\d{2}$/.test(match) ? match : '[REDACTED_DIGITS]',
  );
}

export interface LogContext {
  traceId?: string;
  tenantId?: string;
  uccCallId?: string;
  uccTicketId?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Derive a child logger carrying correlation fields on every line. */
  child(context: LogContext): Logger;
}

/** Test seam: capture emitted records instead of writing to stdout. */
export type LogSink = (record: Record<string, unknown>) => void;

const defaultSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === 'error' || record.level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

let activeSink: LogSink = defaultSink;
export function setLogSink(sink: LogSink | null): void {
  activeSink = sink ?? defaultSink;
}

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as const).includes(raw as LogLevel)
    ? (raw as LogLevel)
    : 'info';
}

export function createLogger(base: LogContext = {}): Logger {
  const emit = (level: LogLevel, message: string, context?: LogContext) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
    const merged = { ...base, ...(context ?? {}) };
    activeSink({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(redact(merged) as Record<string, unknown>),
    });
  };

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (context) => createLogger({ ...base, ...context }),
  };
}

export const logger = createLogger({ service: 'ucc-api' });
