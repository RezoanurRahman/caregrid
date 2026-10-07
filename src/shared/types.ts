/**
 * Caregrid public contracts.
 *
 * Every type here crosses the Fastify/Lit boundary over JSON, so all fields are
 * deliberately serializable: no `Date`, `Map`, or class instances. Request
 * payloads are validated by the Zod schemas in `schemas.ts`, whose inferred
 * input types are re-exported at the bottom of this file.
 */
import type {
  ActivityEntityType,
  ApiErrorCode,
  AppointmentStatus,
  AppointmentType,
  ClientConsentStatus,
  ClientImportMode,
  ClientStatus,
  FollowUpPriority,
  FollowUpStatus,
  ProviderRole,
} from './constants.js';

export type {
  ActivityEntityType,
  ApiErrorCode,
  AppointmentStatus,
  AppointmentType,
  ClientConsentStatus,
  ClientImportMode,
  ClientStatus,
  FollowUpPriority,
  FollowUpStatus,
  ProviderRole,
} from './constants.js';

/** Calendar date written as `YYYY-MM-DD` (the clinic's local day, no timezone). */
export type IsoDate = string;

/** Wall-clock time written as 24-hour `HH:mm`. */
export type IsoTime = string;

/** Timestamp serialized as an ISO 8601 string. */
export type IsoDateTime = string;

export interface Provider {
  id: string;
  name: string;
  role: ProviderRole;
  /** Hex colour used by the client to tag this provider in schedule views. */
  color: string;
  active: boolean;
  /** Contact and audit fields returned by `GET /api/providers`. */
  email?: string;
  phone?: string | null;
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
}

export interface ClinicSession {
  id: string;
  date: IsoDate;
  location: string;
  /** Maximum number of appointments the session can hold. */
  capacity: number;
  opensAt: IsoTime;
  closesAt: IsoTime;
  /** Alias of `opensAt` returned by session reads. */
  startTime?: IsoTime;
  /** Alias of `closesAt` returned by session reads. */
  endTime?: IsoTime;
  /** Capacity summary counters returned alongside each session. */
  booked?: number;
  remaining?: number;
  /** `booked / capacity` as a 0-1 fraction, rounded by the server. */
  utilization?: number;
  leadProviderId?: string | null;
  leadProviderName?: string | null;
  notes?: string | null;
}

export interface Client {
  id: string;
  firstName: string;
  lastName: string;
  /** Display name; empty string means "use `firstName`". */
  preferredName: string;
  /** Empty string means "no phone on file". */
  phone: string;
  /** `null` means "no email on file". */
  email: string | null;
  /**
   * Channel the clinic should use to reach this client. `POST /api/clients`
   * accepts `phone`, `sms`, `email`, `letter` or `in_person`; reads default to
   * `phone` when the stored value is missing.
   */
  preferredContact?: string;
  accessNotes: string;
  consentStatus: ClientConsentStatus;
  /** `waitlist` is a first-class public status alongside active and archived. */
  status: ClientStatus;
  createdAt: IsoDateTime;
  updatedAt?: IsoDateTime;
  /** `null` when the clinic has no birth date on file. */
  dateOfBirth?: IsoDate | null;
}

/**
 * An appointment as returned by the API. `clientName`, `providerName`, and
 * `location` are denormalized join fields so list views render without extra
 * lookups. `sessionId` is resolved by the server from the appointment date.
 */
export interface Appointment {
  id: string;
  clientId: string;
  providerId: string;
  sessionId: string;
  date: IsoDate;
  startTime: IsoTime;
  endTime: IsoTime;
  type: AppointmentType;
  reason: string;
  notes: string;
  status: AppointmentStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  clientName: string;
  providerName: string;
  location: string;
  /** Always returned by list/detail reads; mirrors `date` for compatibility. */
  sessionDate?: IsoDate;
}

export interface FollowUp {
  id: string;
  clientId: string;
  /** `null` when the follow-up is not tied to a specific appointment. */
  appointmentId: string | null;
  /** `null` when the follow-up is unassigned. */
  assigneeId: string | null;
  title: string;
  dueDate: IsoDate;
  priority: FollowUpPriority;
  status: FollowUpStatus;
  notes: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  clientName: string;
  assigneeName: string;
  /** Denormalized alias of `notes` returned by follow-up reads. */
  detail?: string;
  /** True when the server already classified the due date as overdue. */
  overdue?: boolean;
  /** Set when the follow-up reached `done`; `null` otherwise. */
  completedAt?: IsoDateTime | null;
}

export interface ActivityEvent {
  id: string;
  entityType: ActivityEntityType;
  entityId: string;
  /** Free-form verb such as `created`, `status_changed`, or `imported`. */
  action: string;
  detail: string;
  createdAt: IsoDateTime;
}

/**
 * Dashboard counters, all computed for `DashboardData.asOfDate` unless noted.
 * - `activeClients`: clients with status `active`.
 * - `appointmentsToday`: today's appointments whose status occupies a slot.
 * - `completedToday`: today's appointments with status `completed`.
 * - `openFollowUps`: follow-ups with status `open` or `in_progress`.
 * - `overdueFollowUps`: open follow-ups whose `dueDate` is before today.
 * - `availableCapacityToday`: sum of today's session capacity minus
 *   `appointmentsToday`.
 */
export interface DashboardMetrics {
  activeClients: number;
  appointmentsToday: number;
  completedToday: number;
  openFollowUps: number;
  overdueFollowUps: number;
  availableCapacityToday: number;
  /** Alias of `appointmentsToday` returned by the dashboard payload. */
  todayAppointments?: number;
  /** Capacity counters for today's sessions. */
  capacityTotal?: number;
  capacityBooked?: number;
  booked?: number;
  capacity?: number;
  remaining?: number;
  /** `completedToday / capacityBooked` as a 0-1 fraction. */
  completionRate?: number;
  /** `completionRate` as a 0-100 percentage rounded to one decimal. */
  completionPercent?: number;
  /** Today's appointment counts per status. */
  byStatus?: Partial<Record<AppointmentStatus, number>>;
}

/**
 * Dashboard payload. `upcomingAppointments` are dated on or after `asOfDate`
 * (cancelled excluded), `followUps` are open items, and `sessions` are the
 * clinic sessions scheduled on `asOfDate`; each list is ordered for display and
 * may be capped by the server.
 */
export interface DashboardData {
  asOfDate: IsoDate;
  /** Alias of `asOfDate` returned by the dashboard payload. */
  today?: IsoDate;
  metrics: DashboardMetrics;
  upcomingAppointments: Appointment[];
  followUps: FollowUp[];
  /** Overdue subset of `followUps`. */
  overdueFollowUps?: FollowUp[];
  sessions: ClinicSession[];
}

/**
 * Everything the client detail view needs in one round trip: the client, their
 * appointments and follow-ups (newest first), and the activity trail for the
 * client and those related records (newest first).
 */
export interface ClientDetail {
  client: Client;
  appointments: Appointment[];
  followUps: FollowUp[];
  activity: ActivityEvent[];
}

export interface ApiErrorInfo {
  /** Machine-readable upper-case code; see `ERROR_CODES` for the canonical set. */
  code: ApiErrorCode;
  /** Human-readable, safe to surface in the UI. */
  message: string;
  /** Optional structured context, e.g. Zod issues or conflicting ids. */
  details?: unknown;
}

/** Exact JSON body returned by the API for every non-2xx response. */
export interface ApiErrorPayload {
  error: ApiErrorInfo;
}

/** Alias used by handlers and clients that type the full error response. */
export type ApiErrorResponse = ApiErrorPayload;

export interface ClientImportRowError {
  /** 1-based position of the row in the submitted `rows` array. */
  row: number;
  code: string;
  message: string;
}

/**
 * Response contract for `POST /api/clients/import`. `mode` echoes the resolved
 * import mode, `created` lists the clients the import inserted, `skipped`
 * counts rows `skip_duplicates` left alone, and `errors` carries per-row
 * rejections when the server reports them instead of aborting the request.
 */
export interface ClientImportResult {
  mode: ClientImportMode;
  totalRows: number;
  imported: number;
  created?: Client[];
  skipped: number;
  errors: ClientImportRowError[];
}

export type {
  AppointmentListQuery,
  AppointmentStatusPatch,
  ClientImportInput,
  ClientImportRow,
  ClientListQuery,
  CreateAppointmentInput,
  CreateClientInput,
  CreateFollowUpInput,
  FollowUpListQuery,
  FollowUpStatusPatch,
  SessionListQuery,
} from './schemas.js';
