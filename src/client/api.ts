/**
 * Typed client for the Caregrid API.
 *
 * Every call goes to the real Fastify endpoints under `/api` (same origin in development through
 * the Vite proxy and in production through the Fastify static handler). Responses are parsed with
 * the tolerant readers from `normalize.ts`, and every failure is an {@link ApiError} carrying a
 * human readable message, the HTTP status, an error code and any field level details the server
 * reported. Views render `error.message` directly, so nothing here ever surfaces a raw stack trace.
 */

import {
  compact,
  normalizeAppointment,
  normalizeClient,
  normalizeClientDetail,
  normalizeDashboard,
  normalizeFollowUp,
  normalizeProvider,
  toList,
  unwrap,
} from './normalize.js';
import type {
  Appointment,
  AppointmentStatus,
  Client,
  ClientDetail,
  CsvDownload,
  CsvKind,
  DashboardData,
  FollowUp,
  FollowUpStatus,
  NewAppointmentInput,
  NewClientInput,
  NewFollowUpInput,
  Provider,
} from './types.js';

export interface ApiErrorInit {
  status: number;
  message: string;
  code?: string;
  fieldErrors?: Record<string, string>;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: Record<string, string>;
  readonly details: unknown;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code ?? (init.status === 0 ? 'network' : `http_${init.status}`);
    this.fieldErrors = init.fieldErrors ?? {};
    this.details = init.details;
  }

  get isOffline(): boolean {
    return this.status === 0;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isValidation(): boolean {
    return this.status === 400 || this.status === 422;
  }

  /** True when the server refused the write because of a clash on the calendar or capacity. */
  get isSchedulingClash(): boolean {
    return this.isConflict || /conflict|capacity|slot|booked|overlap/.test(this.code);
  }
}

const DEFAULT_MESSAGES: Record<number, string> = {
  0: 'We could not reach the clinic API. Check the server is running, then try again.',
  400: 'The clinic API rejected that request. Check the highlighted fields and try again.',
  401: 'Your session is not authorised for that action.',
  403: 'That action is not allowed for this clinic desk.',
  404: 'We could not find that record. It may have been removed.',
  409: 'That change clashes with an existing record.',
  422: 'Some details need attention before this can be saved.',
  429: 'Too many requests just now. Wait a moment and try again.',
  500: 'The clinic API hit an unexpected problem. Try again in a moment.',
  503: 'The clinic API is unavailable right now. Try again in a moment.',
};

function collectFieldErrors(value: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const field = record.field ?? record.path ?? record.instancePath ?? record.key;
      const message = record.message ?? record.error ?? record.detail;
      if (typeof field === 'string' && typeof message === 'string') {
        errors[field.replace(/^\//, '')] = message;
      }
    }
    return errors;
  }
  if (value !== null && typeof value === 'object') {
    for (const [field, message] of Object.entries(value as Record<string, unknown>)) {
      if (typeof message === 'string') {
        errors[field] = message;
      }
    }
  }
  return errors;
}

function readableMessage(payload: unknown, status: number, rawText: string): string {
  const record =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const candidates = [record.message, record.error, record.detail, record.reason];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim();
    }
    if (candidate !== null && typeof candidate === 'object') {
      const nested = candidate as Record<string, unknown>;
      if (typeof nested.message === 'string' && nested.message.trim() !== '') {
        return nested.message.trim();
      }
    }
  }
  if (status === 409) {
    const conflict = DEFAULT_MESSAGES[409];
    return conflict;
  }
  const fallback =
    DEFAULT_MESSAGES[status] ?? `The clinic API returned ${status} for that request.`;
  // A short plain-text body is the server's own wording for a 4xx. 5xx bodies may be internals,
  // so they always get the calm default message instead of a leaked stack fragment.
  if (
    status < 500 &&
    payload === null &&
    rawText.trim() !== '' &&
    rawText.length < 160 &&
    /[a-z]/i.test(rawText)
  ) {
    return rawText.trim();
  }
  return fallback;
}

function errorCode(payload: unknown, status: number): string {
  const record =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const code = record.code ?? record.errorCode ?? record.type;
  if (typeof code === 'string' && code.trim() !== '') {
    return code.trim();
  }
  return status === 0 ? 'network' : `http_${status}`;
}

export function toApiError(error: unknown, fallbackMessage = ''): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof Error) {
    return new ApiError({
      status: 0,
      message: error.message.trim() || fallbackMessage || DEFAULT_MESSAGES[0],
      code: 'network',
      details: error,
    });
  }
  return new ApiError({
    status: 0,
    message: fallbackMessage || DEFAULT_MESSAGES[0],
    details: error,
  });
}

const API_BASE = '/api';

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.trim() !== '') {
      search.set(key, value.trim());
    }
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function withSignal(init: RequestInit, signal?: AbortSignal): RequestInit {
  return signal ? { ...init, signal } : init;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch (cause) {
    throw new ApiError({
      status: 0,
      message: DEFAULT_MESSAGES[0],
      code: 'network',
      details: cause,
    });
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.trim() !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const record =
      payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    throw new ApiError({
      status: response.status,
      message: readableMessage(payload, response.status, text),
      code: errorCode(payload, response.status),
      fieldErrors: collectFieldErrors(record.fieldErrors ?? record.errors ?? record.details),
      details: payload,
    });
  }

  return payload;
}

function listPayload(payload: unknown, ...keys: string[]): unknown[] {
  return toList(payload, ...keys);
}

export async function getDashboard(signal?: AbortSignal): Promise<DashboardData> {
  const payload = await request('/dashboard', withSignal({}, signal));
  return normalizeDashboard(payload);
}

export async function listClients(
  options: { search?: string; signal?: AbortSignal } = {},
): Promise<Client[]> {
  const payload = await request(
    withQuery('/clients', { search: options.search }),
    withSignal({}, options.signal),
  );
  return listPayload(payload, 'clients').map(normalizeClient);
}

export async function getClient(id: string, signal?: AbortSignal): Promise<ClientDetail> {
  const payload = await request(`/clients/${encodeURIComponent(id)}`, withSignal({}, signal));
  const record = unwrap(payload, 'client', 'data');
  if (Object.keys(record).length === 0) {
    throw new ApiError({
      status: 404,
      message: DEFAULT_MESSAGES[404],
      code: 'not_found',
    });
  }
  return normalizeClientDetail(record);
}

export async function createClient(input: NewClientInput, signal?: AbortSignal): Promise<Client> {
  const payload = await request(
    '/clients',
    withSignal({ method: 'POST', body: JSON.stringify(compact({ ...input })) }, signal),
  );
  return normalizeClient(unwrap(payload, 'client', 'data'));
}

/**
 * The Lit views call the API's `requested` appointment status "scheduled" (see SPEC.md §3), but
 * the HTTP contract only accepts `requested`. Translate the display-only value before it reaches
 * a query string or PATCH body; every other status passes through untouched.
 */
function toApiAppointmentStatus(status: string | undefined): string | undefined {
  if (status === undefined) {
    return undefined;
  }
  return status.trim() === 'scheduled' ? 'requested' : status;
}

export async function listAppointments(
  options: {
    date?: string;
    status?: string;
    providerId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Appointment[]> {
  const payload = await request(
    withQuery('/appointments', {
      date: options.date,
      status: toApiAppointmentStatus(options.status),
      providerId: options.providerId,
    }),
    withSignal({}, options.signal),
  );
  return listPayload(payload, 'appointments').map(normalizeAppointment);
}

export async function createAppointment(
  input: NewAppointmentInput,
  signal?: AbortSignal,
): Promise<Appointment> {
  const payload = await request(
    '/appointments',
    withSignal({ method: 'POST', body: JSON.stringify(compact({ ...input })) }, signal),
  );
  return normalizeAppointment(unwrap(payload, 'appointment', 'data'));
}

export async function updateAppointmentStatus(
  id: string,
  status: AppointmentStatus,
  signal?: AbortSignal,
): Promise<Appointment> {
  const payload = await request(
    `/appointments/${encodeURIComponent(id)}`,
    withSignal(
      { method: 'PATCH', body: JSON.stringify({ status: toApiAppointmentStatus(status) }) },
      signal,
    ),
  );
  return normalizeAppointment(unwrap(payload, 'appointment', 'data'));
}

export async function listFollowUps(
  options: { status?: string; clientId?: string; signal?: AbortSignal } = {},
): Promise<FollowUp[]> {
  const payload = await request(
    withQuery('/followups', {
      status: options.status,
      clientId: options.clientId,
    }),
    withSignal({}, options.signal),
  );
  return listPayload(payload, 'followUps', 'followups', 'follow_ups').map(normalizeFollowUp);
}

export async function createFollowUp(
  input: NewFollowUpInput,
  signal?: AbortSignal,
): Promise<FollowUp> {
  const payload = await request(
    '/followups',
    withSignal({ method: 'POST', body: JSON.stringify(compact({ ...input })) }, signal),
  );
  return normalizeFollowUp(unwrap(payload, 'followUp', 'followup', 'data'));
}

export async function updateFollowUpStatus(
  id: string,
  status: FollowUpStatus,
  signal?: AbortSignal,
): Promise<FollowUp> {
  const payload = await request(
    `/followups/${encodeURIComponent(id)}`,
    withSignal({ method: 'PATCH', body: JSON.stringify({ status }) }, signal),
  );
  return normalizeFollowUp(unwrap(payload, 'followUp', 'followup', 'data'));
}

export async function listProviders(signal?: AbortSignal): Promise<Provider[]> {
  const payload = await request('/providers', withSignal({}, signal));
  return listPayload(payload, 'providers')
    .map(normalizeProvider)
    .filter((provider) => provider.id !== '');
}

function filenameFrom(response: Response, kind: CsvKind): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (match && match[1].trim() !== '') {
    return decodeURIComponent(match[1].trim());
  }
  return `caregrid-${kind}.csv`;
}

function countRows(csv: string): number {
  const rows = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
  return Math.max(0, rows.length - 1);
}

/** Downloads the server generated CSV so the export obeys the API's own filtering rules. */
export async function exportCsv(kind: CsvKind, signal?: AbortSignal): Promise<CsvDownload> {
  let response: Response;
  try {
    response = await fetch(
      `${API_BASE}/export/${kind}`,
      withSignal({ headers: { Accept: 'text/csv, application/json' } }, signal),
    );
  } catch (cause) {
    throw new ApiError({
      status: 0,
      message: DEFAULT_MESSAGES[0],
      code: 'network',
      details: cause,
    });
  }
  const text = await response.text();
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const record =
      payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    throw new ApiError({
      status: response.status,
      message: readableMessage(payload, response.status, text),
      code: errorCode(payload, response.status),
      fieldErrors: collectFieldErrors(record.fieldErrors ?? record.errors),
      details: payload,
    });
  }
  return {
    filename: filenameFrom(response, kind),
    blob: new Blob([text], { type: 'text/csv;charset=utf-8' }),
    rowCount: countRows(text),
  };
}
