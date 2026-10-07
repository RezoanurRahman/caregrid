/**
 * Caregrid domain layer.
 *
 * Public data shapes, status vocabularies, validation helpers and the pure
 * scheduling rules used by the SQLite store. Everything in this module is
 * synchronous, side-effect free and independent of the database, so the rules
 * can be unit tested directly and reused by the seed data and the API layer.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type StoreErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID_TRANSITION' | 'VALIDATION';

/**
 * Typed error raised by the store. The Fastify layer maps the code to a status:
 * NOT_FOUND -> 404, CONFLICT -> 409, INVALID_TRANSITION -> 409, VALIDATION -> 400.
 */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly details: Record<string, unknown> | null;

  constructor(code: StoreErrorCode, message: string, details?: Record<string, unknown> | null) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.details = details ?? null;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isStoreError(value: unknown): value is StoreError {
  if (value instanceof StoreError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; code?: unknown; message?: unknown };
  return (
    candidate.name === 'StoreError' &&
    typeof candidate.code === 'string' &&
    STORE_ERROR_CODES.includes(candidate.code as StoreErrorCode) &&
    typeof candidate.message === 'string'
  );
}

export const STORE_ERROR_CODES: readonly StoreErrorCode[] = [
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_TRANSITION',
  'VALIDATION',
];

/* -------------------------------------------------------------------------- */
/* Vocabularies                                                                */
/* -------------------------------------------------------------------------- */

export const APPOINTMENT_STATUSES = [
  'requested',
  'confirmed',
  'checked_in',
  'completed',
  'no_show',
  'cancelled',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const FOLLOW_UP_STATUSES = ['open', 'in_progress', 'done', 'dismissed'] as const;

export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const CLIENT_STATUSES = ['active', 'waitlist', 'inactive'] as const;

export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** Appointment statuses that occupy a session slot. */
export const CAPACITY_STATUSES = [
  'requested',
  'confirmed',
  'checked_in',
  'completed',
  'no_show',
] as const;

/** Appointment statuses that still bind the client and provider calendars. */
export const BLOCKING_STATUSES = ['requested', 'confirmed', 'checked_in', 'completed'] as const;

/** Follow-up statuses that still require attention. */
export const OPEN_FOLLOW_UP_STATUSES = ['open', 'in_progress'] as const;

export type ActivityEntityType = 'client' | 'appointment' | 'follow_up';

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  requested: 'Requested',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  completed: 'Completed',
  no_show: 'No show',
  cancelled: 'Cancelled',
};

export const FOLLOW_UP_STATUS_LABELS: Record<FollowUpStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  dismissed: 'Dismissed',
};

export const CLIENT_STATUS_LABELS: Record<ClientStatus, string> = {
  active: 'Active',
  waitlist: 'Waitlist',
  inactive: 'Inactive',
};

/** Allowed appointment transitions. Everything not listed here is rejected. */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'no_show', 'cancelled'],
  checked_in: ['completed', 'no_show'],
  completed: [],
  no_show: [],
  cancelled: [],
};

/** Allowed follow-up transitions. Everything not listed here is rejected. */
export const FOLLOW_UP_TRANSITIONS: Record<FollowUpStatus, readonly FollowUpStatus[]> = {
  open: ['in_progress', 'dismissed'],
  in_progress: ['open', 'done', 'dismissed'],
  done: [],
  dismissed: [],
};

export const TERMINAL_APPOINTMENT_STATUSES: readonly AppointmentStatus[] =
  APPOINTMENT_STATUSES.filter((status) => APPOINTMENT_TRANSITIONS[status].length === 0);

export const TERMINAL_FOLLOW_UP_STATUSES: readonly FollowUpStatus[] = FOLLOW_UP_STATUSES.filter(
  (status) => FOLLOW_UP_TRANSITIONS[status].length === 0,
);

export function isValidAppointmentTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  const allowed = APPOINTMENT_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

export function isValidFollowUpTransition(from: FollowUpStatus, to: FollowUpStatus): boolean {
  const allowed = FOLLOW_UP_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

export function isCapacityConsuming(status: AppointmentStatus): boolean {
  return (CAPACITY_STATUSES as readonly string[]).includes(status);
}

export function isBlockingStatus(status: AppointmentStatus): boolean {
  return (BLOCKING_STATUSES as readonly string[]).includes(status);
}

export function isOpenFollowUpStatus(status: FollowUpStatus): boolean {
  return (OPEN_FOLLOW_UP_STATUSES as readonly string[]).includes(status);
}

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

export interface Provider {
  id: string;
  name: string;
  role: string;
  email: string;
  phone: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ClinicSession {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  capacity: number;
  leadProviderId: string | null;
  leadProviderName: string | null;
  notes: string | null;
  /** Slots currently consumed by requested/confirmed/checked_in/completed/no_show appointments. */
  bookedCapacity: number;
  /** capacity - bookedCapacity, never below zero. */
  availableCapacity: number;
  createdAt: string;
  updatedAt: string;
}

export interface Client {
  id: string;
  fullName: string;
  email: string | null;
  phone: string;
  dateOfBirth: string;
  status: ClientStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Appointment {
  id: string;
  clientId: string;
  clientName: string;
  providerId: string;
  providerName: string;
  sessionId: string;
  sessionDate: string;
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  reason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FollowUp {
  id: string;
  clientId: string;
  clientName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  appointmentId: string | null;
  title: string;
  detail: string | null;
  status: FollowUpStatus;
  dueDate: string;
  completedAt: string | null;
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityEvent {
  id: number;
  entityType: ActivityEntityType;
  entityId: string;
  clientId: string | null;
  action: string;
  detail: string;
  createdAt: string;
}

export interface ClientSummary {
  appointmentCount: number;
  completedAppointments: number;
  cancelledAppointments: number;
  openFollowUps: number;
  overdueFollowUps: number;
  lastVisitDate: string | null;
}

export interface ClientDetail {
  client: Client;
  summary: ClientSummary;
  appointments: Appointment[];
  followUps: FollowUp[];
  activity: ActivityEvent[];
}

export interface DashboardMetrics {
  todayAppointments: number;
  confirmedToday: number;
  checkedInToday: number;
  completedToday: number;
  cancelledToday: number;
  noShowToday: number;
  openFollowUps: number;
  overdueFollowUps: number;
  totalSessionCapacity: number;
  bookedCapacity: number;
  availableCapacity: number;
  /** completedToday / bookedCapacity, rounded to two decimals (0 when nothing is booked). */
  completionRate: number;
}

export interface DashboardData {
  today: string;
  metrics: DashboardMetrics;
  upcomingAppointments: Appointment[];
  openFollowUps: FollowUp[];
  overdueFollowUps: FollowUp[];
  sessions: ClinicSession[];
}

export interface CreateClientInput {
  fullName: string;
  email?: string | null;
  phone: string;
  dateOfBirth: string;
  status?: ClientStatus;
  notes?: string | null;
}

export interface CreateAppointmentInput {
  clientId: string;
  providerId: string;
  sessionId: string;
  /** Optional; when provided it must match the session date. */
  date?: string | null;
  startTime: string;
  endTime: string;
  /** New appointments start as requested unless a confirmed booking is explicit. */
  status?: Extract<AppointmentStatus, 'requested' | 'confirmed'>;
  reason?: string | null;
  notes?: string | null;
}

export interface CreateFollowUpInput {
  clientId: string;
  title: string;
  dueDate: string;
  assigneeId?: string | null;
  appointmentId?: string | null;
  detail?: string | null;
  status?: Extract<FollowUpStatus, 'open' | 'in_progress'>;
}

export interface ImportClientRecord {
  fullName: string;
  email?: string | null;
  phone: string;
  dateOfBirth: string;
  status?: ClientStatus;
  notes?: string | null;
}

export type ImportMode = 'skip' | 'fail';

export interface ImportClientsInput {
  clients: readonly ImportClientRecord[];
  /** skip: duplicate rows are counted and ignored. fail: any duplicate aborts the import. */
  mode?: ImportMode;
}

export interface ImportClientsResult {
  created: Client[];
  skipped: number;
}

/* -------------------------------------------------------------------------- */
/* Field validation                                                            */
/* -------------------------------------------------------------------------- */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && parseTimeToMinutesOrNull(value) !== null;
}

/** Accepts HH:MM or HH:MM:SS (also H:MM) and returns minutes since midnight. */
export function parseTimeToMinutesOrNull(value: string): number | null {
  const match = TIME_PATTERN.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 60 + minutes;
}

export function parseTimeToMinutes(value: string, field = 'time'): number {
  const minutes = typeof value === 'string' ? parseTimeToMinutesOrNull(value) : null;
  if (minutes === null) {
    throw new StoreError('VALIDATION', `${field} must be a valid time of the form HH:MM.`, {
      field,
      value,
    });
  }
  return minutes;
}

/** Normalises HH:MM / H:MM / HH:MM:SS to zero-padded HH:MM. */
export function normalizeTime(value: string, field = 'time'): string {
  const minutes = parseTimeToMinutes(value, field);
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function assertIsoDate(value: unknown, field: string): string {
  if (!isIsoDate(value)) {
    throw new StoreError('VALIDATION', `${field} must be a valid ISO date (YYYY-MM-DD).`, {
      field,
      value,
    });
  }
  return value;
}

export function assertText(
  value: unknown,
  field: string,
  options: { maxLength?: number } = {},
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StoreError('VALIDATION', `${field} is required.`, { field });
  }
  const trimmed = value.trim();
  const maxLength = options.maxLength ?? 500;
  if (trimmed.length > maxLength) {
    throw new StoreError('VALIDATION', `${field} must be at most ${maxLength} characters.`, {
      field,
      maxLength,
      length: trimmed.length,
    });
  }
  return trimmed;
}

/** Trims, requires content and collapses internal whitespace runs to a single space. */
export function cleanWhitespace(
  value: unknown,
  field: string,
  options: { maxLength?: number } = {},
): string {
  return assertText(value, field, options).replace(/\s+/g, ' ');
}

export function optionalText(
  value: unknown,
  field: string,
  options: { maxLength?: number } = {},
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new StoreError('VALIDATION', `${field} must be text.`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const maxLength = options.maxLength ?? 2000;
  if (trimmed.length > maxLength) {
    throw new StoreError('VALIDATION', `${field} must be at most ${maxLength} characters.`, {
      field,
      maxLength,
      length: trimmed.length,
    });
  }
  return trimmed;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertEmail(value: unknown, field = 'email'): string {
  if (typeof value !== 'string') {
    throw new StoreError('VALIDATION', `${field} must be text.`, { field, value });
  }
  const normalized = normalizeEmail(value);
  if (normalized.length === 0 || normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new StoreError('VALIDATION', `${field} must be a valid email address.`, { field, value });
  }
  return normalized;
}

export function optionalEmail(value: unknown, field = 'email'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim().length === 0) return null;
  return assertEmail(value, field);
}

/** Lower-cased, whitespace-collapsed, accent-stripped name used for duplicate detection. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new StoreError('VALIDATION', `${field} must be one of: ${allowed.join(', ')}.`, {
      field,
      value,
      allowed,
    });
  }
  return value as T;
}

export function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new StoreError('VALIDATION', `${field} must be a positive whole number.`, {
      field,
      value,
    });
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Scheduling rules                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Half-open interval overlap: [aStart, aEnd) intersects [bStart, bEnd).
 * Touching boundaries (10:00-10:30 and 10:30-11:00) do not overlap.
 */
export function timesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const aStartMin = parseTimeToMinutes(aStart, 'startTime');
  const aEndMin = parseTimeToMinutes(aEnd, 'endTime');
  const bStartMin = parseTimeToMinutes(bStart, 'startTime');
  const bEndMin = parseTimeToMinutes(bEnd, 'endTime');
  if (aEndMin <= aStartMin || bEndMin <= bStartMin) return false;
  return aStartMin < bEndMin && bStartMin < aEndMin;
}

export interface AppointmentWindow {
  startTime: string;
  endTime: string;
  date?: string | null;
}

export interface SessionWindow {
  date: string;
  startTime: string;
  endTime: string;
}

/**
 * Validates a requested appointment window against its clinic session:
 * end after start, same date, and fully inside the session opening hours.
 */
export function assertAppointmentWindow(window: AppointmentWindow, session: SessionWindow): void {
  const sessionDate = assertIsoDate(session.date, 'session.date');
  const startTime = normalizeTime(String(window.startTime), 'startTime');
  const endTime = normalizeTime(String(window.endTime), 'endTime');

  if (window.date !== undefined && window.date !== null && window.date !== '') {
    const requestedDate = assertIsoDate(window.date, 'date');
    if (requestedDate !== sessionDate) {
      throw new StoreError(
        'VALIDATION',
        `Appointment date ${requestedDate} does not match the session date ${sessionDate}.`,
        { field: 'date', date: requestedDate, sessionDate },
      );
    }
  }

  const start = parseTimeToMinutes(startTime, 'startTime');
  const end = parseTimeToMinutes(endTime, 'endTime');
  const sessionStart = parseTimeToMinutes(
    normalizeTime(session.startTime, 'session.startTime'),
    'session.startTime',
  );
  const sessionEnd = parseTimeToMinutes(
    normalizeTime(session.endTime, 'session.endTime'),
    'session.endTime',
  );

  if (end <= start) {
    throw new StoreError('VALIDATION', 'Appointment end time must be after the start time.', {
      field: 'endTime',
      startTime,
      endTime,
    });
  }
  if (start < sessionStart || end > sessionEnd) {
    throw new StoreError(
      'VALIDATION',
      `Appointment ${startTime}-${endTime} is outside the session hours ${session.startTime}-${session.endTime} on ${sessionDate}.`,
      {
        field: 'startTime',
        startTime,
        endTime,
        sessionStart: session.startTime,
        sessionEnd: session.endTime,
        sessionDate,
      },
    );
  }
}

export function countBookedCapacity(
  appointments: readonly { status: AppointmentStatus }[],
): number {
  return appointments.filter((appointment) => isCapacityConsuming(appointment.status)).length;
}

/** capacity - booked (may be zero). Cancelled appointments do not consume capacity. */
export function countAvailableCapacity(
  session: { capacity: number },
  appointments: readonly { status: AppointmentStatus }[],
): number {
  assertPositiveInteger(session.capacity, 'capacity');
  return session.capacity - countBookedCapacity(appointments);
}

export function isSessionFull(
  session: { capacity: number },
  appointments: readonly { status: AppointmentStatus }[],
): boolean {
  return countAvailableCapacity(session, appointments) <= 0;
}

/* -------------------------------------------------------------------------- */
/* Dates and labels                                                            */
/* -------------------------------------------------------------------------- */

/** ISO (UTC) calendar date for a Date instance. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Dashboard "today": CAREGRID_TODAY when it holds a valid ISO date, otherwise
 * the current UTC calendar date. Keeps tests and demos deterministic.
 */
export function resolveToday(
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.CAREGRID_TODAY;
  if (typeof override === 'string' && isIsoDate(override.trim())) return override.trim();
  return toIsoDate(now);
}

export function isOverdueFollowUp(dueDate: string, status: FollowUpStatus, today: string): boolean {
  return isOpenFollowUpStatus(status) && dueDate < today;
}

export function addMinutes(isoTimestamp: string, minutes: number): string {
  const ms = Date.parse(isoTimestamp);
  if (Number.isNaN(ms)) {
    throw new StoreError('VALIDATION', 'isoTimestamp must be a valid ISO timestamp.', {
      isoTimestamp,
    });
  }
  return new Date(ms + minutes * 60_000).toISOString();
}

export function appointmentWindowLabel(window: {
  date: string;
  startTime: string;
  endTime: string;
}): string {
  return `${window.date} ${window.startTime}-${window.endTime}`;
}

/* -------------------------------------------------------------------------- */
/* Human readable activity details                                             */
/* -------------------------------------------------------------------------- */

export interface AppointmentDescriptor {
  clientName: string;
  providerName: string;
  date: string;
  startTime: string;
  endTime: string;
}

export function describeAppointmentCreated(
  appointment: AppointmentDescriptor,
  status: AppointmentStatus,
): string {
  return `Appointment ${APPOINTMENT_STATUS_LABELS[status].toLowerCase()} for ${appointment.clientName} with ${appointment.providerName} on ${appointmentWindowLabel(appointment)}.`;
}

export function describeAppointmentStatusChange(
  appointment: AppointmentDescriptor,
  from: AppointmentStatus,
  to: AppointmentStatus,
): string {
  return `Appointment for ${appointment.clientName} with ${appointment.providerName} on ${appointmentWindowLabel(appointment)} moved from ${APPOINTMENT_STATUS_LABELS[from]} to ${APPOINTMENT_STATUS_LABELS[to]}.`;
}

export function describeClientCreated(
  client: { fullName: string },
  source: 'manual' | 'import' = 'manual',
): string {
  return source === 'import'
    ? `Client ${client.fullName} added by CSV import.`
    : `Client ${client.fullName} added to the roster.`;
}

export function describeFollowUpCreated(
  followUp: { title: string; dueDate: string; status: FollowUpStatus },
  client: { fullName: string },
  assigneeName: string | null,
): string {
  const owner = assigneeName === null ? 'unassigned' : `assigned to ${assigneeName}`;
  return `Follow-up "${followUp.title}" ${FOLLOW_UP_STATUS_LABELS[followUp.status].toLowerCase()} for ${client.fullName}, due ${followUp.dueDate}, ${owner}.`;
}

export function describeFollowUpStatusChange(
  followUp: { title: string },
  client: { fullName: string },
  from: FollowUpStatus,
  to: FollowUpStatus,
): string {
  return `Follow-up "${followUp.title}" for ${client.fullName} moved from ${FOLLOW_UP_STATUS_LABELS[from]} to ${FOLLOW_UP_STATUS_LABELS[to]}.`;
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * RFC 4180 escaping: values containing a comma, quote, CR or LF are wrapped in
 * double quotes and embedded quotes are doubled.
 */
export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(escapeCsvValue).join(',')];
  for (const row of rows) lines.push(row.map(escapeCsvValue).join(','));
  return `${lines.join('\n')}\n`;
}
