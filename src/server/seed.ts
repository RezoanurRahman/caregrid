/**
 * Deterministic seed data for Caregrid.
 *
 * The fixtures describe a pop-up clinic on 2026-10-07 and 2026-10-08 with a
 * small history before it, so the dashboard, the schedule and the client
 * timeline all have realistic content. Every run produces exactly the same
 * rows and IDs, and `seedDatabase` is idempotent: an existing database with
 * user-created rows is never overwritten or reseeded.
 */

import Database from 'better-sqlite3';
import { initializeDatabase } from './db.js';
import {
  addMinutes,
  describeAppointmentCreated,
  describeAppointmentStatusChange,
  describeClientCreated,
  describeFollowUpCreated,
  describeFollowUpStatusChange,
  type AppointmentStatus,
  type ClientStatus,
  type FollowUpStatus,
} from './domain.js';

export const SEED_KEY = 'seed_version';
export const SEED_VERSION = 'caregrid-2026-10-07-v1';

/** The demo "today"; matches the default dashboard date on 2026-10-07. */
export const SEED_TODAY = '2026-10-07';
export const SEED_TOMORROW = '2026-10-08';

export interface SeedProviderRow {
  id: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  active: boolean;
  createdAt: string;
}

export interface SeedSessionRow {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  capacity: number;
  leadProviderId: string;
  notes: string;
  createdAt: string;
}

export interface SeedClientRow {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  status: ClientStatus;
  notes: string | null;
  createdAt: string;
}

export interface SeedAppointmentRow {
  id: string;
  clientId: string;
  providerId: string;
  sessionId: string;
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  reason: string;
  notes: string | null;
  createdAt: string;
}

export interface SeedFollowUpRow {
  id: string;
  clientId: string;
  assigneeId: string | null;
  appointmentId: string | null;
  title: string;
  detail: string;
  status: FollowUpStatus;
  dueDate: string;
  completedAt: string | null;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

export const SEED_PROVIDERS: readonly SeedProviderRow[] = [
  {
    id: 'prov-0001',
    name: 'Dr. Amara Okafor',
    role: 'Physician',
    email: 'amara.okafor@caregrid.example',
    phone: '+1-555-0142',
    active: true,
    createdAt: '2026-09-20T08:00:00.000Z',
  },
  {
    id: 'prov-0002',
    name: 'Lena Fischer',
    role: 'Nurse Practitioner',
    email: 'lena.fischer@caregrid.example',
    phone: '+1-555-0177',
    active: true,
    createdAt: '2026-09-20T08:05:00.000Z',
  },
  {
    id: 'prov-0003',
    name: 'Dr. Marcus Lee',
    role: 'Physician',
    email: 'marcus.lee@caregrid.example',
    phone: '+1-555-0193',
    active: true,
    createdAt: '2026-09-20T08:10:00.000Z',
  },
  {
    id: 'prov-0004',
    name: 'Priya Raman',
    role: 'Care Coordinator',
    email: 'priya.raman@caregrid.example',
    phone: '+1-555-0120',
    active: true,
    createdAt: '2026-09-20T08:15:00.000Z',
  },
  {
    id: 'prov-0005',
    name: 'Dr. Nadia Haddad',
    role: 'Physician',
    email: 'nadia.haddad@caregrid.example',
    phone: '+1-555-0188',
    active: false,
    createdAt: '2026-09-20T08:20:00.000Z',
  },
];

export const SEED_SESSIONS: readonly SeedSessionRow[] = [
  {
    id: 'sess-2026-10-06-am',
    date: '2026-10-06',
    startTime: '09:00',
    endTime: '12:00',
    location: 'Riverside Community Hall',
    capacity: 10,
    leadProviderId: 'prov-0001',
    notes: 'General clinic, walk-ins accepted',
    createdAt: '2026-09-28T09:00:00.000Z',
  },
  {
    id: 'sess-2026-10-06-pm',
    date: '2026-10-06',
    startTime: '13:00',
    endTime: '16:00',
    location: 'Riverside Community Hall',
    capacity: 8,
    leadProviderId: 'prov-0002',
    notes: 'Wound care and vaccinations',
    createdAt: '2026-09-28T09:05:00.000Z',
  },
  {
    id: 'sess-2026-10-07-am',
    date: SEED_TODAY,
    startTime: '09:00',
    endTime: '12:00',
    location: 'Riverside Community Hall',
    capacity: 12,
    leadProviderId: 'prov-0001',
    notes: 'General clinic with care coordination desk',
    createdAt: '2026-09-28T09:10:00.000Z',
  },
  {
    id: 'sess-2026-10-07-pm',
    date: SEED_TODAY,
    startTime: '13:00',
    endTime: '16:30',
    location: 'Eastside Clinic Annex',
    capacity: 10,
    leadProviderId: 'prov-0003',
    notes: 'Afternoon clinic, appointments preferred',
    createdAt: '2026-09-28T09:15:00.000Z',
  },
  {
    id: 'sess-2026-10-08-am',
    date: SEED_TOMORROW,
    startTime: '09:00',
    endTime: '12:30',
    location: 'Eastside Clinic Annex',
    capacity: 14,
    leadProviderId: 'prov-0002',
    notes: 'Screening day',
    createdAt: '2026-09-28T09:20:00.000Z',
  },
  {
    id: 'sess-2026-10-08-pm',
    date: SEED_TOMORROW,
    startTime: '13:30',
    endTime: '16:00',
    location: 'Riverside Community Hall',
    capacity: 9,
    leadProviderId: 'prov-0001',
    notes: 'Follow-up visits',
    createdAt: '2026-09-28T09:25:00.000Z',
  },
];

export const SEED_CLIENTS: readonly SeedClientRow[] = [
  {
    id: 'cli-0001',
    fullName: 'Maya Thompson',
    email: 'maya.thompson@example.com',
    phone: '+1-555-0101',
    dateOfBirth: '1988-04-12',
    status: 'active',
    notes: 'Prefers morning appointments.',
    createdAt: '2026-09-22T09:15:00.000Z',
  },
  {
    id: 'cli-0002',
    fullName: 'Daniel Rivera',
    email: 'daniel.rivera@example.com',
    phone: '+1-555-0112',
    dateOfBirth: '1975-11-03',
    status: 'active',
    notes: 'Diabetes review in progress.',
    createdAt: '2026-09-24T10:40:00.000Z',
  },
  {
    id: 'cli-0003',
    fullName: 'Aisha Bello',
    email: 'aisha.bello@example.com',
    phone: '+1-555-0125',
    dateOfBirth: '1992-07-27',
    status: 'active',
    notes: null,
    createdAt: '2026-09-29T13:05:00.000Z',
  },
  {
    id: 'cli-0004',
    fullName: 'Tom Becker',
    email: 'tom.becker@example.com',
    phone: '+1-555-0134',
    dateOfBirth: '1968-02-19',
    status: 'active',
    notes: 'Needs transport support for wound care.',
    createdAt: '2026-10-01T08:20:00.000Z',
  },
  {
    id: 'cli-0005',
    fullName: 'Grace Nguyen',
    email: 'grace.nguyen@example.com',
    phone: '+1-555-0147',
    dateOfBirth: '2001-09-08',
    status: 'waitlist',
    notes: 'Student; waiting for an evening slot.',
    createdAt: '2026-10-02T15:45:00.000Z',
  },
  {
    id: 'cli-0006',
    fullName: 'Robert Fields',
    email: 'robert.fields@example.com',
    phone: '+1-555-0158',
    dateOfBirth: '1959-06-30',
    status: 'inactive',
    notes: 'Moved out of area in September.',
    createdAt: '2026-09-26T11:10:00.000Z',
  },
];

export const SEED_APPOINTMENTS: readonly SeedAppointmentRow[] = [
  {
    id: 'apt-0001',
    clientId: 'cli-0001',
    providerId: 'prov-0001',
    sessionId: 'sess-2026-10-06-am',
    date: '2026-10-06',
    startTime: '09:00',
    endTime: '09:30',
    status: 'completed',
    reason: 'Annual check-up',
    notes: null,
    createdAt: '2026-09-30T09:00:00.000Z',
  },
  {
    id: 'apt-0002',
    clientId: 'cli-0002',
    providerId: 'prov-0002',
    sessionId: 'sess-2026-10-06-am',
    date: '2026-10-06',
    startTime: '09:30',
    endTime: '10:00',
    status: 'completed',
    reason: 'Diabetes review',
    notes: null,
    createdAt: '2026-09-30T09:20:00.000Z',
  },
  {
    id: 'apt-0003',
    clientId: 'cli-0006',
    providerId: 'prov-0001',
    sessionId: 'sess-2026-10-06-am',
    date: '2026-10-06',
    startTime: '10:00',
    endTime: '10:30',
    status: 'no_show',
    reason: 'Medication review',
    notes: 'Client did not attend; follow-up created.',
    createdAt: '2026-10-01T11:00:00.000Z',
  },
  {
    id: 'apt-0004',
    clientId: 'cli-0004',
    providerId: 'prov-0002',
    sessionId: 'sess-2026-10-06-am',
    date: '2026-10-06',
    startTime: '10:30',
    endTime: '11:00',
    status: 'completed',
    reason: 'Wound dressing',
    notes: null,
    createdAt: '2026-10-02T08:30:00.000Z',
  },
  {
    id: 'apt-0005',
    clientId: 'cli-0003',
    providerId: 'prov-0001',
    sessionId: 'sess-2026-10-07-am',
    date: SEED_TODAY,
    startTime: '09:00',
    endTime: '09:30',
    status: 'confirmed',
    reason: 'New patient intake',
    notes: null,
    createdAt: '2026-10-05T09:00:00.000Z',
  },
  {
    id: 'apt-0006',
    clientId: 'cli-0001',
    providerId: 'prov-0001',
    sessionId: 'sess-2026-10-07-am',
    date: SEED_TODAY,
    startTime: '09:30',
    endTime: '10:00',
    status: 'confirmed',
    reason: 'Blood pressure follow-up',
    notes: null,
    createdAt: '2026-10-05T09:30:00.000Z',
  },
  {
    id: 'apt-0007',
    clientId: 'cli-0004',
    providerId: 'prov-0002',
    sessionId: 'sess-2026-10-07-am',
    date: SEED_TODAY,
    startTime: '10:00',
    endTime: '10:30',
    status: 'cancelled',
    reason: 'Wound dressing review',
    notes: 'Cancelled by the client, transport unavailable.',
    createdAt: '2026-10-05T10:00:00.000Z',
  },
  {
    id: 'apt-0008',
    clientId: 'cli-0002',
    providerId: 'prov-0004',
    sessionId: 'sess-2026-10-07-am',
    date: SEED_TODAY,
    startTime: '10:30',
    endTime: '11:00',
    status: 'completed',
    reason: 'Benefits screening',
    notes: null,
    createdAt: '2026-10-05T10:30:00.000Z',
  },
  {
    id: 'apt-0009',
    clientId: 'cli-0004',
    providerId: 'prov-0003',
    sessionId: 'sess-2026-10-07-pm',
    date: SEED_TODAY,
    startTime: '13:30',
    endTime: '14:00',
    status: 'checked_in',
    reason: 'Wound dressing change',
    notes: null,
    createdAt: '2026-10-05T11:00:00.000Z',
  },
  {
    id: 'apt-0010',
    clientId: 'cli-0003',
    providerId: 'prov-0003',
    sessionId: 'sess-2026-10-07-pm',
    date: SEED_TODAY,
    startTime: '14:00',
    endTime: '14:30',
    status: 'requested',
    reason: 'Vaccination consult',
    notes: null,
    createdAt: '2026-10-06T16:10:00.000Z',
  },
  {
    id: 'apt-0011',
    clientId: 'cli-0001',
    providerId: 'prov-0002',
    sessionId: 'sess-2026-10-08-am',
    date: SEED_TOMORROW,
    startTime: '09:00',
    endTime: '09:30',
    status: 'confirmed',
    reason: 'Dental screening',
    notes: null,
    createdAt: '2026-10-06T09:15:00.000Z',
  },
  {
    id: 'apt-0012',
    clientId: 'cli-0003',
    providerId: 'prov-0002',
    sessionId: 'sess-2026-10-08-am',
    date: SEED_TOMORROW,
    startTime: '10:00',
    endTime: '10:30',
    status: 'requested',
    reason: 'Post-visit review',
    notes: null,
    createdAt: '2026-10-06T09:40:00.000Z',
  },
];

export const SEED_FOLLOW_UPS: readonly SeedFollowUpRow[] = [
  {
    id: 'fup-0001',
    clientId: 'cli-0001',
    assigneeId: 'prov-0002',
    appointmentId: 'apt-0001',
    title: 'Confirm bloodwork results',
    detail: 'Call the client once the lab report arrives.',
    status: 'open',
    dueDate: SEED_TODAY,
    completedAt: null,
    createdAt: '2026-10-06T09:40:00.000Z',
  },
  {
    id: 'fup-0002',
    clientId: 'cli-0002',
    assigneeId: 'prov-0001',
    appointmentId: 'apt-0002',
    title: 'Schedule diabetes review',
    detail: 'Book a 30 minute slot in the next clinic block.',
    status: 'open',
    dueDate: '2026-10-05',
    completedAt: null,
    createdAt: '2026-10-04T09:10:00.000Z',
  },
  {
    id: 'fup-0003',
    clientId: 'cli-0003',
    assigneeId: 'prov-0004',
    appointmentId: 'apt-0005',
    title: 'Refer to housing support',
    detail: 'Warm handover to the housing team, then confirm the appointment.',
    status: 'in_progress',
    dueDate: SEED_TOMORROW,
    completedAt: null,
    createdAt: '2026-10-05T09:45:00.000Z',
  },
  {
    id: 'fup-0004',
    clientId: 'cli-0004',
    assigneeId: 'prov-0003',
    appointmentId: 'apt-0004',
    title: 'Deliver immunisation records',
    detail: 'Records handed to the client at the front desk.',
    status: 'done',
    dueDate: '2026-10-06',
    completedAt: '2026-10-06T15:20:00.000Z',
    createdAt: '2026-10-02T09:00:00.000Z',
  },
  {
    id: 'fup-0005',
    clientId: 'cli-0005',
    assigneeId: 'prov-0004',
    appointmentId: null,
    title: 'Confirm waitlist placement',
    detail: 'Offer the next evening clinic slot when it opens.',
    status: 'open',
    dueDate: '2026-10-09',
    completedAt: null,
    createdAt: '2026-10-02T16:00:00.000Z',
  },
  {
    id: 'fup-0006',
    clientId: 'cli-0006',
    assigneeId: 'prov-0001',
    appointmentId: 'apt-0003',
    title: 'Reconnect after missed appointment',
    detail: 'Call twice, then send a letter if there is no answer.',
    status: 'in_progress',
    dueDate: '2026-10-03',
    completedAt: null,
    createdAt: '2026-10-06T11:30:00.000Z',
  },
  {
    id: 'fup-0007',
    clientId: 'cli-0004',
    assigneeId: null,
    appointmentId: null,
    title: 'Replace dressing supplies',
    detail: 'Client sourced supplies locally.',
    status: 'dismissed',
    dueDate: SEED_TOMORROW,
    completedAt: null,
    createdAt: '2026-10-05T12:00:00.000Z',
  },
];

/* -------------------------------------------------------------------------- */
/* Status history used for both stored rows and activity events                */
/* -------------------------------------------------------------------------- */

function appointmentStatusChain(status: AppointmentStatus): readonly AppointmentStatus[] {
  switch (status) {
    case 'requested':
      return [];
    case 'confirmed':
      return ['confirmed'];
    case 'checked_in':
      return ['confirmed', 'checked_in'];
    case 'completed':
      return ['confirmed', 'checked_in', 'completed'];
    case 'no_show':
      return ['confirmed', 'no_show'];
    case 'cancelled':
      return ['cancelled'];
  }
}

function followUpStatusChain(status: FollowUpStatus): readonly FollowUpStatus[] {
  switch (status) {
    case 'open':
      return [];
    case 'in_progress':
      return ['in_progress'];
    case 'done':
      return ['in_progress', 'done'];
    case 'dismissed':
      return ['dismissed'];
  }
}

function at(date: string, time: string): string {
  return `${date}T${time}:00.000Z`;
}

interface ActivityInsert {
  entityType: 'client' | 'appointment' | 'follow_up';
  entityId: string;
  clientId: string | null;
  action: string;
  detail: string;
  createdAt: string;
}

function buildAppointmentActivity(
  appointment: SeedAppointmentRow,
  clientName: string,
  providerName: string,
): { events: ActivityInsert[]; updatedAt: string } {
  const descriptor = {
    clientName,
    providerName,
    date: appointment.date,
    startTime: appointment.startTime,
    endTime: appointment.endTime,
  };
  const events: ActivityInsert[] = [
    {
      entityType: 'appointment',
      entityId: appointment.id,
      clientId: appointment.clientId,
      action: 'created',
      detail: describeAppointmentCreated(descriptor, 'requested'),
      createdAt: appointment.createdAt,
    },
  ];
  let previous: AppointmentStatus = 'requested';
  let at_ = appointment.createdAt;
  for (const status of appointmentStatusChain(appointment.status)) {
    if (status === 'checked_in') {
      at_ = at(appointment.date, appointment.startTime);
    } else if (status === 'completed' || status === 'no_show') {
      at_ = at(appointment.date, appointment.endTime);
    } else {
      at_ = addMinutes(at_, 45);
    }
    events.push({
      entityType: 'appointment',
      entityId: appointment.id,
      clientId: appointment.clientId,
      action: 'status_changed',
      detail: describeAppointmentStatusChange(descriptor, previous, status),
      createdAt: at_,
    });
    previous = status;
  }
  return {
    events,
    updatedAt: previous === 'requested' ? appointment.createdAt : at_,
  };
}

function buildFollowUpActivity(
  followUp: SeedFollowUpRow,
  clientName: string,
  assigneeName: string | null,
): { events: ActivityInsert[]; updatedAt: string } {
  const events: ActivityInsert[] = [
    {
      entityType: 'follow_up',
      entityId: followUp.id,
      clientId: followUp.clientId,
      action: 'created',
      detail: describeFollowUpCreated(followUp, { fullName: clientName }, assigneeName),
      createdAt: followUp.createdAt,
    },
  ];
  let previous: FollowUpStatus = 'open';
  let at_ = followUp.createdAt;
  for (const status of followUpStatusChain(followUp.status)) {
    if (status === 'done' && followUp.completedAt !== null) {
      at_ = followUp.completedAt;
    } else {
      at_ = addMinutes(at_, 120);
    }
    events.push({
      entityType: 'follow_up',
      entityId: followUp.id,
      clientId: followUp.clientId,
      action: 'status_changed',
      detail: describeFollowUpStatusChange(followUp, { fullName: clientName }, previous, status),
      createdAt: at_,
    });
    previous = status;
  }
  return { events, updatedAt: previous === 'open' ? followUp.createdAt : at_ };
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                     */
/* -------------------------------------------------------------------------- */

function hasRows(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM providers) +
         (SELECT COUNT(*) FROM clinic_sessions) +
         (SELECT COUNT(*) FROM clients) +
         (SELECT COUNT(*) FROM appointments) +
         (SELECT COUNT(*) FROM follow_ups) AS total`,
    )
    .get() as { total: number };
  return row.total > 0;
}

function writeSeedMarker(db: Database.Database): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(SEED_KEY, SEED_VERSION);
}

function insertSeedData(db: Database.Database): void {
  const insertProvider = db.prepare(
    `INSERT INTO providers (id, name, role, email, phone, active, created_at, updated_at)
     VALUES (@id, @name, @role, @email, @phone, @active, @createdAt, @createdAt)`,
  );
  for (const provider of SEED_PROVIDERS) {
    insertProvider.run({ ...provider, active: provider.active ? 1 : 0 });
  }

  const insertSession = db.prepare(
    `INSERT INTO clinic_sessions
       (id, date, start_time, end_time, location, capacity, lead_provider_id, notes, created_at, updated_at)
     VALUES (@id, @date, @startTime, @endTime, @location, @capacity, @leadProviderId, @notes, @createdAt, @createdAt)`,
  );
  for (const session of SEED_SESSIONS) insertSession.run(session);

  const insertClient = db.prepare(
    `INSERT INTO clients (id, full_name, email, phone, date_of_birth, status, notes, created_at, updated_at)
     VALUES (@id, @fullName, @email, @phone, @dateOfBirth, @status, @notes, @createdAt, @createdAt)`,
  );
  for (const client of SEED_CLIENTS) insertClient.run(client);

  const providerNames = new Map(SEED_PROVIDERS.map((provider) => [provider.id, provider.name]));
  const clientNames = new Map(SEED_CLIENTS.map((client) => [client.id, client.fullName]));

  const activities: ActivityInsert[] = [];
  for (const client of SEED_CLIENTS) {
    activities.push({
      entityType: 'client',
      entityId: client.id,
      clientId: client.id,
      action: 'created',
      detail: describeClientCreated(client),
      createdAt: client.createdAt,
    });
  }

  const insertAppointment = db.prepare(
    `INSERT INTO appointments
       (id, client_id, provider_id, session_id, date, start_time, end_time, status, reason, notes, created_at, updated_at)
     VALUES (@id, @clientId, @providerId, @sessionId, @date, @startTime, @endTime, @status, @reason, @notes, @createdAt, @updatedAt)`,
  );
  for (const appointment of SEED_APPOINTMENTS) {
    const clientName = clientNames.get(appointment.clientId) ?? appointment.clientId;
    const providerName = providerNames.get(appointment.providerId) ?? appointment.providerId;
    const { events, updatedAt } = buildAppointmentActivity(appointment, clientName, providerName);
    activities.push(...events);
    insertAppointment.run({ ...appointment, updatedAt });
  }

  const insertFollowUp = db.prepare(
    `INSERT INTO follow_ups
       (id, client_id, appointment_id, assignee_id, title, detail, status, due_date, completed_at, created_at, updated_at)
     VALUES (@id, @clientId, @appointmentId, @assigneeId, @title, @detail, @status, @dueDate, @completedAt, @createdAt, @updatedAt)`,
  );
  for (const followUp of SEED_FOLLOW_UPS) {
    const clientName = clientNames.get(followUp.clientId) ?? followUp.clientId;
    const assigneeName = followUp.assigneeId === null ? null : (providerNames.get(followUp.assigneeId) ?? followUp.assigneeId);
    const { events, updatedAt } = buildFollowUpActivity(followUp, clientName, assigneeName);
    activities.push(...events);
    insertFollowUp.run({ ...followUp, updatedAt });
  }

  const insertActivity = db.prepare(
    `INSERT INTO activity_events (entity_type, entity_id, client_id, action, detail, created_at)
     VALUES (@entityType, @entityId, @clientId, @action, @detail, @createdAt)`,
  );
  for (const activity of activities) insertActivity.run(activity);
}

/**
 * Seeds the deterministic demo data. Safe to call on every startup:
 *  - a database that already recorded the seed marker is left untouched;
 *  - a database with rows but no marker (for example a partially hand-crafted
 *    database) is marked as seeded instead of being overwritten.
 */
export function seedDatabase(db: Database.Database): void {
  initializeDatabase(db);
  const seed = db.transaction(() => {
    const marker = db.prepare('SELECT value FROM meta WHERE key = ?').get(SEED_KEY) as
      | { value: string }
      | undefined;
    if (marker !== undefined) return;
    if (hasRows(db)) {
      writeSeedMarker(db);
      return;
    }
    insertSeedData(db);
    writeSeedMarker(db);
  });
  seed.immediate();
}
