/**
 * HTTP error contract for the Caregrid API.
 *
 * Every failure leaves the server as `{ error: { code, message, details? } }`.
 * Domain errors raised by the SQLite store keep their machine readable code and
 * are mapped onto a status here, Fastify's own validation and JSON parse
 * failures are translated into the same envelope, and anything unexpected
 * becomes a safe `INTERNAL` 500 that never leaks SQL text or stack traces.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorPayload } from '../shared/types.js';

/** Machine readable codes carried by the API error envelope. */
export type CaregridErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_TRANSITION'
  | 'METHOD_NOT_ALLOWED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

/** Codes the storage layer raises; each one maps onto an HTTP status below. */
export type StoreErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID_TRANSITION';

export const STORE_ERROR_CODES: readonly StoreErrorCode[] = [
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_TRANSITION',
];

export const HTTP_STATUS_BY_ERROR_CODE: Record<CaregridErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  METHOD_NOT_ALLOWED: 405,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
};

const ERROR_CODE_BY_HTTP_STATUS: Record<number, CaregridErrorCode> = {
  400: 'VALIDATION',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

const FALLBACK_MESSAGE_BY_CODE: Record<CaregridErrorCode, string> = {
  VALIDATION: 'The request payload or query is invalid.',
  NOT_FOUND: 'The requested record was not found.',
  CONFLICT: 'That change clashes with an existing record.',
  INVALID_TRANSITION: 'That status change is not allowed.',
  METHOD_NOT_ALLOWED: 'That HTTP method is not allowed for this endpoint.',
  UNSUPPORTED_MEDIA_TYPE: 'That content type is not supported by this endpoint.',
  PAYLOAD_TOO_LARGE: 'The request payload is too large.',
  INTERNAL: 'Internal server error.',
};

/** Text that must never reach a client because it exposes storage internals. */
const STORAGE_LEAK_PATTERN =
  /(sqlite|better-sqlite3|\bsql\b|constraint failed|no such table|no such column|unable to open database|database is locked)/i;

const MAX_MESSAGE_LENGTH = 300;

/** Error thrown by the API layer itself; carries the status it should produce. */
export class ApiError extends Error {
  readonly code: CaregridErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: CaregridErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = HTTP_STATUS_BY_ERROR_CODE[code];
    if (details !== undefined) this.details = details;
  }
}

/**
 * Storage error shape shared with `src/server/domain.ts`. The router treats any
 * error carrying one of `STORE_ERROR_CODES` the same way, so the class identity
 * does not matter across module boundaries.
 */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly details: Record<string, unknown> | null;

  constructor(code: StoreErrorCode, message: string, details?: Record<string, unknown> | null) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.details = details ?? null;
  }
}

function messageOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined;
}

/** Uppercase domain code carried by an error, when it is one we recognise. */
export function errorCodeOf(value: unknown): CaregridErrorCode | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = (value as { code?: unknown }).code;
  if (typeof raw !== 'string') return undefined;
  const code = raw.trim().toUpperCase() as CaregridErrorCode;
  return STORE_ERROR_CODES.includes(code as StoreErrorCode) ? code : undefined;
}

/** True for storage errors from this file and from `src/server/domain.ts`. */
export function isStoreError(value: unknown): boolean {
  return errorCodeOf(value) !== undefined;
}

/** Keeps a message readable while refusing anything that smells like SQL. */
function safeMessage(message: string | undefined, fallback: string): string {
  if (message === undefined || STORAGE_LEAK_PATTERN.test(message)) return fallback;
  const collapsed = message.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return fallback;
  return collapsed.length > MAX_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : collapsed;
}

/** Structured context from a `StoreError`; dropped when it leaks SQL text. */
function safeDetails(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const details = (error as { details?: unknown }).details;
  if (details === undefined || details === null) return undefined;
  if (typeof details === 'string' || typeof details === 'number' || typeof details === 'boolean') {
    return details;
  }
  return pruneDetails(details);
}

/** Keeps only JSON-serializable detail objects that do not quote SQL text. */
function pruneDetails(details: unknown): unknown {
  try {
    const serialized = JSON.stringify(details);
    if (serialized === undefined || STORAGE_LEAK_PATTERN.test(serialized)) return undefined;
    return JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
}

/** Builds the exact body every non-2xx response uses. */
export function errorPayload(
  code: CaregridErrorCode,
  message?: string,
  details?: unknown,
): ApiErrorPayload {
  const payload: ApiErrorPayload = {
    error: {
      code,
      message: safeMessage(message, FALLBACK_MESSAGE_BY_CODE[code]),
    },
  };
  const pruned = details === undefined ? undefined : pruneDetails(details);
  if (pruned !== undefined) payload.error.details = pruned;
  return payload;
}

interface MappedError {
  status: number;
  body: ApiErrorPayload;
}

interface FastifyValidationIssue {
  instancePath?: unknown;
  message?: unknown;
  params?: { missingProperty?: unknown };
}

function validationIssues(validation: readonly FastifyValidationIssue[]): unknown[] {
  return validation.map((issue) => {
    const instancePath = typeof issue.instancePath === 'string' ? issue.instancePath : '';
    const missingProperty =
      typeof issue.params?.missingProperty === 'string' ? issue.params.missingProperty : '';
    const path = (instancePath || missingProperty || '').replace(/^\//, '').replace(/\//g, '.');
    return {
      path,
      message:
        typeof issue.message === 'string' && issue.message !== '' ? issue.message : 'Invalid value',
    };
  });
}

function statusCodeOf(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const statusCode = (value as { statusCode?: unknown }).statusCode;
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode)) return undefined;
  return statusCode;
}

/**
 * Maps anything thrown in a handler onto a status plus the public error body.
 * Unknown errors are logged by the caller and reduced to a safe 500.
 */
export function mapError(error: unknown): MappedError {
  if (error instanceof ApiError) {
    return { status: error.status, body: errorPayload(error.code, error.message, error.details) };
  }

  const domainCode = errorCodeOf(error);
  if (domainCode !== undefined) {
    return {
      status: HTTP_STATUS_BY_ERROR_CODE[domainCode],
      body: errorPayload(domainCode, messageOf(error), safeDetails(error)),
    };
  }

  const validation = (error as { validation?: unknown } | null)?.validation;
  if (Array.isArray(validation) && validation.length > 0) {
    return {
      status: 400,
      body: errorPayload('VALIDATION', 'Request body or query failed validation.', {
        issues: validationIssues(validation as FastifyValidationIssue[]),
      }),
    };
  }

  const statusCode = statusCodeOf(error);
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    const code = ERROR_CODE_BY_HTTP_STATUS[statusCode] ?? 'VALIDATION';
    return { status: statusCode, body: errorPayload(code, messageOf(error)) };
  }

  return { status: 500, body: errorPayload('INTERNAL') };
}

/**
 * Installs the single error handler used by every route. Validation errors and
 * JSON parse failures produce `VALIDATION`; storage errors keep their domain
 * code; everything else becomes a safe `INTERNAL` 500 with the original error
 * logged for the operator only.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const mapped = mapError(error);
    if (mapped.status >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.info(
        { code: mapped.body.error.code, status: mapped.status, url: request.url },
        'request rejected',
      );
    }
    reply.status(mapped.status).send(mapped.body);
  });
}
