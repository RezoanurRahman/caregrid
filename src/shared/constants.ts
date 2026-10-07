/**
 * Caregrid shared constants.
 *
 * The literal tuples below are the single source of truth for every domain
 * enum: `types.ts` derives the public unions from them and `schemas.ts` builds
 * the matching Zod validators, so storage, API, and UI cannot drift apart.
 *
 * This module has no imports and uses no Node APIs, so it is safe to bundle for
 * the browser and to load on the server.
 */

export const PROVIDER_ROLES = [
  'physician',
  'nurse',
  'nurse_practitioner',
  'medical_assistant',
  'community_health_worker',
  'counselor',
  'coordinator',
  'other',
] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

export const CLIENT_CONSENT_STATUSES = ['pending', 'granted', 'declined'] as const;
export type ClientConsentStatus = (typeof CLIENT_CONSENT_STATUSES)[number];

/**
 * Public client statuses. The store keeps `archived` as `inactive` internally,
 * and `waitlist` is a first-class public value that passes through untouched.
 */
export const CLIENT_STATUSES = ['active', 'archived', 'waitlist'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const APPOINTMENT_TYPES = ['intake', 'check_in', 'follow_up', 'screening', 'other'] as const;
export type AppointmentType = (typeof APPOINTMENT_TYPES)[number];

export const APPOINTMENT_STATUSES = [
  'requested',
  'confirmed',
  'checked_in',
  'completed',
  'no_show',
  'cancelled',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const FOLLOW_UP_PRIORITIES = ['low', 'normal', 'high'] as const;
export type FollowUpPriority = (typeof FOLLOW_UP_PRIORITIES)[number];

export const FOLLOW_UP_STATUSES = ['open', 'in_progress', 'done', 'dismissed'] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const ACTIVITY_ENTITY_TYPES = [
  'client',
  'appointment',
  'follow_up',
  'provider',
  'session',
] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

export const CLIENT_IMPORT_MODES = ['reject_duplicates', 'skip_duplicates'] as const;
export type ClientImportMode = (typeof CLIENT_IMPORT_MODES)[number];

/**
 * Appointment statuses that occupy a clinic slot; used for capacity maths.
 * `cancelled` releases the slot, while `no_show` still counts because the
 * clinic held the time. Mirrors the store's `CAPACITY_STATUSES`.
 */
export const SLOT_OCCUPYING_APPOINTMENT_STATUSES = [
  'requested',
  'confirmed',
  'checked_in',
  'completed',
  'no_show',
] as const;

/** Follow-up statuses that still need attention. */
export const OPEN_FOLLOW_UP_STATUSES = ['open', 'in_progress'] as const;

/** Field limits shared by the request schemas and the UI. */
export const MAX_NAME_LENGTH = 120;
export const MAX_TITLE_LENGTH = 160;
export const MAX_PHONE_LENGTH = 40;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_REASON_LENGTH = 500;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_ACCESS_NOTES_LENGTH = 1000;
export const MAX_SEARCH_LENGTH = 120;
export const MAX_ID_LENGTH = 64;
export const MAX_CAPACITY = 500;
export const MAX_IMPORT_ROWS = 500;

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True when `value` is a real calendar date written as `YYYY-MM-DD`. */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** True when `value` is a 24-hour wall-clock time written as `HH:mm`. */
export function isValidIsoTime(value: string): boolean {
  return ISO_TIME_PATTERN.test(value);
}

/**
 * Allowed appointment status transitions, mirroring the store's runtime
 * enforcement. Terminal statuses have no successors, and `no_show` joins
 * `completed`/`cancelled` as a terminal state.
 */
export const APPOINTMENT_STATUS_TRANSITIONS = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'no_show', 'cancelled'],
  checked_in: ['completed', 'no_show'],
  completed: [],
  no_show: [],
  cancelled: [],
} as const satisfies Record<AppointmentStatus, readonly AppointmentStatus[]>;

/** Allowed follow-up status transitions. Done and dismissed are terminal. */
export const FOLLOW_UP_STATUS_TRANSITIONS = {
  open: ['in_progress', 'dismissed'],
  in_progress: ['open', 'done', 'dismissed'],
  done: [],
  dismissed: [],
} as const satisfies Record<FollowUpStatus, readonly FollowUpStatus[]>;

export function canTransitionAppointment(from: AppointmentStatus, to: AppointmentStatus): boolean {
  const allowed: readonly string[] = APPOINTMENT_STATUS_TRANSITIONS[from];
  return allowed.includes(to);
}

export function canTransitionFollowUp(from: FollowUpStatus, to: FollowUpStatus): boolean {
  const allowed: readonly string[] = FOLLOW_UP_STATUS_TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Canonical machine-readable codes used by `ApiErrorPayload.error.code`.
 *
 * The API always emits upper-case codes: the first five are the domain codes
 * raised by the store and routes, the remainder are the HTTP-level codes the
 * error mapper can emit when Fastify reports them.
 */
export const ERROR_CODES = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  INTERNAL: 'INTERNAL',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
} as const;
export type ApiErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** HTTP status recommended for each canonical error code. */
export const ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  INTERNAL: 500,
  METHOD_NOT_ALLOWED: 405,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
};
