/**
 * Caregrid request and query schemas.
 *
 * These schemas validate JSON payloads at the API boundary: Fastify routes parse
 * the query, status, import and list schemas directly, and the Lit client can
 * reuse the create schemas for pre-flight form checks. The shipped routes stay
 * authoritative for rejection (for example `POST /api/clients` additionally
 * requires a reachable phone), so this module describes what the public API
 * accepts without loosening the server's own route-local validation.
 *
 * Conflict rules that need storage state (duplicate clients, capacity overflow,
 * invalid status transitions) deliberately live outside this module.
 */
import { z } from 'zod';
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_TYPES,
  CLIENT_CONSENT_STATUSES,
  CLIENT_IMPORT_MODES,
  CLIENT_STATUSES,
  FOLLOW_UP_PRIORITIES,
  FOLLOW_UP_STATUSES,
  MAX_ACCESS_NOTES_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_ID_LENGTH,
  MAX_IMPORT_ROWS,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PHONE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_TITLE_LENGTH,
  isValidIsoDate,
  isValidIsoTime,
} from './constants.js';

// ---------------------------------------------------------------------------
// Shared field primitives
// ---------------------------------------------------------------------------

/** Treat `null` and whitespace-only strings as "not provided". */
const emptyToUndefined = (value: unknown): unknown =>
  value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value;

/** Required, whitespace-trimmed text that cannot be blank. */
const requiredText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`);

/** Optional, whitespace-trimmed text; a missing value becomes `''`. */
const optionalText = (max: number, label: string) =>
  z.preprocess(
    emptyToUndefined,
    z.string().trim().max(max, `${label} must be ${max} characters or fewer`).default(''),
  );

export const nonBlankIdSchema = z
  .string()
  .trim()
  .min(1, 'Id is required')
  .max(MAX_ID_LENGTH, `Id must be ${MAX_ID_LENGTH} characters or fewer`);

export const isoDateSchema = z
  .string()
  .refine(isValidIsoDate, { message: 'Expected a real calendar date in YYYY-MM-DD format' });

export const isoTimeSchema = z
  .string()
  .refine(isValidIsoTime, { message: 'Expected a 24-hour time in HH:mm format' });

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const emailSchema = z
  .string()
  .trim()
  .max(MAX_EMAIL_LENGTH, `Email must be ${MAX_EMAIL_LENGTH} characters or fewer`)
  .refine((value) => EMAIL_PATTERN.test(value), {
    message: 'Email must look like name@example.org',
  });

const PHONE_PATTERN = /^[+()\-.\s\d]{3,}$/;

export const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Phone is required')
  .max(MAX_PHONE_LENGTH, `Phone must be ${MAX_PHONE_LENGTH} characters or fewer`)
  .regex(PHONE_PATTERN, 'Phone may only contain digits, spaces and + ( ) - .');

/** Optional email; `null` means "no email on file". */
export const optionalEmailSchema = z.preprocess(
  emptyToUndefined,
  emailSchema.nullable().default(null),
);

/**
 * Optional phone; `''` means "no phone on file". A supplied value must still be
 * a real phone string, so the empty sentinel is applied after validation.
 */
export const optionalPhoneSchema = z.preprocess(
  emptyToUndefined,
  phoneSchema.optional().transform((value) => value ?? ''),
);

/** Optional free-text search term; `?q=` is treated as absent. */
export const searchQuerySchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .max(MAX_SEARCH_LENGTH, `Search must be ${MAX_SEARCH_LENGTH} characters or fewer`)
    .optional(),
);

/** Optional enum query filter; empty values (`?status=`) are treated as absent. */
const optionalEnum = <U extends string, T extends readonly [U, ...U[]]>(values: T) =>
  z.preprocess(emptyToUndefined, z.enum(values).optional());

const optionalId = z.preprocess(emptyToUndefined, nonBlankIdSchema.optional());
const optionalDate = z.preprocess(emptyToUndefined, isoDateSchema.optional());

/** `true`/`1` and `false`/`0` are accepted for boolean query filters. */
export const booleanQuerySchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return value;
}, z.boolean());

// ---------------------------------------------------------------------------
// Client create + import
// ---------------------------------------------------------------------------

/**
 * Client contact, consent and status fields shared by single-client creation
 * and bulk import. Absent contact details are normalized (`phone`,
 * `preferredName` and `accessNotes` to `''`, `email` to `null`) so downstream
 * code never has to handle `undefined`.
 */
const clientProfileFields = {
  preferredName: optionalText(MAX_NAME_LENGTH, 'Preferred name'),
  phone: optionalPhoneSchema,
  email: optionalEmailSchema,
  accessNotes: optionalText(MAX_ACCESS_NOTES_LENGTH, 'Access notes'),
  consentStatus: z.enum(CLIENT_CONSENT_STATUSES).default('pending'),
  status: z.enum(CLIENT_STATUSES).default('active'),
};

/**
 * `POST /api/clients` payload. Accepts the canonical `firstName`/`lastName`
 * pair or the legacy `fullName` compatibility form, plus optional contact,
 * access, consent and status fields. `firstName` + `lastName` win over
 * `fullName` at the route, and the route additionally requires a phone.
 */
export const createClientSchema = z
  .object({
    firstName: requiredText(MAX_NAME_LENGTH, 'First name').optional(),
    lastName: requiredText(MAX_NAME_LENGTH, 'Last name').optional(),
    fullName: optionalText(MAX_NAME_LENGTH, 'Full name'),
    dateOfBirth: z.preprocess(emptyToUndefined, isoDateSchema.optional()),
    notes: optionalText(MAX_ACCESS_NOTES_LENGTH, 'Notes'),
    consentGranted: z.boolean().optional(),
    ...clientProfileFields,
  })
  .refine(
    (value) =>
      value.firstName !== undefined || value.lastName !== undefined || value.fullName !== '',
    { message: 'A first and last name or a full name is required', path: ['firstName'] },
  );

/**
 * One client-like row inside a bulk import payload. Import rows always spell
 * the name as `firstName`/`lastName`; the `fullName` compatibility form only
 * exists on `POST /api/clients`.
 */
export const clientImportRowSchema = z.object({
  firstName: requiredText(MAX_NAME_LENGTH, 'First name'),
  lastName: requiredText(MAX_NAME_LENGTH, 'Last name'),
  ...clientProfileFields,
});

/**
 * Bulk client import. Duplicate handling is a storage rule: `reject_duplicates`
 * fails the offending rows, `skip_duplicates` leaves existing clients alone.
 */
export const clientImportSchema = z.object({
  rows: z
    .array(clientImportRowSchema)
    .min(1, 'At least one row is required')
    .max(MAX_IMPORT_ROWS, `At most ${MAX_IMPORT_ROWS} rows can be imported at once`),
  mode: z.enum(CLIENT_IMPORT_MODES).default('reject_duplicates'),
});

// ---------------------------------------------------------------------------
// Appointment create + status
// ---------------------------------------------------------------------------

/**
 * Appointment request payload. `sessionId` is intentionally absent: the server
 * resolves the clinic session from `date` and enforces capacity/conflicts.
 * `type` defaults to `other`, while `reason` and `notes` are optional.
 */
export const createAppointmentSchema = z
  .object({
    clientId: nonBlankIdSchema,
    providerId: nonBlankIdSchema,
    date: isoDateSchema,
    startTime: isoTimeSchema,
    endTime: isoTimeSchema,
    type: z.enum(APPOINTMENT_TYPES).default('other'),
    reason: optionalText(MAX_REASON_LENGTH, 'Reason'),
    notes: optionalText(MAX_NOTES_LENGTH, 'Notes'),
  })
  .refine((value) => value.endTime > value.startTime, {
    message: 'endTime must be later than startTime',
    path: ['endTime'],
  });

export const appointmentStatusPatchSchema = z.object({
  status: z.enum(APPOINTMENT_STATUSES),
});

/** Appointment list filters; all optional and combinable. */
export const appointmentListQuerySchema = z.object({
  date: optionalDate,
  from: optionalDate,
  to: optionalDate,
  status: optionalEnum(APPOINTMENT_STATUSES),
  type: optionalEnum(APPOINTMENT_TYPES),
  clientId: optionalId,
  providerId: optionalId,
  sessionId: optionalId,
  q: searchQuerySchema,
});

// ---------------------------------------------------------------------------
// Follow-up create + status
// ---------------------------------------------------------------------------

/**
 * Follow-up request payload (`POST /api/follow-ups`, alias `/api/followups`).
 * `dueDate` intentionally carries no default here: the route resolves an
 * absent due date to seven days after the server's current date. `assigneeId`
 * (or an `assignee` id/name/email), `appointmentId`, `priority` and
 * `notes`/`detail` are optional, with `priority` defaulting to `normal`.
 */
export const createFollowUpSchema = z.object({
  clientId: nonBlankIdSchema,
  appointmentId: z.preprocess(emptyToUndefined, nonBlankIdSchema.nullable().default(null)),
  assigneeId: z.preprocess(emptyToUndefined, nonBlankIdSchema.nullable().default(null)),
  assignee: optionalText(MAX_NAME_LENGTH, 'Assignee'),
  title: requiredText(MAX_TITLE_LENGTH, 'Title'),
  dueDate: isoDateSchema.optional(),
  priority: z.enum(FOLLOW_UP_PRIORITIES).default('normal'),
  notes: optionalText(MAX_NOTES_LENGTH, 'Notes'),
  detail: optionalText(MAX_NOTES_LENGTH, 'Detail'),
});

export const followUpStatusPatchSchema = z.object({
  status: z.enum(FOLLOW_UP_STATUSES),
});

/** Follow-up list filters; all optional and combinable. */
export const followUpListQuerySchema = z.object({
  status: optionalEnum(FOLLOW_UP_STATUSES),
  priority: optionalEnum(FOLLOW_UP_PRIORITIES),
  assigneeId: optionalId,
  clientId: optionalId,
  overdue: booleanQuerySchema.optional(),
  dueBefore: optionalDate,
  q: searchQuerySchema,
});

// ---------------------------------------------------------------------------
// Remaining list queries
// ---------------------------------------------------------------------------

/** Client list filters; all optional and combinable, `search` aliases `q`. */
export const clientListQuerySchema = z.object({
  status: optionalEnum(CLIENT_STATUSES),
  consentStatus: optionalEnum(CLIENT_CONSENT_STATUSES),
  q: searchQuerySchema,
  search: searchQuerySchema,
});

/** Clinic session list filters; all optional and combinable. */
export const sessionListQuerySchema = z.object({
  date: optionalDate,
  from: optionalDate,
  to: optionalDate,
});

// ---------------------------------------------------------------------------
// Inferred input types
// ---------------------------------------------------------------------------

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type CreateFollowUpInput = z.infer<typeof createFollowUpSchema>;
export type AppointmentStatusPatch = z.infer<typeof appointmentStatusPatchSchema>;
export type FollowUpStatusPatch = z.infer<typeof followUpStatusPatchSchema>;
export type ClientListQuery = z.infer<typeof clientListQuerySchema>;
export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;
export type FollowUpListQuery = z.infer<typeof followUpListQuerySchema>;
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;
export type ClientImportRow = z.infer<typeof clientImportRowSchema>;
export type ClientImportInput = z.infer<typeof clientImportSchema>;

/** Aliases for callers that prefer the explicit `<name>InputSchema` spelling. */
export const createClientInputSchema = createClientSchema;
export const createAppointmentInputSchema = createAppointmentSchema;
export const createFollowUpInputSchema = createFollowUpSchema;
export const clientImportInputSchema = clientImportSchema;
