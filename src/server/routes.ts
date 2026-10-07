/**
 * Caregrid HTTP routes.
 *
 * The SQLite store speaks the clinic's storage vocabulary (`fullName`,
 * `bookedCapacity`, `requested`) while `src/shared/types.ts` defines the public
 * JSON contract (`firstName`/`lastName`, `opensAt`/`closesAt`, `type`). The
 * mappers in this file translate between the two in one place, and
 * `api_record_extras` persists the handful of contract fields the store schema
 * does not model yet (client consent/preferred name/contact preference,
 * appointment type, follow-up priority) so a write and the following read agree.
 *
 * Every request body and query string is parsed with the shared Zod schemas,
 * every storage error keeps its domain code (`NOT_FOUND` -> 404, `CONFLICT` /
 * `INVALID_TRANSITION` -> 409, `VALIDATION` -> 400), and every response is JSON
 * except the CSV export.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_TYPES,
  CLIENT_CONSENT_STATUSES,
  FOLLOW_UP_PRIORITIES,
  FOLLOW_UP_STATUSES,
  PROVIDER_ROLES,
} from '../shared/constants.js';
import {
  PREFERRED_CONTACTS,
  appointmentStatusPatchSchema,
  appointmentListQuerySchema,
  clientImportSchema,
  clientListQuerySchema,
  createAppointmentSchema,
  createClientSchema,
  createFollowUpSchema,
  followUpListQuerySchema,
  followUpStatusPatchSchema,
  nonBlankIdSchema,
  searchQuerySchema,
  sessionListQuerySchema,
} from '../shared/schemas.js';
import type {
  Appointment,
  AppointmentStatus,
  AppointmentType,
  ClientConsentStatus,
  ClinicSession,
  ClientStatus,
  DashboardData,
  FollowUp,
  FollowUpPriority,
  FollowUpStatus,
  Provider,
  ProviderRole,
} from '../shared/types.js';
import { ApiError } from './errors.js';
import type { Store } from './store.js';

/* -------------------------------------------------------------------------- */
/* Store façade types                                                          */
/* -------------------------------------------------------------------------- */

type StoreClientQuery = NonNullable<Parameters<Store['listClients']>[0]>;
type StoreAppointmentQuery = NonNullable<Parameters<Store['listAppointments']>[0]>;
type StoreFollowUpQuery = NonNullable<Parameters<Store['listFollowUps']>[0]>;
type StoreClientInput = Parameters<Store['createClient']>[0];
type StoreAppointmentInput = Parameters<Store['createAppointment']>[0];
type StoreFollowUpInput = Parameters<Store['createFollowUp']>[0];
type StoreImportRow = Parameters<Store['importClients']>[0]['clients'][number];
type CsvEntity = Parameters<Store['exportCsv']>[0];

/** Date sent to the storage layer when a caller does not know a birth date. */
const UNKNOWN_DATE_OF_BIRTH = '1900-01-01';

/** Visible placeholder for a client that has no phone number on file. */
const UNKNOWN_PHONE = 'not provided';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Tolerant readers                                                            */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function str(record: Json, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function nullableStr(record: Json, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function num(record: Json, fallback: number, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return fallback;
}

function bool(record: Json, fallback: boolean, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === 'true') return true;
    if (value === 0 || value === 'false') return false;
  }
  return fallback;
}

function asList(value: unknown): Json[] {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  for (const key of ['items', 'data', 'results', 'rows', 'created']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate.map(asRecord);
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Extras: contract fields the storage schema does not model                   */
/* -------------------------------------------------------------------------- */

/** Minimal structural view of the better-sqlite3 handle used for extras. */
export interface SqliteHandle {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Per-record extra fields, keyed by entity name and record id. */
export interface RecordExtras {
  get(entity: string, id: string): Json;
  list(entity: string): Map<string, Json>;
  set(entity: string, id: string, patch: Json): void;
}

const EXTRAS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS api_record_extras (
  entity     TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity, record_id)
);
`;

function memoryExtras(): RecordExtras {
  const store = new Map<string, Map<string, Json>>();
  const bucket = (entity: string): Map<string, Json> => {
    let existing = store.get(entity);
    if (existing === undefined) {
      existing = new Map<string, Json>();
      store.set(entity, existing);
    }
    return existing;
  };
  return {
    get: (entity, id) => bucket(entity).get(id) ?? {},
    list: (entity) => new Map(bucket(entity)),
    set: (entity, id, patch) => {
      const merged = { ...bucket(entity).get(id), ...patch };
      bucket(entity).set(id, merged);
    },
  };
}

/**
 * Opens the API-side extension table. Falls back to process memory when no
 * SQLite handle is available (for example a test that injects its own store).
 */
export function createRecordExtras(database: unknown): RecordExtras {
  const handle = database as SqliteHandle | undefined;
  if (handle === undefined || typeof handle.exec !== 'function') return memoryExtras();
  try {
    handle.exec(EXTRAS_TABLE_SQL);
  } catch {
    return memoryExtras();
  }
  const statement = (): ReturnType<SqliteHandle['prepare']> =>
    handle.prepare('SELECT data FROM api_record_extras WHERE entity = ? AND record_id = ?');
  const allStatement = (): ReturnType<SqliteHandle['prepare']> =>
    handle.prepare('SELECT record_id, data FROM api_record_extras WHERE entity = ?');
  const writeStatement = (): ReturnType<SqliteHandle['prepare']> =>
    handle.prepare(
      `INSERT INTO api_record_extras (entity, record_id, data, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(entity, record_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    );
  const parse = (value: unknown): Json => {
    if (typeof value !== 'string') return {};
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  };
  return {
    get: (entity, id) => {
      const row = asRecord(statement().get(entity, id));
      return parse(row.data);
    },
    list: (entity) => {
      const rows = allStatement().all(entity);
      const entries = new Map<string, Json>();
      for (const row of rows) {
        const record = asRecord(row);
        entries.set(str(record, 'record_id'), parse(record.data));
      }
      return entries;
    },
    set: (entity, id, patch) => {
      const current = parse(asRecord(statement().get(entity, id)).data);
      writeStatement().run(
        entity,
        id,
        JSON.stringify({ ...current, ...patch }),
        new Date().toISOString(),
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/* View models                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Client payload. `waitlist` is part of the clinic vocabulary the store keeps
 * and is returned verbatim instead of being flattened into `archived`.
 */
interface ClientView {
  id: string;
  firstName: string;
  lastName: string;
  preferredName: string;
  phone: string;
  email: string | null;
  preferredContact: string;
  accessNotes: string;
  consentStatus: ClientConsentStatus;
  status: ClientStatus | 'waitlist';
  createdAt: string;
  updatedAt: string;
  dateOfBirth: string | null;
}

interface ProviderView extends Provider {
  email: string;
  phone: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionView extends ClinicSession {
  startTime: string;
  endTime: string;
  booked: number;
  remaining: number;
  utilization: number;
  leadProviderId: string | null;
  leadProviderName: string | null;
  notes: string | null;
}

interface AppointmentView extends Appointment {
  sessionDate: string;
}

interface FollowUpView extends FollowUp {
  detail: string;
  overdue: boolean;
  completedAt: string | null;
}

interface ActivityView {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  detail: string;
  createdAt: string;
}

interface ClientDetailView {
  client: ClientView;
  summary: Json;
  appointments: AppointmentView[];
  followUps: FollowUpView[];
  activity: ActivityView[];
}

interface DashboardMetricsView {
  activeClients: number;
  appointmentsToday: number;
  todayAppointments: number;
  completedToday: number;
  openFollowUps: number;
  overdueFollowUps: number;
  availableCapacityToday: number;
  capacityTotal: number;
  capacityBooked: number;
  booked: number;
  capacity: number;
  remaining: number;
  completionRate: number;
  completionPercent: number;
  byStatus: Record<string, number>;
}

interface DashboardView extends Omit<DashboardData, 'metrics'> {
  today: string;
  metrics: DashboardMetricsView;
  overdueFollowUps: FollowUpView[];
}

/* -------------------------------------------------------------------------- */
/* Mappers                                                                     */
/* -------------------------------------------------------------------------- */

const ROLE_ALIASES: Record<string, ProviderRole> = {
  physician: 'physician',
  doctor: 'physician',
  dr: 'physician',
  nurse: 'nurse',
  nurse_practitioner: 'nurse_practitioner',
  np: 'nurse_practitioner',
  medical_assistant: 'medical_assistant',
  ma: 'medical_assistant',
  community_health_worker: 'community_health_worker',
  chw: 'community_health_worker',
  counselor: 'counselor',
  counsellor: 'counselor',
  coordinator: 'coordinator',
  care_coordinator: 'coordinator',
  clinic_coordinator: 'coordinator',
  other: 'other',
};

const PROVIDER_COLORS = ['#2563eb', '#0f766e', '#b45309', '#7c3aed', '#be123c', '#0369a1'];

function providerRole(value: string): ProviderRole {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (ROLE_ALIASES[key] !== undefined) return ROLE_ALIASES[key] as ProviderRole;
  return PROVIDER_ROLES.includes(key as ProviderRole) ? (key as ProviderRole) : 'other';
}

function providerColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return PROVIDER_COLORS[hash % PROVIDER_COLORS.length] ?? '#2563eb';
}

function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  if (trimmed === '') return { firstName: '', lastName: '' };
  const parts = trimmed.split(/\s+/);
  const first = parts.shift() ?? '';
  return { firstName: first, lastName: parts.join(' ') };
}

function consentValue(value: string): ClientConsentStatus {
  const match = CLIENT_CONSENT_STATUSES.find((candidate) => candidate === value);
  if (match !== undefined) return match;
  if (value.toLowerCase() === 'granted') return 'granted';
  if (value.toLowerCase() === 'declined') return 'declined';
  return 'pending';
}

function clientStatusValue(value: string): ClientStatus | 'waitlist' {
  if (value === 'active' || value === 'archived' || value === 'waitlist') return value;
  if (value === 'inactive') return 'archived';
  return 'active';
}

function storeClientStatus(
  value: ClientStatus | 'waitlist' | undefined,
): StoreClientQuery['status'] {
  if (value === 'archived') return 'inactive';
  return value as StoreClientQuery['status'];
}

function appointmentStatusValue(value: string): AppointmentStatus {
  const match = APPOINTMENT_STATUSES.find((candidate) => candidate === value);
  if (match !== undefined) return match;
  if (value === 'scheduled') return 'requested';
  return 'requested';
}

function appointmentTypeValue(value: string): AppointmentType {
  const match = APPOINTMENT_TYPES.find((candidate) => candidate === value);
  return match ?? 'other';
}

function followUpStatusValue(value: string): FollowUpStatus {
  const match = FOLLOW_UP_STATUSES.find((candidate) => candidate === value);
  return match ?? 'open';
}

function followUpPriorityValue(value: string): FollowUpPriority {
  const match = FOLLOW_UP_PRIORITIES.find((candidate) => candidate === value);
  return match ?? 'normal';
}

/** Unknown or missing stored values fall back to the clinic's phone default. */
function preferredContactValue(value: string): string {
  const match = PREFERRED_CONTACTS.find((candidate) => candidate === value);
  return match ?? 'phone';
}

function mapClient(raw: unknown, extras: Json = {}): ClientView {
  const record = asRecord(raw);
  const names = splitFullName(str(record, 'fullName', 'name'));
  const email = nullableStr(record, 'email');
  const dateOfBirth = str(record, 'dateOfBirth', 'date_of_birth') || str(extras, 'dateOfBirth');
  return {
    id: str(record, 'id'),
    firstName: str(record, 'firstName') || names.firstName,
    lastName: str(record, 'lastName') || names.lastName,
    preferredName: str(record, 'preferredName') || str(extras, 'preferredName'),
    phone: str(record, 'phone'),
    email: email === null || email.trim() === '' ? null : email,
    preferredContact: preferredContactValue(str(extras, 'preferredContact')),
    accessNotes: str(record, 'accessNotes', 'notes'),
    consentStatus: consentValue(str(record, 'consentStatus') || str(extras, 'consentStatus')),
    status: clientStatusValue(str(record, 'status')),
    createdAt: str(record, 'createdAt', 'created_at'),
    updatedAt: str(record, 'updatedAt', 'updated_at'),
    dateOfBirth: dateOfBirth === '' || dateOfBirth === UNKNOWN_DATE_OF_BIRTH ? null : dateOfBirth,
  };
}

function mapProvider(raw: unknown): ProviderView {
  const record = asRecord(raw);
  const id = str(record, 'id');
  return {
    id,
    name: str(record, 'name', 'fullName') || 'Care provider',
    role: providerRole(str(record, 'role')),
    color: str(record, 'color') || providerColor(id),
    active: bool(record, true, 'active'),
    email: str(record, 'email'),
    phone: nullableStr(record, 'phone'),
    createdAt: str(record, 'createdAt', 'created_at'),
    updatedAt: str(record, 'updatedAt', 'updated_at'),
  };
}

function mapSession(raw: unknown): SessionView {
  const record = asRecord(raw);
  const capacity = num(record, 0, 'capacity');
  const booked = num(record, num(record, 0, 'booked'), 'bookedCapacity', 'booked');
  const remaining = num(record, Math.max(0, capacity - booked), 'availableCapacity', 'remaining');
  const startTime = str(record, 'startTime', 'opensAt', 'startsAt');
  const endTime = str(record, 'endTime', 'closesAt', 'endsAt');
  return {
    id: str(record, 'id'),
    date: str(record, 'date', 'sessionDate'),
    location: str(record, 'location'),
    capacity,
    opensAt: str(record, 'opensAt') || startTime,
    closesAt: str(record, 'closesAt') || endTime,
    startTime,
    endTime,
    booked,
    remaining,
    utilization: capacity === 0 ? 0 : Math.round((booked / capacity) * 100) / 100,
    leadProviderId: nullableStr(record, 'leadProviderId'),
    leadProviderName: nullableStr(record, 'leadProviderName'),
    notes: nullableStr(record, 'notes'),
  };
}

function mapAppointment(
  raw: unknown,
  extras: Json = {},
  locations: Map<string, string> = new Map<string, string>(),
): AppointmentView {
  const record = asRecord(raw);
  const sessionId = str(record, 'sessionId');
  const date = str(record, 'date', 'sessionDate');
  return {
    id: str(record, 'id'),
    clientId: str(record, 'clientId'),
    providerId: str(record, 'providerId'),
    sessionId,
    date,
    startTime: str(record, 'startTime'),
    endTime: str(record, 'endTime'),
    type: appointmentTypeValue(str(record, 'type') || str(extras, 'type')),
    reason: str(record, 'reason'),
    notes: str(record, 'notes'),
    status: appointmentStatusValue(str(record, 'status')),
    createdAt: str(record, 'createdAt', 'created_at'),
    updatedAt: str(record, 'updatedAt', 'updated_at'),
    clientName: str(record, 'clientName'),
    providerName: str(record, 'providerName'),
    location: str(record, 'location') || locations.get(sessionId) || '',
    sessionDate: str(record, 'sessionDate') || date,
  };
}

function mapFollowUp(raw: unknown, extras: Json = {}): FollowUpView {
  const record = asRecord(raw);
  return {
    id: str(record, 'id'),
    clientId: str(record, 'clientId'),
    appointmentId: nullableStr(record, 'appointmentId'),
    assigneeId: str(record, 'assigneeId'),
    title: str(record, 'title'),
    dueDate: str(record, 'dueDate', 'due_date'),
    priority: followUpPriorityValue(str(record, 'priority') || str(extras, 'priority')),
    status: followUpStatusValue(str(record, 'status')),
    notes: str(record, 'notes', 'detail'),
    createdAt: str(record, 'createdAt', 'created_at'),
    updatedAt: str(record, 'updatedAt', 'updated_at'),
    clientName: str(record, 'clientName'),
    assigneeName: str(record, 'assigneeName'),
    detail: str(record, 'detail', 'notes'),
    overdue: bool(record, false, 'overdue'),
    completedAt: nullableStr(record, 'completedAt'),
  };
}

function mapActivity(raw: unknown): ActivityView {
  const record = asRecord(raw);
  return {
    id: str(record, 'id'),
    entityType: str(record, 'entityType', 'entity_type'),
    entityId: str(record, 'entityId', 'entity_id'),
    action: str(record, 'action'),
    detail: str(record, 'detail'),
    createdAt: str(record, 'createdAt', 'created_at'),
  };
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, label: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError('VALIDATION', `${label} is invalid.`, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data as z.infer<T>;
}

const clientQuerySchema = clientListQuerySchema.extend({
  search: searchQuerySchema,
  status: z.enum(['active', 'archived', 'waitlist']).optional(),
});

const exportEntityAliases: Record<string, CsvEntity> = {
  clients: 'clients',
  appointments: 'appointments',
  follow_ups: 'follow_ups',
  'follow-ups': 'follow_ups',
  followups: 'follow_ups',
};

/* -------------------------------------------------------------------------- */
/* Route registration                                                          */
/* -------------------------------------------------------------------------- */

export interface RouteDependencies {
  store: Store;
  extras: RecordExtras;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const parsed = Date.parse(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return isoDate;
  return new Date(parsed + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Registers every Caregrid API route on the given instance. Kept free of
 * Fastify instance configuration so tests can call it on a bare instance.
 */
export function registerRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  const { store, extras } = dependencies;

  const sessionsById = (): Map<string, string> => {
    const locations = new Map<string, string>();
    for (const session of asList(store.listSessions() as unknown)) {
      locations.set(str(session, 'id'), str(session, 'location'));
    }
    return locations;
  };

  const appointmentView = (raw: unknown, locations: Map<string, string>): AppointmentView => {
    const record = asRecord(raw);
    return mapAppointment(raw, extras.get('appointment', str(record, 'id')), locations);
  };

  const followUpView = (raw: unknown): FollowUpView => {
    const record = asRecord(raw);
    return mapFollowUp(raw, extras.get('follow_up', str(record, 'id')));
  };

  const clientIdParam = (request: FastifyRequest): string => {
    const params = parse(z.object({ id: nonBlankIdSchema }), request.params, 'Client id');
    return params.id;
  };

  /* ------------------------------------------------------------------ health */

  app.get('/api/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Cheap probe: a broken or unwritable database must not report as healthy.
      store.listProviders();
    } catch (error) {
      app.log.error({ err: error }, 'health check failed');
      return reply.status(503).send({
        error: { code: 'INTERNAL', message: 'The clinic database is unavailable.' },
      });
    }
    return reply.send({ status: 'ok', storage: 'sqlite' });
  });

  /* --------------------------------------------------------------- dashboard */

  app.get('/api/dashboard', async (_request: FastifyRequest, reply: FastifyReply) => {
    const raw = asRecord(store.getDashboard() as unknown);
    const metrics = asRecord(raw.metrics);
    const today = str(raw, 'today', 'date') || todayIso();
    const locations = sessionsById();
    const activeClients = store.listClients({ status: 'active' }).length;
    const totalCapacity = num(metrics, 0, 'totalSessionCapacity', 'capacity');
    const bookedCapacity = num(metrics, 0, 'bookedCapacity', 'booked');
    const availableCapacity = num(
      metrics,
      Math.max(0, totalCapacity - bookedCapacity),
      'availableCapacity',
      'remaining',
    );
    const completedToday = num(metrics, 0, 'completedToday');
    const completionRate =
      num(metrics, bookedCapacity === 0 ? 0 : completedToday / bookedCapacity, 'completionRate') ||
      0;
    const appointmentsToday = num(metrics, 0, 'todayAppointments', 'appointmentsToday');
    const confirmedToday = num(metrics, 0, 'confirmedToday');
    const checkedInToday = num(metrics, 0, 'checkedInToday');
    const cancelledToday = num(metrics, 0, 'cancelledToday');
    const noShowToday = num(metrics, 0, 'noShowToday');
    // The store counts every status except `requested`; derive it so the
    // breakdown always adds up to today's appointment total.
    const requestedToday = Math.max(
      0,
      appointmentsToday -
        confirmedToday -
        checkedInToday -
        completedToday -
        cancelledToday -
        noShowToday,
    );
    const byStatus: Record<string, number> = {
      requested: requestedToday,
      confirmed: confirmedToday,
      checked_in: checkedInToday,
      completed: completedToday,
      cancelled: cancelledToday,
      no_show: noShowToday,
    };
    const payload: DashboardView = {
      asOfDate: today,
      today,
      metrics: {
        activeClients,
        appointmentsToday,
        todayAppointments: appointmentsToday,
        completedToday,
        openFollowUps: num(metrics, 0, 'openFollowUps'),
        overdueFollowUps: num(metrics, 0, 'overdueFollowUps'),
        availableCapacityToday: availableCapacity,
        capacityTotal: totalCapacity,
        capacityBooked: bookedCapacity,
        booked: bookedCapacity,
        capacity: totalCapacity,
        remaining: availableCapacity,
        completionRate,
        completionPercent: Math.round(completionRate * 1000) / 10,
        byStatus,
      },
      upcomingAppointments: asList(raw.upcomingAppointments).map((entry) =>
        appointmentView(entry, locations),
      ),
      followUps: asList(raw.openFollowUps).map((entry) => followUpView(entry)),
      overdueFollowUps: asList(raw.overdueFollowUps).map((entry) => followUpView(entry)),
      sessions: asList(raw.sessions).map(mapSession),
    };
    return reply.send(payload);
  });

  /* --------------------------------------------------------------- providers */

  app.get('/api/providers', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send((store.listProviders() as unknown[]).map(mapProvider));
  });

  const listSessions = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parse(sessionListQuerySchema, request.query, 'Session query');
    const from = query.from;
    const to = query.to;
    let sessions = (store.listSessions(query.date) as unknown[]).map(mapSession);
    if (from !== undefined) sessions = sessions.filter((session) => session.date >= from);
    if (to !== undefined) sessions = sessions.filter((session) => session.date <= to);
    return reply.send(sessions);
  };

  app.get('/api/sessions', listSessions);

  /* ----------------------------------------------------------------- clients */

  app.get('/api/clients', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parse(clientQuerySchema, request.query, 'Client query');
    const filters: StoreClientQuery = {
      search: query.search ?? query.q,
      status: storeClientStatus(query.status),
    };
    const clients = (store.listClients(filters) as unknown[]).map((entry) => {
      const id = str(asRecord(entry), 'id');
      return mapClient(entry, extras.get('client', id));
    });
    return reply.send(clients);
  });

  app.get('/api/clients/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = clientIdParam(request);
    const raw = asRecord(store.getClientDetail(id) as unknown);
    const locations = sessionsById();
    const detail: ClientDetailView = {
      client: mapClient(raw.client, extras.get('client', id)),
      summary: asRecord(raw.summary),
      appointments: asList(raw.appointments).map((entry) => appointmentView(entry, locations)),
      followUps: asList(raw.followUps).map((entry) => followUpView(entry)),
      activity: asList(raw.activity).map(mapActivity),
    };
    return reply.send(detail);
  });

  app.post('/api/clients', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parse(createClientSchema, request.body, 'Client payload');
    const name = [body.firstName ?? '', body.lastName ?? ''].filter(Boolean).join(' ').trim();
    const fullName = name !== '' ? name : body.fullName;
    if (fullName === '') {
      throw new ApiError('VALIDATION', 'Client payload is invalid.', {
        issues: [{ path: 'lastName', message: 'Last name is required' }],
      });
    }
    const input: StoreClientInput = {
      fullName,
      email: body.email,
      phone: body.phone,
      dateOfBirth: body.dateOfBirth ?? UNKNOWN_DATE_OF_BIRTH,
      status: storeClientStatus(body.status) as StoreClientInput['status'],
      notes: body.accessNotes !== '' ? body.accessNotes : body.notes,
    };
    const created = asRecord(store.createClient(input) as unknown);
    const id = str(created, 'id');
    const consent = body.consentStatus ?? (body.consentGranted === true ? 'granted' : undefined);
    extras.set('client', id, {
      ...(consent === undefined ? {} : { consentStatus: consent }),
      ...(body.preferredName === '' ? {} : { preferredName: body.preferredName }),
      ...(body.dateOfBirth === undefined ? {} : { dateOfBirth: body.dateOfBirth }),
      preferredContact: body.preferredContact,
    });
    reply.code(201).header('location', `/api/clients/${id}`);
    return reply.send(mapClient(created, extras.get('client', id)));
  });

  /* ------------------------------------------------------------ appointments */

  const appointmentQuery = (
    query: z.infer<typeof appointmentListQuerySchema>,
  ): StoreAppointmentQuery => ({
    date: query.date,
    status: query.status as StoreAppointmentQuery['status'],
    providerId: query.providerId,
  });

  app.get('/api/appointments', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parse(appointmentListQuerySchema, request.query, 'Appointment query');
    const locations = sessionsById();
    const { clientId, sessionId, type, from, to } = query;
    let appointments = (store.listAppointments(appointmentQuery(query)) as unknown[]).map((entry) =>
      appointmentView(entry, locations),
    );
    if (clientId !== undefined) {
      appointments = appointments.filter((entry) => entry.clientId === clientId);
    }
    if (sessionId !== undefined) {
      appointments = appointments.filter((entry) => entry.sessionId === sessionId);
    }
    if (type !== undefined) {
      appointments = appointments.filter((entry) => entry.type === type);
    }
    if (from !== undefined) appointments = appointments.filter((entry) => entry.date >= from);
    if (to !== undefined) appointments = appointments.filter((entry) => entry.date <= to);
    if (query.q !== undefined && query.q !== '') {
      const needle = query.q.toLowerCase();
      appointments = appointments.filter((entry) =>
        [entry.clientName, entry.providerName, entry.reason, entry.location]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }
    return reply.send(appointments);
  });

  const findSessionFor = (date: string, startTime: string, endTime: string): Json | undefined => {
    const candidates = asList(store.listSessions(date) as unknown).filter(
      (session) => str(session, 'startTime') <= startTime && str(session, 'endTime') >= endTime,
    );
    if (candidates.length === 0) return undefined;
    const withRoom = candidates.find((session) => num(session, 0, 'availableCapacity') > 0);
    return withRoom ?? candidates[0];
  };

  app.post('/api/appointments', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parse(createAppointmentSchema, request.body, 'Appointment payload');
    const session = findSessionFor(body.date, body.startTime, body.endTime);
    if (session === undefined) {
      throw new ApiError(
        'CONFLICT',
        `No clinic session on ${body.date} covers ${body.startTime}-${body.endTime}.`,
        {
          kind: 'session_unavailable',
          date: body.date,
          startTime: body.startTime,
          endTime: body.endTime,
        },
      );
    }
    const input: StoreAppointmentInput = {
      clientId: body.clientId,
      providerId: body.providerId,
      sessionId: str(session, 'id'),
      date: body.date,
      startTime: body.startTime,
      endTime: body.endTime,
      status: 'requested',
      reason: body.reason,
      notes: body.notes,
    };
    const created = asRecord(store.createAppointment(input) as unknown);
    const id = str(created, 'id');
    extras.set('appointment', id, { type: body.type });
    reply.code(201).header('location', `/api/appointments/${id}`);
    return reply.send(mapAppointment(created, extras.get('appointment', id), sessionsById()));
  });

  const patchAppointmentStatus = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parse(z.object({ id: nonBlankIdSchema }), request.params, 'Appointment id');
    const body = parse(appointmentStatusPatchSchema, request.body, 'Status payload');
    const updated = asRecord(store.updateAppointmentStatus(params.id, body.status) as unknown);
    return reply.send(
      mapAppointment(updated, extras.get('appointment', params.id), sessionsById()),
    );
  };

  app.patch('/api/appointments/:id/status', patchAppointmentStatus);
  app.post('/api/appointments/:id/status', patchAppointmentStatus);
  app.patch('/api/appointments/:id', patchAppointmentStatus);

  /* -------------------------------------------------------------- follow-ups */

  app.get('/api/follow-ups', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parse(followUpListQuerySchema, request.query, 'Follow-up query');
    const filters: StoreFollowUpQuery = {
      status: query.status as StoreFollowUpQuery['status'],
      assigneeId: query.assigneeId,
      overdue: query.overdue,
    };
    let followUps = (store.listFollowUps(filters) as unknown[]).map((entry) => followUpView(entry));
    const { clientId, priority, dueBefore } = query;
    if (clientId !== undefined) {
      followUps = followUps.filter((entry) => entry.clientId === clientId);
    }
    if (priority !== undefined) {
      followUps = followUps.filter((entry) => entry.priority === priority);
    }
    if (dueBefore !== undefined) {
      followUps = followUps.filter((entry) => entry.dueDate <= dueBefore);
    }
    if (query.q !== undefined && query.q !== '') {
      const needle = query.q.toLowerCase();
      followUps = followUps.filter((entry) =>
        [entry.title, entry.clientName, entry.assigneeName, entry.detail]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }
    return reply.send(followUps);
  });

  const createFollowUp = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parse(createFollowUpSchema, request.body, 'Follow-up payload');
    const assigneeId = body.assigneeId ?? resolveAssigneeId(store, body.assignee) ?? undefined;
    const input: StoreFollowUpInput = {
      clientId: body.clientId,
      title: body.title,
      dueDate: body.dueDate ?? addDays(todayIso(), 7),
      assigneeId: assigneeId ?? null,
      appointmentId: body.appointmentId ?? null,
      detail: body.notes !== '' ? body.notes : body.detail,
      status: 'open',
    };
    const created = asRecord(store.createFollowUp(input) as unknown);
    const id = str(created, 'id');
    extras.set('follow_up', id, { priority: body.priority });
    reply.code(201).header('location', `/api/follow-ups/${id}`);
    return reply.send(mapFollowUp(created, extras.get('follow_up', id)));
  };

  app.post('/api/follow-ups', createFollowUp);
  app.post('/api/followups', createFollowUp);

  const patchFollowUpStatus = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = parse(z.object({ id: nonBlankIdSchema }), request.params, 'Follow-up id');
    const body = parse(followUpStatusPatchSchema, request.body, 'Status payload');
    const updated = asRecord(store.updateFollowUpStatus(params.id, body.status) as unknown);
    return reply.send(mapFollowUp(updated, extras.get('follow_up', params.id)));
  };

  app.patch('/api/follow-ups/:id/status', patchFollowUpStatus);
  app.post('/api/follow-ups/:id/status', patchFollowUpStatus);
  app.patch('/api/followups/:id', patchFollowUpStatus);

  const listFollowUpsAlias = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = parse(followUpListQuerySchema, request.query, 'Follow-up query');
    const filters: StoreFollowUpQuery = {
      status: query.status as StoreFollowUpQuery['status'],
      assigneeId: query.assigneeId,
      overdue: query.overdue,
    };
    let followUps = (store.listFollowUps(filters) as unknown[]).map((entry) => followUpView(entry));
    if (query.clientId !== undefined) {
      followUps = followUps.filter((entry) => entry.clientId === query.clientId);
    }
    return reply.send(followUps);
  };

  app.get('/api/followups', listFollowUpsAlias);

  /* -------------------------------------------------------------------- CSV */

  const sendCsv = async (
    reply: FastifyReply,
    entity: CsvEntity,
    request: FastifyRequest,
  ): Promise<FastifyReply> => {
    request.log.info({ entity }, 'exporting csv');
    const csv = store.exportCsv(entity);
    reply.type('text/csv; charset=utf-8');
    reply.header(
      'content-disposition',
      `attachment; filename="caregrid-${entity}-${todayIso()}.csv"`,
    );
    return reply.send(csv);
  };

  app.get('/api/export/:entity', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = asRecord(request.params);
    const requested = str(params, 'entity').trim();
    const entity = exportEntityAliases[requested];
    if (entity === undefined) {
      throw new ApiError('NOT_FOUND', `Unknown export entity "${requested}".`, {
        supported: Object.keys(exportEntityAliases),
      });
    }
    return sendCsv(reply, entity, request);
  });

  app.get('/api/follow-ups/export.csv', async (request: FastifyRequest, reply: FastifyReply) =>
    sendCsv(reply, 'follow_ups', request),
  );

  /* ----------------------------------------------------------------- import */

  app.post('/api/import/clients', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parse(clientImportSchema, request.body, 'Import payload');
    const rows = body.rows.map((row): StoreImportRow => ({
      fullName: [row.firstName, row.lastName].filter(Boolean).join(' ').trim(),
      email: row.email,
      phone: row.phone.trim() === '' ? UNKNOWN_PHONE : row.phone,
      dateOfBirth: UNKNOWN_DATE_OF_BIRTH,
      status: storeClientStatus(row.status) as StoreImportRow['status'],
      notes: row.accessNotes ?? '',
    }));
    const raw = asRecord(
      store.importClients({ clients: rows, mode: importMode(body.mode) }) as unknown,
    );
    const created = asList(raw.created);
    const byEmail = new Map<string, (typeof body.rows)[number]>();
    for (const row of body.rows) {
      if (row.email !== null && row.email !== undefined) byEmail.set(row.email.toLowerCase(), row);
    }
    const createdViews = created.map((entry) => {
      const id = str(entry, 'id');
      const match = byEmail.get(str(entry, 'email').toLowerCase());
      if (match !== undefined) {
        extras.set('client', id, {
          consentStatus: match.consentStatus,
          ...(match.preferredName === '' ? {} : { preferredName: match.preferredName }),
        });
      }
      return mapClient(entry, extras.get('client', id));
    });
    return reply.send({
      mode: body.mode,
      totalRows: body.rows.length,
      imported: createdViews.length,
      created: createdViews,
      skipped: num(raw, 0, 'skipped'),
      errors: [] as Array<{ row: number; code: string; message: string }>,
    });
  });
}

function importMode(mode: string): 'skip' | 'fail' {
  return mode === 'skip_duplicates' ? 'skip' : 'fail';
}

/**
 * Resolves a coordinator typed assignee (a provider name) to a provider id.
 * Returns `undefined` when the name cannot be matched, so the follow-up is
 * stored unassigned rather than pointing at the wrong provider.
 */
function resolveAssigneeId(store: Store, assignee: string | undefined): string | null {
  if (assignee === undefined || assignee.trim() === '') return null;
  const needle = assignee.trim().toLowerCase();
  for (const provider of store.listProviders() as unknown[]) {
    const record = asRecord(provider);
    const id = str(record, 'id');
    const name = str(record, 'name').toLowerCase();
    const email = str(record, 'email').toLowerCase();
    if (id.toLowerCase() === needle || name === needle || email === needle) return id;
  }
  return null;
}
