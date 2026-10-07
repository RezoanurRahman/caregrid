import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createAppointment,
  createClient,
  createFollowUp,
  exportCsv,
  getClient,
  getDashboard,
  listAppointments,
  listClients,
  listFollowUps,
  listProviders,
  toApiError,
  updateAppointmentStatus,
  updateFollowUpStatus,
} from './api.js';

interface MockResponseInit {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

function respond(payload: unknown, init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const text = init.body ?? JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers ?? {}),
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: unknown, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function lastCall(spy: ReturnType<typeof mockFetch>) {
  const call = spy.mock.calls.at(-1);
  if (!call) {
    throw new Error('fetch was never called');
  }
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the request to fail, but it resolved.');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('read endpoints', () => {
  it('loads and normalises the dashboard from /api/dashboard', async () => {
    const spy = mockFetch(() =>
      respond({
        metrics: {
          todayAppointments: 3,
          booked: 2,
          capacity: 4,
          completionRate: 0.5,
        },
        upcomingAppointments: [{ id: 'apt-1', clientName: 'Ada', startTime: '09:00' }],
      }),
    );
    const dashboard = await getDashboard();
    expect(lastCall(spy).url).toBe('/api/dashboard');
    expect(dashboard.metrics.appointmentsToday).toBe(3);
    expect(dashboard.metrics.completionRate).toBe(50);
    expect(dashboard.upcoming[0].clientName).toBe('Ada');
  });

  it('maps the display-only scheduled filter onto the API requested status', async () => {
    const spy = mockFetch(() => respond({ appointments: [] }));
    await listAppointments({ date: '2026-10-07', status: 'scheduled' });
    expect(lastCall(spy).url).toBe('/api/appointments?date=2026-10-07&status=requested');

    await listAppointments({ status: 'confirmed' });
    expect(lastCall(spy).url).toBe('/api/appointments?status=confirmed');

    await listAppointments({ status: 'no_show' });
    expect(lastCall(spy).url).toBe('/api/appointments?status=no_show');
  });

  it('keeps normalising an API requested appointment onto the local scheduled label', async () => {
    mockFetch(() => respond({ appointments: [{ id: 'apt-1', status: 'requested' }] }));
    const appointments = await listAppointments({ status: 'scheduled' });
    expect(appointments[0].status).toBe('scheduled');
  });

  it('only sends filters that were actually chosen', async () => {
    const spy = mockFetch(() => respond({ appointments: [] }));
    await listAppointments({ date: '', status: '', providerId: 'prov-9' });
    expect(lastCall(spy).url).toBe('/api/appointments?providerId=prov-9');
  });

  it('passes the search term to /api/clients and tolerates an envelope', async () => {
    const spy = mockFetch(() =>
      respond({ clients: [{ id: 'cli-1', firstName: 'Ada', lastName: 'L' }] }),
    );
    const clients = await listClients({ search: 'ada lovelace' });
    expect(lastCall(spy).url).toBe('/api/clients?search=ada+lovelace');
    expect(clients[0].fullName).toBe('Ada L');
  });

  it('returns an empty list instead of throwing when the payload has no collection', async () => {
    mockFetch(() => respond({ unexpected: true }));
    await expect(listFollowUps()).resolves.toEqual([]);
    await expect(listClients()).resolves.toEqual([]);
  });

  it('loads a client record and providers', async () => {
    mockFetch((url) =>
      url.startsWith('/api/providers')
        ? respond({
            providers: [{ id: 'prov-1', name: 'Dr Chen', specialty: 'Family medicine' }],
          })
        : respond({
            client: {
              id: 'cli-1',
              fullName: 'Ada Lovelace',
              appointments: [{ id: 'apt-1', status: 'completed' }],
            },
          }),
    );
    const client = await getClient('cli-1');
    expect(client.fullName).toBe('Ada Lovelace');
    expect(client.appointments[0].status).toBe('completed');

    const providers = await listProviders();
    expect(providers.map((provider) => provider.id)).toEqual(['prov-1']);
  });

  it('treats an empty client payload as not found', async () => {
    mockFetch(() => respond({}, { status: 200 }));
    await expect(getClient('missing')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('write endpoints', () => {
  it('posts a client and drops unanswered optional fields', async () => {
    const spy = mockFetch(() =>
      respond({ client: { id: 'cli-9', fullName: 'Ada Lovelace' } }, { status: 201 }),
    );
    const created = await createClient({
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '',
      email: 'ada@example.org',
      consentGranted: true,
    });
    const call = lastCall(spy);
    expect(call.url).toBe('/api/clients');
    expect(call.init.method).toBe('POST');
    expect(JSON.parse(String(call.init.body))).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.org',
      consentGranted: true,
    });
    expect(created.fullName).toBe('Ada Lovelace');
  });

  it('books an appointment with the segmented date and clock fields', async () => {
    const spy = mockFetch(() =>
      respond({ appointment: { id: 'apt-9', status: 'scheduled' } }, { status: 201 }),
    );
    await createAppointment({
      clientId: 'cli-1',
      providerId: 'prov-1',
      date: '2026-10-07',
      startTime: '09:00',
      endTime: '09:30',
      type: 'Vaccination',
      reason: '',
    });
    const call = lastCall(spy);
    expect(call.url).toBe('/api/appointments');
    expect(JSON.parse(String(call.init.body))).toEqual({
      clientId: 'cli-1',
      providerId: 'prov-1',
      date: '2026-10-07',
      startTime: '09:00',
      endTime: '09:30',
      type: 'Vaccination',
    });
  });

  it('patches appointment and follow-up statuses', async () => {
    const spy = mockFetch(() => respond({ appointment: { id: 'apt-1', status: 'checked_in' } }));
    const appointment = await updateAppointmentStatus('apt-1', 'checked_in');
    const appointmentCall = lastCall(spy);
    expect(appointmentCall.url).toBe('/api/appointments/apt-1');
    expect(appointmentCall.init.method).toBe('PATCH');
    expect(JSON.parse(String(appointmentCall.init.body))).toEqual({
      status: 'checked_in',
    });
    expect(appointment.status).toBe('checked_in');

    mockFetch(() => respond({ followUp: { id: 'fu-1', status: 'done' } }));
    const followUp = await updateFollowUpStatus('fu-1', 'done');
    expect(followUp.status).toBe('done');
  });

  it('maps a local scheduled status onto the API requested status when patching', async () => {
    const spy = mockFetch(() => respond({ appointment: { id: 'apt-1', status: 'requested' } }));
    const appointment = await updateAppointmentStatus('apt-1', 'scheduled');
    const call = lastCall(spy);
    expect(call.url).toBe('/api/appointments/apt-1');
    expect(call.init.method).toBe('PATCH');
    expect(JSON.parse(String(call.init.body))).toEqual({ status: 'requested' });
    expect(appointment.status).toBe('scheduled');
  });

  it('creates a follow-up and omits the appointment link when there is none', async () => {
    const spy = mockFetch(() =>
      respond({ followUp: { id: 'fu-3', title: 'Call back' } }, { status: 201 }),
    );
    await createFollowUp({
      clientId: 'cli-1',
      appointmentId: '',
      title: '  Call back  ',
      priority: 'high',
      dueDate: '2026-10-09',
    });
    expect(JSON.parse(String(lastCall(spy).init.body))).toEqual({
      clientId: 'cli-1',
      title: 'Call back',
      priority: 'high',
      dueDate: '2026-10-09',
    });
  });
});

describe('error handling', () => {
  it('turns a 409 clash into a typed, readable error with field details', async () => {
    mockFetch(() =>
      respond(
        {
          code: 'appointment_conflict',
          message: 'Provider already booked for that slot',
          errors: [{ field: 'startTime', message: 'Overlaps an existing appointment' }],
        },
        { status: 409 },
      ),
    );
    const error = await rejection(
      createAppointment({
        clientId: 'cli-1',
        providerId: 'prov-1',
        date: '2026-10-07',
        startTime: '09:00',
        endTime: '09:30',
      }),
    );
    expect(error.status).toBe(409);
    expect(error.isConflict).toBe(true);
    expect(error.isSchedulingClash).toBe(true);
    expect(error.code).toBe('appointment_conflict');
    expect(error.message).toBe('Provider already booked for that slot');
    expect(error.fieldErrors).toEqual({
      startTime: 'Overlaps an existing appointment',
    });
  });

  it('surfaces capacity failures as scheduling clashes', async () => {
    mockFetch(() =>
      respond({ code: 'capacity_exceeded', message: 'That session is full' }, { status: 409 }),
    );
    const error = await rejection(
      createAppointment({
        clientId: 'cli-1',
        providerId: 'prov-1',
        date: '2026-10-07',
        startTime: '09:00',
        endTime: '09:30',
      }),
    );
    expect(error.isSchedulingClash).toBe(true);
    expect(error.message).toBe('That session is full');
  });

  it('maps 404, 400 and 500 responses onto readable messages', async () => {
    mockFetch(() => respond({ message: 'Client not found' }, { status: 404 }));
    const notFound = await rejection(getClient('missing'));
    expect(notFound.isNotFound).toBe(true);
    expect(notFound.message).toBe('Client not found');

    mockFetch(() => respond({ errors: { firstName: 'First name is required' } }, { status: 400 }));
    const invalid = await rejection(createClient({ firstName: '', lastName: '' }));
    expect(invalid.isValidation).toBe(true);
    expect(invalid.fieldErrors).toEqual({
      firstName: 'First name is required',
    });
    expect(invalid.message).toContain('rejected');

    mockFetch(() => respond({}, { status: 500, body: 'boom' }));
    const serverError = await rejection(getDashboard());
    expect(serverError.message).toContain('unexpected problem');
  });

  it('reports an unreachable API instead of leaking a fetch error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const error = await rejection(getDashboard());
    expect(error.status).toBe(0);
    expect(error.isOffline).toBe(true);
    expect(error.message).toContain('could not reach the clinic API');
  });

  it('keeps mapped status requests on the same network and error contract', async () => {
    mockFetch(() => respond({ message: 'Invalid appointment status' }, { status: 400 }));
    const invalid = await rejection(listAppointments({ status: 'scheduled' }));
    expect(invalid.isValidation).toBe(true);
    expect(invalid.message).toBe('Invalid appointment status');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const offline = await rejection(updateAppointmentStatus('apt-1', 'scheduled'));
    expect(offline.isOffline).toBe(true);
  });

  it('wraps unknown throwables with a fallback message', () => {
    expect(toApiError('nope', 'We could not save that.').message).toBe('We could not save that.');
    expect(toApiError(new Error('boom'), 'We could not save that.').message).toBe('boom');
  });
});

describe('csv export', () => {
  it('downloads the file the server named and counts its rows', async () => {
    mockFetch(() =>
      respond(null, {
        headers: {
          'content-disposition': 'attachment; filename="clients-2026-10-07.csv"',
        },
        body: 'id,name\n1,Ada\n2,Sam\n',
      }),
    );
    const download = await exportCsv('clients');
    expect(download.filename).toBe('clients-2026-10-07.csv');
    expect(download.rowCount).toBe(2);
    expect(download.blob.type).toContain('text/csv');
  });

  it('falls back to a predictable filename', async () => {
    mockFetch(() => respond(null, { body: 'id\n1\n' }));
    const download = await exportCsv('appointments');
    expect(download.filename).toBe('caregrid-appointments.csv');
    expect(download.rowCount).toBe(1);
  });

  it('reports export failures with the server message', async () => {
    mockFetch(() => respond({ message: 'Export unavailable' }, { status: 503 }));
    const error = await rejection(exportCsv('clients'));
    expect(error.message).toBe('Export unavailable');
  });
});
