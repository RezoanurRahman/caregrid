import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import type {
  Appointment,
  ApiErrorResponse,
  ClinicSession,
  Client,
  ClientDetail,
  DashboardData,
  FollowUp,
  Provider,
} from '../../src/shared/types.js';

/** The dashboard response also carries the raw capacity counters the UI renders. */
type DashboardResponse = DashboardData & {
  metrics: DashboardData['metrics'] & {
    capacityTotal: number;
    capacityBooked: number;
    completionRate: number;
    byStatus: Record<string, number>;
  };
};

const TODAY = '2026-10-07';
const CAPACITY_CONSUMING_STATUSES = new Set([
  'requested',
  'confirmed',
  'checked_in',
  'completed',
  'no_show',
]);
const CONFLICT_EXCLUDED_STATUSES = new Set(['cancelled', 'no_show']);

const apps: FastifyInstance[] = [];
const tempDirs: string[] = [];
let originalToday: string | undefined;
let uniqueCounter = 0;

beforeAll(() => {
  originalToday = process.env.CAREGRID_TODAY;
  process.env.CAREGRID_TODAY = TODAY;
});

afterAll(() => {
  if (originalToday === undefined) {
    delete process.env.CAREGRID_TODAY;
  } else {
    process.env.CAREGRID_TODAY = originalToday;
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) {
      try {
        await app.close();
      } catch {
        /* already closed */
      }
    }
  }
});

async function makeApp(dbFile = ':memory:'): Promise<FastifyInstance> {
  const app = await buildApp({ dbFile, logger: false });
  apps.push(app);
  return app;
}

async function closeApp(app: FastifyInstance): Promise<void> {
  const index = apps.indexOf(app);
  if (index >= 0) apps.splice(index, 1);
  await app.close();
}

function tempFileDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'caregrid-int-'));
  tempDirs.push(dir);
  return join(dir, 'caregrid.sqlite');
}

function json<T>(res: LightMyRequestResponse): T {
  return res.json() as T;
}

async function get<T>(
  app: FastifyInstance,
  url: string,
): Promise<{ res: LightMyRequestResponse; body: T }> {
  const res = await app.inject({ method: 'GET', url });
  return { res, body: json<T>(res) };
}

function post(
  app: FastifyInstance,
  url: string,
  payload: Record<string, unknown> | string,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url, payload });
}

function patch(
  app: FastifyInstance,
  url: string,
  payload: Record<string, unknown> | string,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'PATCH', url, payload });
}

function unique(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}-${process.pid.toString(36)}${uniqueCounter.toString(36)}`;
}

function toMinutes(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function toTime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const mins = (minutes % 60).toString().padStart(2, '0');
  return `${hours}:${mins}`;
}

interface TimeWindow {
  startTime: string;
  endTime: string;
}

function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return (
    toMinutes(a.startTime) < toMinutes(b.endTime) && toMinutes(b.startTime) < toMinutes(a.endTime)
  );
}

async function createClient(
  app: FastifyInstance,
  overrides: Partial<{ firstName: string; lastName: string; phone: string; email: string }> = {},
): Promise<Client> {
  const lastName = overrides.lastName ?? unique('Tester');
  const res = await post(app, '/api/clients', {
    firstName: overrides.firstName ?? 'Integration',
    lastName,
    phone: overrides.phone ?? '555-0100',
    email: overrides.email ?? `${lastName.toLowerCase()}@example.test`,
    consentStatus: 'granted',
    accessNotes: 'Created by the integration suite.',
  });
  expect(res.statusCode).toBe(201);
  return json<Client>(res);
}

/** Finds a session slot on TODAY that is free for the provider and has spare capacity. */
async function findBookableSlot(
  app: FastifyInstance,
  providerId: string,
): Promise<{ startTime: string; endTime: string }> {
  const { body: sessions } = await get<ClinicSession[]>(app, `/api/sessions?date=${TODAY}`);
  const { body: appointments } = await get<Appointment[]>(app, `/api/appointments?date=${TODAY}`);
  expect(sessions.length).toBeGreaterThan(0);

  const bookedInSession = (sessionId: string): number =>
    appointments.filter(
      (a) => a.sessionId === sessionId && CAPACITY_CONSUMING_STATUSES.has(a.status),
    ).length;

  for (const session of sessions) {
    if (bookedInSession(session.id) >= session.capacity) continue;
    const busy = appointments.filter(
      (a) => a.providerId === providerId && !CONFLICT_EXCLUDED_STATUSES.has(a.status),
    );
    for (
      let start = toMinutes(session.opensAt);
      start + 30 <= toMinutes(session.closesAt);
      start += 5
    ) {
      const candidate: TimeWindow = { startTime: toTime(start), endTime: toTime(start + 30) };
      if (!busy.some((a) => windowsOverlap(candidate, a))) return candidate;
    }
  }
  throw new Error('Seeded data has no bookable slot for the requested provider');
}

describe('GET /api endpoints', () => {
  it('returns the health contract', async () => {
    const app = await makeApp();
    const { res, body } = await get<{ status: string; storage: string }>(app, '/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(body).toEqual({ status: 'ok', storage: 'sqlite' });
  });

  it('returns the seeded dashboard for the deterministic date', async () => {
    const app = await makeApp();
    const { res, body } = await get<DashboardResponse>(app, '/api/dashboard');
    expect(res.statusCode).toBe(200);
    expect(body.asOfDate).toBe(TODAY);
    expect(body.metrics.activeClients).toBeGreaterThan(0);
    expect(body.metrics.appointmentsToday).toBeGreaterThan(0);
    expect(body.metrics.completedToday).toBeGreaterThanOrEqual(0);
    expect(body.metrics.openFollowUps).toBeGreaterThan(0);
    expect(body.metrics.availableCapacityToday).toBeGreaterThan(0);
    expect(body.metrics.capacityTotal).toBeGreaterThan(0);
    expect(body.metrics.capacityBooked).toBeLessThanOrEqual(body.metrics.capacityTotal);
    expect(body.metrics.completionRate).toBeGreaterThanOrEqual(0);
    expect(body.metrics.completionRate).toBeLessThanOrEqual(1);
    expect(Object.values(body.metrics.byStatus).some((count) => count > 0)).toBe(true);
    expect(Array.isArray(body.upcomingAppointments)).toBe(true);
    expect(Array.isArray(body.followUps)).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThan(0);
  });

  it('returns seeded providers, sessions, clients, appointments and follow-ups', async () => {
    const app = await makeApp();

    const { body: providers } = await get<Provider[]>(app, '/api/providers');
    expect(providers.length).toBeGreaterThanOrEqual(2);
    for (const provider of providers) {
      expect(provider.id).toBeTruthy();
      expect(provider.name).toBeTruthy();
      expect(typeof provider.active).toBe('boolean');
    }

    const { body: sessions } = await get<ClinicSession[]>(app, `/api/sessions?date=${TODAY}`);
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.date).toBe(TODAY);
      expect(session.capacity).toBeGreaterThan(0);
      expect(toMinutes(session.opensAt)).toBeLessThan(toMinutes(session.closesAt));
    }

    const { body: clients } = await get<Client[]>(app, '/api/clients');
    expect(clients.length).toBeGreaterThanOrEqual(5);
    for (const client of clients) {
      expect(client.id).toBeTruthy();
      expect(['pending', 'granted', 'declined']).toContain(client.consentStatus);
    }

    const { body: appointments } = await get<Appointment[]>(app, `/api/appointments?date=${TODAY}`);
    expect(appointments.length).toBeGreaterThan(0);
    for (const appointment of appointments) {
      expect(appointment.clientName).toBeTruthy();
      expect(appointment.providerName).toBeTruthy();
      expect(appointment.date).toBe(TODAY);
    }

    const { body: followUps } = await get<FollowUp[]>(app, '/api/follow-ups');
    expect(followUps.length).toBeGreaterThan(0);
    for (const followUp of followUps) {
      expect(['open', 'in_progress', 'done', 'dismissed']).toContain(followUp.status);
      expect(followUp.clientName).toBeTruthy();
    }

    const firstClient = clients[0];
    expect(firstClient).toBeDefined();
    if (!firstClient) throw new Error('missing seeded client');
    const detailRes = await app.inject({ method: 'GET', url: `/api/clients/${firstClient.id}` });
    expect(detailRes.statusCode).toBe(200);
    const detail = json<ClientDetail>(detailRes);
    expect(detail.client.id).toBe(firstClient.id);
    expect(Array.isArray(detail.appointments)).toBe(true);
    expect(Array.isArray(detail.followUps)).toBe(true);
    expect(Array.isArray(detail.activity)).toBe(true);
  });

  it('maps unknown clients and unknown API routes to JSON 404 errors', async () => {
    const app = await makeApp();

    const missing = await app.inject({ method: 'GET', url: '/api/clients/does-not-exist' });
    expect(missing.statusCode).toBe(404);
    const missingBody = json<ApiErrorResponse>(missing);
    expect(missingBody.error.code.toUpperCase()).toBe('NOT_FOUND');
    expect(missingBody.error.message).toBeTruthy();

    const unknown = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(unknown.statusCode).toBe(404);
    const unknownBody = json<ApiErrorResponse>(unknown);
    expect(unknownBody.error.code).toBeTruthy();
    expect(unknownBody.error.message).toBeTruthy();
  });
});

describe('POST /api/clients', () => {
  it('rejects an invalid payload with a 400 error envelope', async () => {
    const app = await makeApp();
    const res = await post(app, '/api/clients', {
      firstName: '',
      lastName: '',
      email: 'not-an-email',
    });
    expect(res.statusCode).toBe(400);
    const body = json<ApiErrorResponse>(res);
    expect(body.error.code.toUpperCase()).toBe('VALIDATION');
    expect(body.error.message).toBeTruthy();
    expect(typeof body.error.message).toBe('string');
  });

  it('rejects malformed JSON bodies with the same error envelope', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
    const body = json<ApiErrorResponse>(res);
    expect(body.error.code).toBeTruthy();
    expect(body.error.message).toBeTruthy();
  });

  it('creates a client that is then observable through search and detail reads', async () => {
    const app = await makeApp();
    const lastName = unique('Finds');
    const created = await createClient(app, { lastName, firstName: 'Ada' });
    expect(created.id).toBeTruthy();
    expect(created.lastName).toBe(lastName);
    expect(created.consentStatus).toBe('granted');

    const { body: found } = await get<Client[]>(
      app,
      `/api/clients?search=${encodeURIComponent(lastName)}`,
    );
    expect(found.some((client) => client.id === created.id)).toBe(true);

    const { res: detailRes, body: detail } = await get<ClientDetail>(
      app,
      `/api/clients/${created.id}`,
    );
    expect(detailRes.statusCode).toBe(200);
    expect(detail.client.firstName).toBe('Ada');
    expect(detail.client.lastName).toBe(lastName);
  });
});

describe('POST /api/appointments', () => {
  it('rejects invalid payloads and time windows with a 400 error envelope', async () => {
    const app = await makeApp();
    const invalidPayload = await post(app, '/api/appointments', {
      clientId: '',
      providerId: '',
      date: 'not-a-date',
      startTime: '25:00',
      endTime: '09:00',
      type: 'unknown-type',
      reason: '',
      notes: '',
    });
    expect(invalidPayload.statusCode).toBe(400);
    const invalidBody = json<ApiErrorResponse>(invalidPayload);
    expect(invalidBody.error.code.toUpperCase()).toBe('VALIDATION');
    expect(invalidBody.error.message).toBeTruthy();

    const { body: clients } = await get<Client[]>(app, '/api/clients?status=active');
    const { body: providers } = await get<Provider[]>(app, '/api/providers');
    const client = clients[0];
    const provider = providers.find((candidate) => candidate.active);
    if (!client || !provider) throw new Error('seeded client/provider missing');

    const backwardsWindow = await post(app, '/api/appointments', {
      clientId: client.id,
      providerId: provider.id,
      date: TODAY,
      startTime: '11:00',
      endTime: '10:30',
      type: 'intake',
      reason: 'ends before it starts',
      notes: '',
    });
    expect(backwardsWindow.statusCode).toBe(400);
    expect(json<ApiErrorResponse>(backwardsWindow).error.code.toUpperCase()).toBe('VALIDATION');
  });

  it('creates an appointment that appears in later reads', async () => {
    const app = await makeApp();
    const { body: providers } = await get<Provider[]>(app, '/api/providers');
    const provider = providers.find((candidate) => candidate.active);
    if (!provider) throw new Error('no active seeded provider');
    const client = await createClient(app);
    const slot = await findBookableSlot(app, provider.id);

    const res = await post(app, '/api/appointments', {
      clientId: client.id,
      providerId: provider.id,
      date: TODAY,
      startTime: slot.startTime,
      endTime: slot.endTime,
      type: 'intake',
      reason: 'Integration suite appointment',
      notes: '',
    });
    expect(res.statusCode).toBe(201);
    const created = json<Appointment>(res);
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('requested');
    expect(created.clientId).toBe(client.id);
    expect(created.providerId).toBe(provider.id);
    expect(created.date).toBe(TODAY);
    expect(created.clientName).toBeTruthy();
    expect(created.providerName).toBe(provider.name);

    const { body: listed } = await get<Appointment[]>(
      app,
      `/api/appointments?date=${TODAY}&providerId=${provider.id}`,
    );
    const found = listed.find((appointment) => appointment.id === created.id);
    expect(found).toBeDefined();
    expect(found?.startTime).toBe(slot.startTime);
    expect(found?.endTime).toBe(slot.endTime);
  });

  it('returns 409 for provider and client double-bookings', async () => {
    const app = await makeApp();
    const { body: providers } = await get<Provider[]>(app, '/api/providers');
    const activeProviders = providers.filter((candidate) => candidate.active);
    const provider = activeProviders[0];
    const otherProvider = activeProviders[1];
    if (!provider || !otherProvider) throw new Error('need two active providers');
    const client = await createClient(app);
    const otherClient = await createClient(app);
    const slot = await findBookableSlot(app, provider.id);

    const first = await post(app, '/api/appointments', {
      clientId: client.id,
      providerId: provider.id,
      date: TODAY,
      startTime: slot.startTime,
      endTime: slot.endTime,
      type: 'screening',
      reason: 'Hold the slot',
      notes: '',
    });
    expect(first.statusCode).toBe(201);

    const providerConflict = await post(app, '/api/appointments', {
      clientId: otherClient.id,
      providerId: provider.id,
      date: TODAY,
      startTime: slot.startTime,
      endTime: slot.endTime,
      type: 'intake',
      reason: 'Provider double booking',
      notes: '',
    });
    expect(providerConflict.statusCode).toBe(409);
    const providerConflictBody = json<ApiErrorResponse>(providerConflict);
    expect(providerConflictBody.error.code.toUpperCase()).toBe('CONFLICT');
    expect(providerConflictBody.error.message).toBeTruthy();

    const clientConflict = await post(app, '/api/appointments', {
      clientId: client.id,
      providerId: otherProvider.id,
      date: TODAY,
      startTime: slot.startTime,
      endTime: slot.endTime,
      type: 'intake',
      reason: 'Client double booking',
      notes: '',
    });
    expect(clientConflict.statusCode).toBe(409);
    expect(json<ApiErrorResponse>(clientConflict).error.code.toUpperCase()).toBe('CONFLICT');
  });
});

describe('PATCH /api/appointments/:id/status', () => {
  it('enforces the appointment transition rules', async () => {
    const app = await makeApp();
    const { body: providers } = await get<Provider[]>(app, '/api/providers');
    const provider = providers.find((candidate) => candidate.active);
    if (!provider) throw new Error('no active seeded provider');
    const client = await createClient(app);
    const slot = await findBookableSlot(app, provider.id);

    const created = json<Appointment>(
      await post(app, '/api/appointments', {
        clientId: client.id,
        providerId: provider.id,
        date: TODAY,
        startTime: slot.startTime,
        endTime: slot.endTime,
        type: 'follow_up',
        reason: 'Transition coverage',
        notes: '',
      }),
    );
    expect(created.status).toBe('requested');

    const invalid = await patch(app, `/api/appointments/${created.id}/status`, {
      status: 'completed',
    });
    expect(invalid.statusCode).toBe(409);
    const invalidBody = json<ApiErrorResponse>(invalid);
    expect(invalidBody.error.code.toUpperCase()).toBe('INVALID_TRANSITION');
    expect(invalidBody.error.message).toBeTruthy();

    const confirmed = await patch(app, `/api/appointments/${created.id}/status`, {
      status: 'confirmed',
    });
    expect(confirmed.statusCode).toBe(200);
    expect(json<Appointment>(confirmed).status).toBe('confirmed');

    const checkedIn = await patch(app, `/api/appointments/${created.id}/status`, {
      status: 'checked_in',
    });
    expect(checkedIn.statusCode).toBe(200);
    expect(json<Appointment>(checkedIn).status).toBe('checked_in');

    const completed = await patch(app, `/api/appointments/${created.id}/status`, {
      status: 'completed',
    });
    expect(completed.statusCode).toBe(200);
    expect(json<Appointment>(completed).status).toBe('completed');

    const terminal = await patch(app, `/api/appointments/${created.id}/status`, {
      status: 'cancelled',
    });
    expect(terminal.statusCode).toBe(409);
    expect(json<ApiErrorResponse>(terminal).error.code.toUpperCase()).toBe('INVALID_TRANSITION');
  });

  it('rejects a status that is not a known appointment status', async () => {
    const app = await makeApp();
    const res = await patch(app, '/api/appointments/any-id/status', { status: 'banana' });
    expect(res.statusCode).toBe(400);
    expect(json<ApiErrorResponse>(res).error.code.toUpperCase()).toBe('VALIDATION');
  });
});

describe('follow-up workflow', () => {
  it('creates a follow-up and mutates its status with audited transitions', async () => {
    const app = await makeApp();
    const client = await createClient(app);
    const { body: providers } = await get<Provider[]>(app, '/api/providers');
    const assignee = providers.find((candidate) => candidate.active);
    if (!assignee) throw new Error('no active seeded provider');

    const createdRes = await post(app, '/api/follow-ups', {
      clientId: client.id,
      assigneeId: assignee.id,
      title: 'Schedule an intake review',
      dueDate: '2026-10-09',
      priority: 'high',
      notes: 'Integration suite follow-up',
    });
    expect(createdRes.statusCode).toBe(201);
    const created = json<FollowUp>(createdRes);
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('open');
    expect(created.clientId).toBe(client.id);
    expect(created.clientName).toBeTruthy();

    const open = await get<FollowUp[]>(app, '/api/follow-ups?status=open');
    expect(open.res.statusCode).toBe(200);
    expect(open.body.some((followUp) => followUp.id === created.id)).toBe(true);

    const inProgress = await patch(app, `/api/follow-ups/${created.id}/status`, {
      status: 'in_progress',
    });
    expect(inProgress.statusCode).toBe(200);
    expect(json<FollowUp>(inProgress).status).toBe('in_progress');

    const done = await patch(app, `/api/follow-ups/${created.id}/status`, { status: 'done' });
    expect(done.statusCode).toBe(200);
    expect(json<FollowUp>(done).status).toBe('done');

    const reopened = await patch(app, `/api/follow-ups/${created.id}/status`, { status: 'open' });
    expect(reopened.statusCode).toBe(409);
    expect(json<ApiErrorResponse>(reopened).error.code.toUpperCase()).toBe('INVALID_TRANSITION');

    const { body: detail } = await get<ClientDetail>(app, `/api/clients/${client.id}`);
    expect(detail.followUps.some((followUp) => followUp.id === created.id)).toBe(true);
    expect(detail.activity.length).toBeGreaterThan(0);
  });
});

describe('CSV export', () => {
  it('exports clients as a CSV attachment with headers and seeded rows', async () => {
    const app = await makeApp();
    const { body: clients } = await get<Client[]>(app, '/api/clients');
    const res = await app.inject({ method: 'GET', url: '/api/export/clients' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(String(res.headers['content-disposition'])).toMatch(/attachment/i);
    expect(String(res.headers['content-disposition'])).toMatch(/\.csv/i);
    const lines = res.body.trim().split(/\r?\n/);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.toLowerCase()).toContain('name');
    const sample = clients[0];
    if (!sample) throw new Error('missing seeded client');
    expect(sample.lastName.length).toBeGreaterThan(0);
    expect(res.body).toContain(sample.lastName);
    expect(res.body).toContain(sample.id);
  });

  it('exports appointments and follow-ups as CSV and rejects unknown entities', async () => {
    const app = await makeApp();
    for (const entity of ['appointments', 'follow_ups']) {
      const res = await app.inject({ method: 'GET', url: `/api/export/${entity}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.body.trim().split(/\r?\n/).length).toBeGreaterThan(1);
    }

    const unknown = await app.inject({ method: 'GET', url: '/api/export/unknown' });
    expect(unknown.statusCode).toBe(404);
    expect(json<ApiErrorResponse>(unknown).error.code.toUpperCase()).toBe('NOT_FOUND');
  });
});

describe('client import', () => {
  it('rejects duplicates in reject mode and skips them in skip mode', async () => {
    const app = await makeApp();
    const client = await createClient(app, { lastName: unique('Imported') });

    const rejected = await post(app, '/api/import/clients', {
      rows: [{ firstName: client.firstName, lastName: client.lastName, email: client.email }],
      mode: 'reject_duplicates',
    });
    expect(rejected.statusCode).toBe(409);
    expect(json<ApiErrorResponse>(rejected).error.code.toUpperCase()).toBe('CONFLICT');

    const skipped = await post(app, '/api/import/clients', {
      rows: [{ firstName: client.firstName, lastName: client.lastName, email: client.email }],
      mode: 'skip_duplicates',
    });
    expect([200, 201]).toContain(skipped.statusCode);
    const skippedBody = json<{ created: Client[]; skipped: number }>(skipped);
    expect(skippedBody.created).toHaveLength(0);
    expect(skippedBody.skipped).toBe(1);
  });
});

describe('SQLite persistence', () => {
  it('persists created records across close and reopen without reseeding duplicates', async () => {
    const dbFile = tempFileDb();
    const firstApp = await buildApp({ dbFile, logger: false });
    const lastName = unique('Persisted');
    const created = await createClient(firstApp, { lastName });
    const { body: beforeClose } = await get<Client[]>(firstApp, '/api/clients');
    await closeApp(firstApp);

    const secondApp = await buildApp({ dbFile, logger: false });
    apps.push(secondApp);
    const { res, body } = await get<ClientDetail>(secondApp, `/api/clients/${created.id}`);
    expect(res.statusCode).toBe(200);
    expect(body.client.lastName).toBe(lastName);

    const { body: afterReopen } = await get<Client[]>(secondApp, '/api/clients');
    expect(afterReopen).toHaveLength(beforeClose.length);
    expect(afterReopen.some((client) => client.id === created.id)).toBe(true);

    const { body: dashboard } = await get<DashboardData>(secondApp, '/api/dashboard');
    expect(dashboard.asOfDate).toBe(TODAY);
  });
});
