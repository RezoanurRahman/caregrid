/**
 * Domain types for the Caregrid clinic workspace client.
 *
 * The Fastify API is the single source of truth for these shapes. Every response is parsed
 * through the tolerant readers in `normalize.ts`, so a renamed or missing field degrades into a
 * readable error/empty state instead of a blank screen. Keeping the view models here means the
 * views, the API client and the unit tests all speak the same language.
 */

export type ViewKey = 'overview' | 'appointments' | 'clients' | 'followups';

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export type NoticeTone = 'success' | 'error' | 'info';

export interface Notice {
  id: string;
  message: string;
  tone: NoticeTone;
}

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'confirmed',
  'checked_in',
  'completed',
  'no_show',
  'cancelled',
] as const;

export type KnownAppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export type AppointmentStatus = KnownAppointmentStatus | 'unknown';

export const FOLLOW_UP_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;

export type KnownFollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];
export type FollowUpStatus = KnownFollowUpStatus | 'unknown';

export type Priority = 'high' | 'medium' | 'low' | 'unknown';

export interface Provider {
  id: string;
  name: string;
  role: string;
  specialty: string;
}

export interface Appointment {
  id: string;
  clientId: string;
  clientName: string;
  providerId: string;
  providerName: string;
  /** Clinic-local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Clinic-local 24h clock time, `HH:MM`. */
  startTime: string;
  endTime: string;
  type: string;
  reason: string;
  location: string;
  status: AppointmentStatus;
  /** Raw server value, kept so unfamiliar statuses still render something honest. */
  rawStatus: string;
  notes: string;
}

export interface ConsentSummary {
  granted: boolean;
  label: string;
  date: string;
}

export interface ActivityEntry {
  id: string;
  summary: string;
  detail: string;
  kind: string;
  at: string;
}

export interface FollowUp {
  id: string;
  clientId: string;
  clientName: string;
  appointmentId: string;
  title: string;
  detail: string;
  priority: Priority;
  rawPriority: string;
  status: FollowUpStatus;
  rawStatus: string;
  dueDate: string;
  assignee: string;
  createdAt: string;
  completedAt: string;
}

export interface Client {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phone: string;
  email: string;
  preferredContact: string;
  status: string;
  consent: ConsentSummary;
  notes: string;
  since: string;
  language: string;
}

export interface ClientDetail extends Client {
  appointments: Appointment[];
  followUps: FollowUp[];
  activity: ActivityEntry[];
}

export interface SessionCapacity {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  booked: number;
  capacity: number;
  providerName: string;
  location: string;
}

export interface DashboardMetrics {
  appointmentsToday: number;
  booked: number;
  capacity: number;
  completionRate: number;
  completedToday: number;
  openFollowUps: number;
  overdueFollowUps: number;
  activeClients: number;
}

export interface DashboardData {
  date: string;
  clinicName: string;
  site: string;
  metrics: DashboardMetrics;
  upcoming: Appointment[];
  sessions: SessionCapacity[];
  followUps: FollowUp[];
}

/** Payload accepted by `POST /api/clients`. */
export interface NewClientInput {
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  preferredContact?: string;
  consentGranted?: boolean;
  notes?: string;
}

/** Payload accepted by `POST /api/appointments`. */
export interface NewAppointmentInput {
  clientId: string;
  providerId: string;
  date: string;
  startTime: string;
  endTime: string;
  type?: string;
  reason?: string;
}

/** Payload accepted by `POST /api/followups`. */
export interface NewFollowUpInput {
  clientId: string;
  appointmentId?: string;
  title: string;
  priority?: string;
  dueDate?: string;
  assignee?: string;
  detail?: string;
}

export type CsvKind = 'clients' | 'appointments';

export interface CsvDownload {
  filename: string;
  blob: Blob;
  rowCount: number;
}

export const FOLLOW_UP_FILTERS = ['all', 'open', 'in_progress', 'done', 'overdue'] as const;

export type FollowUpFilter = (typeof FOLLOW_UP_FILTERS)[number];
