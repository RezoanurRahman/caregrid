/**
 * Caregrid SQLite store.
 *
 * The store is the only place that reads or writes clinic data. It maps the
 * snake_case database rows to the camelCase public shapes, validates every
 * input, enforces the scheduling and workflow rules from `domain.ts`, and
 * writes an activity trail entry for every create and status change.
 *
 * Writes that touch more than one row (appointments, follow-ups and CSV
 * imports) run inside a single all-or-nothing transaction.
 */

import Database from 'better-sqlite3';
import { initializeDatabase } from './db.js';
import {
  APPOINTMENT_STATUSES,
  BLOCKING_STATUSES,
  CAPACITY_STATUSES,
  CLIENT_STATUSES,
  FOLLOW_UP_STATUSES,
  StoreError,
  assertAppointmentWindow,
  assertIsoDate,
  assertOneOf,
  assertText,
  cleanWhitespace,
  countAvailableCapacity,
  describeAppointmentCreated,
  describeAppointmentStatusChange,
  describeClientCreated,
  describeFollowUpCreated,
  describeFollowUpStatusChange,
  isOpenFollowUpStatus,
  isOverdueFollowUp,
  isStoreError,
  isValidAppointmentTransition,
  isValidFollowUpTransition,
  normalizeEmail,
  normalizeName,
  normalizeTime,
  optionalEmail,
  optionalText,
  resolveToday,
  timesOverlap,
  toCsv,
  type ActivityEntityType,
  type ActivityEvent,
  type Appointment,
  type AppointmentStatus,
  type Client,
  type ClientDetail,
  type ClientStatus,
  type ClientSummary,
  type ClinicSession,
  type CreateAppointmentInput,
  type CreateClientInput,
  type CreateFollowUpInput,
  type DashboardData,
  type DashboardMetrics,
  type FollowUp,
  type FollowUpStatus,
  type ImportClientsInput,
  type ImportClientsResult,
  type ImportMode,
  type Provider,
} from './domain.js';

/* -------------------------------------------------------------------------- */
/* Database row shapes                                                         */
/* -------------------------------------------------------------------------- */

interface ProviderRow {
  id: string;
  name: string;
  role: string;
  email: string;
  phone: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  location: string;
  capacity: number;
  lead_provider_id: string | null;
  lead_provider_name: string | null;
  notes: string | null;
  booked: number;
  created_at: string;
  updated_at: string;
}

interface ClientRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string;
  date_of_birth: string;
  status: ClientStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface AppointmentRow {
  id: string;
  client_id: string;
  client_name: string;
  provider_id: string;
  provider_name: string;
  session_id: string;
  session_date: string;
  date: string;
  start_time: string;
  end_time: string;
  status: AppointmentStatus;
  reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface FollowUpRow {
  id: string;
  client_id: string;
  client_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  appointment_id: string | null;
  title: string;
  detail: string | null;
  status: FollowUpStatus;
  due_date: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ActivityRow {
  id: number;
  entity_type: ActivityEntityType;
  entity_id: string;
  client_id: string | null;
  action: string;
  detail: string;
  created_at: string;
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
}

const BLOCKING_STATUS_SQL = sqlList(BLOCKING_STATUSES);
const CAPACITY_STATUS_SQL = sqlList(CAPACITY_STATUSES);

const APPOINTMENT_SELECT = `
  SELECT a.id, a.client_id, a.provider_id, a.session_id, a.date, a.start_time, a.end_time,
         a.status, a.reason, a.notes, a.created_at, a.updated_at,
         c.full_name AS client_name,
         p.name AS provider_name,
         s.date AS session_date
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    JOIN providers p ON p.id = a.provider_id
    JOIN clinic_sessions s ON s.id = a.session_id
`;

const FOLLOW_UP_SELECT = `
  SELECT f.id, f.client_id, f.assignee_id, f.appointment_id, f.title, f.detail, f.status,
         f.due_date, f.completed_at, f.created_at, f.updated_at,
         c.full_name AS client_name,
         p.name AS assignee_name
    FROM follow_ups f
    JOIN clients c ON c.id = f.client_id
    LEFT JOIN providers p ON p.id = f.assignee_id
`;

const SESSION_SELECT = `
  SELECT s.id, s.date, s.start_time, s.end_time, s.location, s.capacity, s.lead_provider_id,
         s.notes, s.created_at, s.updated_at,
         p.name AS lead_provider_name,
         (SELECT COUNT(*) FROM appointments a
            WHERE a.session_id = s.id AND a.status IN (${CAPACITY_STATUS_SQL})) AS booked
    FROM clinic_sessions s
    LEFT JOIN providers p ON p.id = s.lead_provider_id
`;

/* -------------------------------------------------------------------------- */
/* Mappers                                                                     */
/* -------------------------------------------------------------------------- */

function mapProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    email: row.email,
    phone: row.phone,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row: SessionRow): ClinicSession {
  return {
    id: row.id,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    location: row.location,
    capacity: row.capacity,
    leadProviderId: row.lead_provider_id,
    leadProviderName: row.lead_provider_name,
    notes: row.notes,
    bookedCapacity: row.booked,
    availableCapacity: Math.max(0, row.capacity - row.booked),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapClient(row: ClientRow): Client {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    dateOfBirth: row.date_of_birth,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    providerId: row.provider_id,
    providerName: row.provider_name,
    sessionId: row.session_id,
    sessionDate: row.session_date,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    reason: row.reason,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFollowUp(row: FollowUpRow, today: string): FollowUp {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    appointmentId: row.appointment_id,
    title: row.title,
    detail: row.detail,
    status: row.status,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    overdue: isOverdueFollowUp(row.due_date, row.status, today),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActivity(row: ActivityRow): ActivityEvent {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    clientId: row.client_id,
    action: row.action,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export interface ListAppointmentFilters {
  date?: string;
  status?: AppointmentStatus;
  providerId?: string;
}

export interface ListFollowUpFilters {
  status?: FollowUpStatus;
  assigneeId?: string;
  /** true: only overdue follow-ups. false: only follow-ups that are not overdue. Omit for all. */
  overdue?: boolean;
}

export interface ListClientQuery {
  search?: string;
  status?: ClientStatus;
}

export type CsvEntity = 'clients' | 'appointments' | 'follow_ups';

export interface Store {
  listProviders(): Provider[];
  listSessions(date?: string): ClinicSession[];
  listClients(query?: ListClientQuery): Client[];
  getClientDetail(id: string): ClientDetail;
  createClient(input: CreateClientInput): Client;
  listAppointments(filters?: ListAppointmentFilters): Appointment[];
  createAppointment(input: CreateAppointmentInput): Appointment;
  updateAppointmentStatus(id: string, status: AppointmentStatus): Appointment;
  listFollowUps(filters?: ListFollowUpFilters): FollowUp[];
  createFollowUp(input: CreateFollowUpInput): FollowUp;
  updateFollowUpStatus(id: string, status: FollowUpStatus): FollowUp;
  getDashboard(): DashboardData;
  exportCsv(entity: CsvEntity): string;
  importClients(input: ImportClientsInput): ImportClientsResult;
}

class SqliteStore implements Store {
  private readonly db: Database.Database;

  private readonly statements = new Map<string, Database.Statement>();

  constructor(db: Database.Database) {
    initializeDatabase(db);
    this.db = db;
  }

  /* ---------------------------------------------------------------- providers */

  listProviders(): Provider[] {
    const rows = this.db
      .prepare('SELECT * FROM providers ORDER BY active DESC, name COLLATE NOCASE')
      .all() as ProviderRow[];
    return rows.map(mapProvider);
  }

  /* ----------------------------------------------------------------- sessions */

  listSessions(date?: string): ClinicSession[] {
    const filterDate = date === undefined || date === null || date === '' ? null : assertIsoDate(date, 'date');
    const rows = this.stmt(
      `${SESSION_SELECT} WHERE (:date IS NULL OR s.date = :date) ORDER BY s.date, s.start_time`,
    ).all({ date: filterDate }) as SessionRow[];
    return rows.map(mapSession);
  }

  /* ------------------------------------------------------------------ clients */

  listClients(query: ListClientQuery = {}): Client[] {
    const status = query.status === undefined ? null : assertOneOf(query.status, CLIENT_STATUSES, 'status');
    const search = query.search === undefined || query.search.trim() === '' ? null : query.search.trim();
    if (search !== null && search.length > 120) {
      throw new StoreError('VALIDATION', 'search must be at most 120 characters.', { field: 'search' });
    }
    const rows = this.db
      .prepare(
        `SELECT c.* FROM clients c
          WHERE (:status IS NULL OR c.status = :status)
            AND (:search IS NULL
                 OR instr(lower(c.full_name), lower(:search)) > 0
                 OR instr(lower(IFNULL(c.email, '')), lower(:search)) > 0
                 OR instr(lower(c.phone), lower(:search)) > 0)
          ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'waitlist' THEN 1 ELSE 2 END,
                   c.full_name COLLATE NOCASE`,
      )
      .all({ status, search }) as ClientRow[];
    return rows.map(mapClient);
  }

  getClientDetail(id: string): ClientDetail {
    const clientId = assertText(id, 'clientId', { maxLength: 64 });
    const row = this.db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as ClientRow | undefined;
    if (row === undefined) {
      throw new StoreError('NOT_FOUND', `Client ${clientId} was not found.`, { clientId });
    }
    const today = resolveToday();
    const appointments = (
      this.stmt(`${APPOINTMENT_SELECT} WHERE a.client_id = :clientId ORDER BY a.date DESC, a.start_time DESC`)
        .all({ clientId }) as AppointmentRow[]
    ).map(mapAppointment);
    const followUps = (
      this.stmt(
        `${FOLLOW_UP_SELECT}
          WHERE f.client_id = :clientId
          ORDER BY CASE WHEN f.status IN ('open', 'in_progress') THEN 0 ELSE 1 END, f.due_date, f.created_at`,
      ).all({ clientId }) as FollowUpRow[]
    ).map((followUp) => mapFollowUp(followUp, today));
    const activity = (
      this.db
        .prepare(
          `SELECT * FROM activity_events
            WHERE client_id = :clientId OR (entity_type = 'client' AND entity_id = :clientId)
            ORDER BY created_at DESC, id DESC
            LIMIT 200`,
        )
        .all({ clientId }) as ActivityRow[]
    ).map(mapActivity);
    const summaryRow = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM appointments WHERE client_id = @clientId) AS appointment_count,
           (SELECT COUNT(*) FROM appointments WHERE client_id = @clientId AND status = 'completed') AS completed_count,
           (SELECT COUNT(*) FROM appointments WHERE client_id = @clientId AND status = 'cancelled') AS cancelled_count,
           (SELECT COUNT(*) FROM follow_ups
              WHERE client_id = @clientId AND status IN ('open', 'in_progress')) AS open_follow_ups,
           (SELECT COUNT(*) FROM follow_ups
              WHERE client_id = @clientId AND status IN ('open', 'in_progress') AND due_date < @today) AS overdue_follow_ups,
           (SELECT MAX(date) FROM appointments WHERE client_id = @clientId AND status = 'completed') AS last_visit`,
      )
      .get({ clientId, today }) as {
      appointment_count: number;
      completed_count: number;
      cancelled_count: number;
      open_follow_ups: number;
      overdue_follow_ups: number;
      last_visit: string | null;
    };
    const summary: ClientSummary = {
      appointmentCount: summaryRow.appointment_count,
      completedAppointments: summaryRow.completed_count,
      cancelledAppointments: summaryRow.cancelled_count,
      openFollowUps: summaryRow.open_follow_ups,
      overdueFollowUps: summaryRow.overdue_follow_ups,
      lastVisitDate: summaryRow.last_visit,
    };
    return { client: mapClient(row), summary, appointments, followUps, activity };
  }

  createClient(input: CreateClientInput): Client {
    const fullName = cleanWhitespace(input?.fullName, 'fullName', { maxLength: 120 });
    const email = optionalEmail(input?.email, 'email');
    const phone = assertText(input?.phone, 'phone', { maxLength: 40 });
    const dateOfBirth = assertIsoDate(input?.dateOfBirth, 'dateOfBirth');
    const status = assertOneOf(input?.status ?? 'active', CLIENT_STATUSES, 'status');
    const notes = optionalText(input?.notes, 'notes', { maxLength: 1000 });

    const create = this.db.transaction((): Client => {
      if (email !== null && this.findClientByEmail(email) !== undefined) {
        throw new StoreError('CONFLICT', `A client with the email ${email} already exists.`, {
          field: 'email',
          email,
        });
      }
      return this.insertClient({ fullName, email, phone, dateOfBirth, status, notes }, 'manual', nowIso());
    });
    return create.immediate();
  }

  /* ------------------------------------------------------------- appointments */

  listAppointments(filters: ListAppointmentFilters = {}): Appointment[] {
    const date = filters.date === undefined ? null : assertIsoDate(filters.date, 'date');
    const status =
      filters.status === undefined ? null : assertOneOf(filters.status, APPOINTMENT_STATUSES, 'status');
    const providerId =
      filters.providerId === undefined ? null : assertText(filters.providerId, 'providerId', { maxLength: 64 });
    const rows = this.stmt(
      `${APPOINTMENT_SELECT}
        WHERE (:date IS NULL OR a.date = :date)
          AND (:status IS NULL OR a.status = :status)
          AND (:providerId IS NULL OR a.provider_id = :providerId)
        ORDER BY a.date, a.start_time, a.id`,
    ).all({ date, status, providerId }) as AppointmentRow[];
    return rows.map(mapAppointment);
  }

  createAppointment(input: CreateAppointmentInput): Appointment {
    const startTime = normalizeTime(String(input?.startTime ?? ''), 'startTime');
    const endTime = normalizeTime(String(input?.endTime ?? ''), 'endTime');
    const status = assertOneOf(input?.status ?? 'requested', ['requested', 'confirmed'] as const, 'status');
    const reason = optionalText(input?.reason, 'reason', { maxLength: 200 });
    const notes = optionalText(input?.notes, 'notes', { maxLength: 1000 });
    const clientId = assertText(input?.clientId, 'clientId', { maxLength: 64 });
    const providerId = assertText(input?.providerId, 'providerId', { maxLength: 64 });
    const sessionId = assertText(input?.sessionId, 'sessionId', { maxLength: 64 });

    const create = this.db.transaction((): Appointment => {
      const session = this.requireSession(sessionId);
      assertAppointmentWindow(
        { date: input?.date ?? null, startTime, endTime },
        { date: session.date, startTime: session.start_time, endTime: session.end_time },
      );

      const client = this.requireClient(clientId);
      if (client.status !== 'active') {
        throw new StoreError(
          'VALIDATION',
          `Client ${client.full_name} is ${client.status} and cannot be booked into a new appointment.`,
          { field: 'clientId', clientId, status: client.status },
        );
      }
      const provider = this.requireProvider(providerId);
      if (provider.active !== 1) {
        throw new StoreError('VALIDATION', `Provider ${provider.name} is inactive and cannot take new appointments.`, {
          field: 'providerId',
          providerId,
        });
      }

      const sessionAppointments = this.db
        .prepare('SELECT status FROM appointments WHERE session_id = ?')
        .all(sessionId) as { status: AppointmentStatus }[];
      const available = countAvailableCapacity(session, sessionAppointments);
      if (available <= 0) {
        throw new StoreError('CONFLICT', `Session ${sessionId} is full (${session.capacity} slots booked).`, {
          field: 'sessionId',
          sessionId,
          capacity: session.capacity,
          booked: session.capacity - available,
        });
      }

      const conflicts = this.findBlockingConflicts({
        date: session.date,
        startTime,
        endTime,
        clientId,
        providerId,
      });
      if (conflicts.length > 0) {
        const description = conflicts
          .map(
            (conflict) =>
              `${conflict.kind} ${conflict.name} is booked ${conflict.startTime}-${conflict.endTime}`,
          )
          .join('; ');
        throw new StoreError('CONFLICT', `Time slot overlaps an existing booking: ${description}.`, {
          date: session.date,
          startTime,
          endTime,
          conflicts,
        });
      }

      const id = this.nextId('apt', 'appointments');
      const timestamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO appointments
             (id, client_id, provider_id, session_id, date, start_time, end_time, status, reason, notes, created_at, updated_at)
           VALUES (@id, @clientId, @providerId, @sessionId, @date, @startTime, @endTime, @status, @reason, @notes, @createdAt, @updatedAt)`,
        )
        .run({
          id,
          clientId,
          providerId,
          sessionId,
          date: session.date,
          startTime,
          endTime,
          status,
          reason,
          notes,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      this.insertActivity({
        entityType: 'appointment',
        entityId: id,
        clientId,
        action: 'created',
        detail: describeAppointmentCreated(
          {
            clientName: client.full_name,
            providerName: provider.name,
            date: session.date,
            startTime,
            endTime,
          },
          status,
        ),
        createdAt: timestamp,
      });
      return this.requireAppointment(id);
    });
    return create.immediate();
  }

  updateAppointmentStatus(id: string, status: AppointmentStatus): Appointment {
    const appointmentId = assertText(id, 'appointmentId', { maxLength: 64 });
    const nextStatus = assertOneOf(status, APPOINTMENT_STATUSES, 'status');
    const update = this.db.transaction((): Appointment => {
      const existing = this.requireAppointment(appointmentId);
      if (!isValidAppointmentTransition(existing.status, nextStatus)) {
        throw new StoreError(
          'INVALID_TRANSITION',
          `Appointment ${appointmentId} cannot move from ${existing.status} to ${nextStatus}.`,
          {
            appointmentId,
            from: existing.status,
            to: nextStatus,
            allowed: APPOINTMENT_STATUSES.filter((candidate) =>
              isValidAppointmentTransition(existing.status, candidate),
            ),
          },
        );
      }
      const timestamp = nowIso();
      this.db
        .prepare('UPDATE appointments SET status = @status, updated_at = @updatedAt WHERE id = @id')
        .run({ id: appointmentId, status: nextStatus, updatedAt: timestamp });
      this.insertActivity({
        entityType: 'appointment',
        entityId: appointmentId,
        clientId: existing.clientId,
        action: 'status_changed',
        detail: describeAppointmentStatusChange(
          {
            clientName: existing.clientName,
            providerName: existing.providerName,
            date: existing.date,
            startTime: existing.startTime,
            endTime: existing.endTime,
          },
          existing.status,
          nextStatus,
        ),
        createdAt: timestamp,
      });
      return this.requireAppointment(appointmentId);
    });
    return update.immediate();
  }

  /* ---------------------------------------------------------------- follow-ups */

  listFollowUps(filters: ListFollowUpFilters = {}): FollowUp[] {
    const status = filters.status === undefined ? null : assertOneOf(filters.status, FOLLOW_UP_STATUSES, 'status');
    const assigneeId =
      filters.assigneeId === undefined ? null : assertText(filters.assigneeId, 'assigneeId', { maxLength: 64 });
    // Tri-state: undefined means "any", true means "only overdue", false means "only not overdue".
    const overdue = filters.overdue === undefined ? null : filters.overdue ? 1 : 0;
    const today = resolveToday();
    const rows = this.stmt(
      `${FOLLOW_UP_SELECT}
        WHERE (:status IS NULL OR f.status = :status)
          AND (:assigneeId IS NULL OR f.assignee_id = :assigneeId)
          AND (
            :overdue IS NULL
            OR (:overdue = 1 AND f.status IN ('open', 'in_progress') AND f.due_date < :today)
            OR (:overdue = 0 AND (f.status NOT IN ('open', 'in_progress') OR f.due_date >= :today))
          )
        ORDER BY CASE WHEN f.status IN ('open', 'in_progress') THEN 0 ELSE 1 END,
                 f.due_date, f.created_at, f.id`,
    ).all({ status, assigneeId, overdue, today }) as FollowUpRow[];
    return rows.map((row) => mapFollowUp(row, today));
  }

  createFollowUp(input: CreateFollowUpInput): FollowUp {
    const title = assertText(input?.title, 'title', { maxLength: 140 });
    const dueDate = assertIsoDate(input?.dueDate, 'dueDate');
    const status = assertOneOf(input?.status ?? 'open', ['open', 'in_progress'] as const, 'status');
    const detail = optionalText(input?.detail, 'detail', { maxLength: 1000 });
    const clientId = assertText(input?.clientId, 'clientId', { maxLength: 64 });
    const assigneeId =
      input?.assigneeId === undefined || input?.assigneeId === null
        ? null
        : assertText(input.assigneeId, 'assigneeId', { maxLength: 64 });
    const appointmentId =
      input?.appointmentId === undefined || input?.appointmentId === null
        ? null
        : assertText(input.appointmentId, 'appointmentId', { maxLength: 64 });

    const create = this.db.transaction((): FollowUp => {
      const client = this.requireClient(clientId);
      let assigneeName: string | null = null;
      if (assigneeId !== null) {
        const provider = this.requireProvider(assigneeId);
        if (provider.active !== 1) {
          throw new StoreError(
            'VALIDATION',
            `Provider ${provider.name} is inactive and cannot be assigned follow-ups.`,
            { field: 'assigneeId', assigneeId },
          );
        }
        assigneeName = provider.name;
      }
      if (appointmentId !== null) {
        const appointment = this.requireAppointment(appointmentId);
        if (appointment.clientId !== clientId) {
          throw new StoreError(
            'VALIDATION',
            `Appointment ${appointmentId} belongs to a different client than ${clientId}.`,
            { field: 'appointmentId', appointmentId, clientId, appointmentClientId: appointment.clientId },
          );
        }
      }

      const id = this.nextId('fup', 'follow_ups');
      const timestamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO follow_ups
             (id, client_id, appointment_id, assignee_id, title, detail, status, due_date, completed_at, created_at, updated_at)
           VALUES (@id, @clientId, @appointmentId, @assigneeId, @title, @detail, @status, @dueDate, NULL, @createdAt, @updatedAt)`,
        )
        .run({
          id,
          clientId,
          appointmentId,
          assigneeId,
          title,
          detail,
          status,
          dueDate,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      this.insertActivity({
        entityType: 'follow_up',
        entityId: id,
        clientId,
        action: 'created',
        detail: describeFollowUpCreated({ title, dueDate, status }, { fullName: client.full_name }, assigneeName),
        createdAt: timestamp,
      });
      return this.requireFollowUp(id);
    });
    return create.immediate();
  }

  updateFollowUpStatus(id: string, status: FollowUpStatus): FollowUp {
    const followUpId = assertText(id, 'followUpId', { maxLength: 64 });
    const nextStatus = assertOneOf(status, FOLLOW_UP_STATUSES, 'status');
    const update = this.db.transaction((): FollowUp => {
      const existing = this.requireFollowUp(followUpId);
      if (!isValidFollowUpTransition(existing.status, nextStatus)) {
        throw new StoreError(
          'INVALID_TRANSITION',
          `Follow-up ${followUpId} cannot move from ${existing.status} to ${nextStatus}.`,
          {
            followUpId,
            from: existing.status,
            to: nextStatus,
            allowed: FOLLOW_UP_STATUSES.filter((candidate) => isValidFollowUpTransition(existing.status, candidate)),
          },
        );
      }
      const timestamp = nowIso();
      const completedAt = nextStatus === 'done' ? timestamp : null;
      this.db
        .prepare(
          `UPDATE follow_ups
              SET status = @status, completed_at = @completedAt, updated_at = @updatedAt
            WHERE id = @id`,
        )
        .run({ id: followUpId, status: nextStatus, completedAt, updatedAt: timestamp });
      this.insertActivity({
        entityType: 'follow_up',
        entityId: followUpId,
        clientId: existing.clientId,
        action: 'status_changed',
        detail: describeFollowUpStatusChange(
          existing,
          { fullName: existing.clientName },
          existing.status,
          nextStatus,
        ),
        createdAt: timestamp,
      });
      return this.requireFollowUp(followUpId);
    });
    return update.immediate();
  }

  /* ---------------------------------------------------------------- dashboard */

  getDashboard(): DashboardData {
    const today = resolveToday();
    const counts = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM appointments WHERE date = @today) AS today_appointments,
           (SELECT COUNT(*) FROM appointments WHERE date = @today AND status = 'confirmed') AS confirmed_today,
           (SELECT COUNT(*) FROM appointments WHERE date = @today AND status = 'checked_in') AS checked_in_today,
           (SELECT COUNT(*) FROM appointments WHERE date = @today AND status = 'completed') AS completed_today,
           (SELECT COUNT(*) FROM appointments WHERE date = @today AND status = 'cancelled') AS cancelled_today,
           (SELECT COUNT(*) FROM appointments WHERE date = @today AND status = 'no_show') AS no_show_today,
           (SELECT COUNT(*) FROM follow_ups WHERE status IN ('open', 'in_progress')) AS open_follow_ups,
           (SELECT COUNT(*) FROM follow_ups
              WHERE status IN ('open', 'in_progress') AND due_date < @today) AS overdue_follow_ups,
           (SELECT COALESCE(SUM(capacity), 0) FROM clinic_sessions WHERE date = @today) AS total_capacity,
           (SELECT COUNT(*) FROM appointments
              WHERE date = @today AND status IN (${CAPACITY_STATUS_SQL})) AS booked_capacity`,
      )
      .get({ today }) as {
      today_appointments: number;
      confirmed_today: number;
      checked_in_today: number;
      completed_today: number;
      cancelled_today: number;
      no_show_today: number;
      open_follow_ups: number;
      overdue_follow_ups: number;
      total_capacity: number;
      booked_capacity: number;
    };

    const metrics: DashboardMetrics = {
      todayAppointments: counts.today_appointments,
      confirmedToday: counts.confirmed_today,
      checkedInToday: counts.checked_in_today,
      completedToday: counts.completed_today,
      cancelledToday: counts.cancelled_today,
      noShowToday: counts.no_show_today,
      openFollowUps: counts.open_follow_ups,
      overdueFollowUps: counts.overdue_follow_ups,
      totalSessionCapacity: counts.total_capacity,
      bookedCapacity: counts.booked_capacity,
      availableCapacity: Math.max(0, counts.total_capacity - counts.booked_capacity),
      completionRate:
        counts.booked_capacity === 0
          ? 0
          : Math.round((counts.completed_today / counts.booked_capacity) * 100) / 100,
    };

    const upcomingAppointments = (
      this.stmt(
        `${APPOINTMENT_SELECT}
          WHERE a.date >= :today AND a.status IN ('requested', 'confirmed', 'checked_in')
          ORDER BY a.date, a.start_time, a.id
          LIMIT 25`,
      ).all({ today }) as AppointmentRow[]
    ).map(mapAppointment);

    const openFollowUps = this.listFollowUps()
      .filter((followUp) => isOpenFollowUpStatus(followUp.status))
      .slice(0, 25);
    const overdueFollowUps = openFollowUps.filter((followUp) => followUp.overdue);

    const sessions = (
      this.stmt(`${SESSION_SELECT} WHERE s.date >= :today ORDER BY s.date, s.start_time LIMIT 20`).all({
        today,
      }) as SessionRow[]
    ).map(mapSession);

    return { today, metrics, upcomingAppointments, openFollowUps, overdueFollowUps, sessions };
  }

  /* --------------------------------------------------------------------- CSV */

  exportCsv(entity: CsvEntity): string {
    const kind = assertOneOf(entity, ['clients', 'appointments', 'follow_ups'] as const, 'entity');
    if (kind === 'clients') {
      const headers = [
        'id',
        'full_name',
        'email',
        'phone',
        'date_of_birth',
        'status',
        'notes',
        'created_at',
        'updated_at',
      ];
      return toCsv(
        headers,
        this.listClients().map((client) => [
          client.id,
          client.fullName,
          client.email,
          client.phone,
          client.dateOfBirth,
          client.status,
          client.notes,
          client.createdAt,
          client.updatedAt,
        ]),
      );
    }
    if (kind === 'appointments') {
      const headers = [
        'id',
        'date',
        'start_time',
        'end_time',
        'status',
        'client_id',
        'client_name',
        'provider_id',
        'provider_name',
        'session_id',
        'reason',
        'notes',
        'created_at',
        'updated_at',
      ];
      return toCsv(
        headers,
        this.listAppointments().map((appointment) => [
          appointment.id,
          appointment.date,
          appointment.startTime,
          appointment.endTime,
          appointment.status,
          appointment.clientId,
          appointment.clientName,
          appointment.providerId,
          appointment.providerName,
          appointment.sessionId,
          appointment.reason,
          appointment.notes,
          appointment.createdAt,
          appointment.updatedAt,
        ]),
      );
    }
    const headers = [
      'id',
      'client_id',
      'client_name',
      'assignee_id',
      'assignee_name',
      'title',
      'detail',
      'status',
      'due_date',
      'overdue',
      'completed_at',
      'created_at',
      'updated_at',
    ];
    return toCsv(
      headers,
      this.listFollowUps().map((followUp) => [
        followUp.id,
        followUp.clientId,
        followUp.clientName,
        followUp.assigneeId,
        followUp.assigneeName,
        followUp.title,
        followUp.detail,
        followUp.status,
        followUp.dueDate,
        followUp.overdue,
        followUp.completedAt,
        followUp.createdAt,
        followUp.updatedAt,
      ]),
    );
  }

  /* ------------------------------------------------------------------ import */

  importClients(input: ImportClientsInput): ImportClientsResult {
    if (input === null || typeof input !== 'object' || !Array.isArray(input.clients)) {
      throw new StoreError('VALIDATION', 'clients must be an array of client rows.', { field: 'clients' });
    }
    if (input.clients.length === 0) {
      throw new StoreError('VALIDATION', 'clients must contain at least one row.', { field: 'clients' });
    }
    const mode: ImportMode = assertOneOf(input.mode ?? 'skip', ['skip', 'fail'] as const, 'mode');

    const rows = input.clients.map((record, index) => {
      try {
        return {
          index,
          fullName: cleanWhitespace(record?.fullName, 'fullName', { maxLength: 120 }),
          email: optionalEmail(record?.email, 'email'),
          phone: assertText(record?.phone, 'phone', { maxLength: 40 }),
          dateOfBirth: assertIsoDate(record?.dateOfBirth, 'dateOfBirth'),
          status: assertOneOf(record?.status ?? 'active', CLIENT_STATUSES, 'status'),
          notes: optionalText(record?.notes, 'notes', { maxLength: 1000 }),
        };
      } catch (error) {
        if (isStoreError(error)) {
          throw new StoreError(error.code, `Client import row ${index + 1}: ${error.message}`, {
            row: index + 1,
            field: (error.details?.field as string | undefined) ?? null,
          });
        }
        throw error;
      }
    });

    const importRows = this.db.transaction((): ImportClientsResult => {
      const knownEmails = new Set<string>();
      for (const row of this.db.prepare('SELECT email FROM clients WHERE email IS NOT NULL').all() as {
        email: string;
      }[]) {
        knownEmails.add(normalizeEmail(row.email));
      }
      const knownNames = new Set<string>();
      for (const row of this.db.prepare('SELECT full_name FROM clients').all() as { full_name: string }[]) {
        knownNames.add(normalizeName(row.full_name));
      }

      const created: Client[] = [];
      let skipped = 0;
      const timestamp = nowIso();
      for (const row of rows) {
        const normalizedName = normalizeName(row.fullName);
        const duplicateEmail = row.email !== null && knownEmails.has(row.email);
        const duplicateName = knownNames.has(normalizedName);
        if (duplicateEmail || duplicateName) {
          const reason = duplicateEmail && duplicateName ? 'email and name' : duplicateEmail ? 'email' : 'name';
          if (mode === 'fail') {
            throw new StoreError(
              'CONFLICT',
              `Client import row ${row.index + 1} duplicates an existing client by ${reason}.`,
              { row: row.index + 1, reason, email: row.email, fullName: row.fullName },
            );
          }
          skipped += 1;
          continue;
        }
        const client = this.insertClient(
          {
            fullName: row.fullName,
            email: row.email,
            phone: row.phone,
            dateOfBirth: row.dateOfBirth,
            status: row.status,
            notes: row.notes,
          },
          'import',
          timestamp,
        );
        if (row.email !== null) knownEmails.add(row.email);
        knownNames.add(normalizedName);
        created.push(client);
      }
      return { created, skipped };
    });
    return importRows.immediate();
  }

  /* ---------------------------------------------------------------- internals */

  private stmt(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private nextId(prefix: string, table: 'clients' | 'appointments' | 'follow_ups'): string {
    const rows = this.db.prepare(`SELECT id FROM ${table} WHERE id LIKE ?`).all(`${prefix}-%`) as { id: string }[];
    let max = 0;
    for (const row of rows) {
      const parsed = Number.parseInt(row.id.slice(prefix.length + 1), 10);
      if (Number.isFinite(parsed) && parsed > max) max = parsed;
    }
    return `${prefix}-${String(max + 1).padStart(4, '0')}`;
  }

  private findClientByEmail(email: string): ClientRow | undefined {
    return this.db.prepare('SELECT * FROM clients WHERE email = ?').get(email) as ClientRow | undefined;
  }

  private requireClient(id: string): ClientRow {
    const row = this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow | undefined;
    if (row === undefined) {
      throw new StoreError('NOT_FOUND', `Client ${id} was not found.`, { clientId: id });
    }
    return row;
  }

  private requireProvider(id: string): ProviderRow {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
    if (row === undefined) {
      throw new StoreError('NOT_FOUND', `Provider ${id} was not found.`, { providerId: id });
    }
    return row;
  }

  private requireSession(id: string): SessionRow {
    const row = this.stmt(`${SESSION_SELECT} WHERE s.id = :id`).get({ id }) as SessionRow | undefined;
    if (row === undefined) {
      throw new StoreError('NOT_FOUND', `Clinic session ${id} was not found.`, { sessionId: id });
    }
    return row;
  }

  private requireAppointment(id: string): Appointment {
    const row = this.stmt(`${APPOINTMENT_SELECT} WHERE a.id = :id`).get({ id }) as AppointmentRow | undefined;
    if (row === undefined) {
      throw new StoreError('NOT_FOUND', `Appointment ${id} was not found.`, { appointmentId: id });
    }
    return mapAppointment(row);
  }

  private requireFollowUp(id: string): FollowUp {
    const row = this.stmt(`${FOLLOW_UP_SELECT} WHERE f.id = :id`).get({ id }) as FollowUpRow | undefined;
    if (row === undefined) {
      throw new StoreError('NOT_FOUND', `Follow-up ${id} was not found.`, { followUpId: id });
    }
    return mapFollowUp(row, resolveToday());
  }

  private insertClient(
    input: {
      fullName: string;
      email: string | null;
      phone: string;
      dateOfBirth: string;
      status: ClientStatus;
      notes: string | null;
    },
    source: 'manual' | 'import',
    timestamp: string,
  ): Client {
    const id = this.nextId('cli', 'clients');
    try {
      this.db
        .prepare(
          `INSERT INTO clients (id, full_name, email, phone, date_of_birth, status, notes, created_at, updated_at)
           VALUES (@id, @fullName, @email, @phone, @dateOfBirth, @status, @notes, @createdAt, @updatedAt)`,
        )
        .run({ id, ...input, createdAt: timestamp, updatedAt: timestamp });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StoreError('CONFLICT', `A client with the email ${input.email ?? id} already exists.`, {
          field: 'email',
          email: input.email,
        });
      }
      throw error;
    }
    this.insertActivity({
      entityType: 'client',
      entityId: id,
      clientId: id,
      action: 'created',
      detail: describeClientCreated(input, source),
      createdAt: timestamp,
    });
    const row = this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow;
    return mapClient(row);
  }

  private insertActivity(event: {
    entityType: ActivityEntityType;
    entityId: string;
    clientId: string | null;
    action: string;
    detail: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO activity_events (entity_type, entity_id, client_id, action, detail, created_at)
         VALUES (@entityType, @entityId, @clientId, @action, @detail, @createdAt)`,
      )
      .run(event);
  }

  private findBlockingConflicts(input: {
    date: string;
    startTime: string;
    endTime: string;
    clientId: string;
    providerId: string;
  }): { kind: 'client' | 'provider'; id: string; name: string; startTime: string; endTime: string }[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.client_id, a.provider_id, a.start_time, a.end_time,
                c.full_name AS client_name, p.name AS provider_name
           FROM appointments a
           JOIN clients c ON c.id = a.client_id
           JOIN providers p ON p.id = a.provider_id
          WHERE a.date = @date
            AND a.status IN (${BLOCKING_STATUS_SQL})
            AND (a.client_id = @clientId OR a.provider_id = @providerId)
            AND a.start_time < @endTime
            AND @startTime < a.end_time`,
      )
      .all(input) as {
      id: string;
      client_id: string;
      provider_id: string;
      start_time: string;
      end_time: string;
      client_name: string;
      provider_name: string;
    }[];
    const conflicts: {
      kind: 'client' | 'provider';
      id: string;
      name: string;
      startTime: string;
      endTime: string;
    }[] = [];
    for (const row of rows) {
      if (!timesOverlap(input.startTime, input.endTime, row.start_time, row.end_time)) continue;
      if (row.provider_id === input.providerId) {
        conflicts.push({
          kind: 'provider',
          id: row.provider_id,
          name: row.provider_name,
          startTime: row.start_time,
          endTime: row.end_time,
        });
      }
      if (row.client_id === input.clientId) {
        conflicts.push({
          kind: 'client',
          id: row.client_id,
          name: row.client_name,
          startTime: row.start_time,
          endTime: row.end_time,
        });
      }
    }
    return conflicts;
  }
}

/**
 * Builds the store over an existing connection. The connection may come from
 * `createDatabase` or from a test that opened `:memory:` directly; the schema
 * is applied defensively in both cases.
 */
export function createStore(db: Database.Database): Store {
  return new SqliteStore(db);
}

export { StoreError, isStoreError };
export type {
  ActivityEvent,
  Appointment,
  AppointmentStatus,
  Client,
  ClientDetail,
  ClientStatus,
  ClientSummary,
  ClinicSession,
  DashboardData,
  DashboardMetrics,
  FollowUp,
  FollowUpStatus,
  Provider,
};
