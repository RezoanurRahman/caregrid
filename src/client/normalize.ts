/**
 * Tolerant readers for the Caregrid API.
 *
 * The client never trusts a payload blindly: the server contract is typed, but a renamed or
 * missing field must still leave the coordinator with a usable screen. These helpers convert
 * `unknown` JSON into the view models in `types.ts`, accepting the field aliases the API may
 * legitimately use and degrading to empty strings / zero rather than `undefined`.
 */

import type {
  ActivityEntry,
  Appointment,
  AppointmentStatus,
  Client,
  ClientDetail,
  ConsentSummary,
  DashboardData,
  DashboardMetrics,
  FollowUp,
  FollowUpStatus,
  KnownAppointmentStatus,
  KnownFollowUpStatus,
  Priority,
  Provider,
  SessionCapacity,
} from "./types.js";

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** First key present with a usable (non null/undefined) value. */
export function pick(record: Json, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

export function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/[^0-9.eE+-]/g, ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

/** Counts tolerate either a number or a collection. */
export function count(value: unknown, fallback = 0): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  return num(value, fallback);
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (
      [
        "true",
        "yes",
        "y",
        "1",
        "granted",
        "given",
        "signed",
        "active",
      ].includes(normalised)
    ) {
      return true;
    }
    if (
      ["false", "no", "n", "0", "declined", "withdrawn", "none"].includes(
        normalised,
      )
    ) {
      return false;
    }
  }
  return fallback;
}

/**
 * Percentages arrive as 0-1 fractions, 0-100 numbers, or strings such as `"82%"`.
 * Always normalised to a 0-100 number rounded to one decimal.
 */
export function percent(value: unknown, fallback = 0): number {
  const hadSymbol = typeof value === "string" && value.includes("%");
  const raw = num(value, Number.NaN);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  const scaled = hadSymbol || raw > 1 ? raw : raw * 100;
  return Math.min(100, Math.max(0, Math.round(scaled * 10) / 10));
}

/** Local (clinic) calendar day for a Date. */
export function toDateOnly(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function todayDateOnly(now: Date = new Date()): string {
  return toDateOnly(now);
}

/** Anything date-ish (ISO day, ISO timestamp, Date) reduced to `YYYY-MM-DD`, else "". */
export function dateOnly(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toDateOnly(value);
  }
  if (typeof value === "string") {
    const match = /(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    if (match) {
      return match[1];
    }
  }
  return "";
}

/**
 * Clock time reduced to `HH:MM`. Timestamps keep the wall-clock digits the server wrote, so an
 * appointment stored as 09:00 renders as 09:00 wherever the client runs.
 */
export function clockTime(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const timestamp = /T(\d{2}:\d{2})/.exec(trimmed);
    if (timestamp) {
      return timestamp[1];
    }
    const bare = /^(\d{1,2}):(\d{2})/.exec(trimmed);
    if (bare) {
      return `${bare[1].padStart(2, "0")}:${bare[2]}`;
    }
  }
  return "";
}

function minutesOf(clock: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Inclusive-from / exclusive-to duration in minutes, or null when the clocks are unusable. */
export function durationMinutes(start: string, end: string): number | null {
  const from = minutesOf(start);
  const to = minutesOf(end);
  if (from === null || to === null || to <= from) {
    return null;
  }
  return to - from;
}

export function unwrap(payload: unknown, ...keys: string[]): Json {
  const record = asRecord(payload);
  for (const key of [...keys, "data", "result", "item"]) {
    const nested = asRecord(record[key]);
    if (Object.keys(nested).length > 0) {
      return nested;
    }
  }
  return record;
}

/** Collection readers: bare arrays, keyed arrays, or a generic envelope. */
export function toList(payload: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  for (const key of [...keys, "items", "data", "results", "rows"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

const APPOINTMENT_STATUS_ALIASES: Record<string, KnownAppointmentStatus> = {
  scheduled: "scheduled",
  booked: "scheduled",
  requested: "scheduled",
  pending: "scheduled",
  open: "scheduled",
  confirmed: "confirmed",
  confirmation: "confirmed",
  checked_in: "checked_in",
  check_in: "checked_in",
  checkin: "checked_in",
  arrived: "checked_in",
  waiting: "checked_in",
  in_clinic: "checked_in",
  completed: "completed",
  complete: "completed",
  done: "completed",
  finished: "completed",
  seen: "completed",
  no_show: "no_show",
  noshow: "no_show",
  did_not_attend: "no_show",
  missed: "no_show",
  cancelled: "cancelled",
  canceled: "cancelled",
};

function normalizeKey(value: unknown): string {
  return str(value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function normalizeAppointmentStatus(value: unknown): AppointmentStatus {
  return APPOINTMENT_STATUS_ALIASES[normalizeKey(value)] ?? "unknown";
}

const FOLLOW_UP_STATUS_ALIASES: Record<string, KnownFollowUpStatus> = {
  open: "open",
  todo: "open",
  new: "open",
  pending: "open",
  not_started: "open",
  in_progress: "in_progress",
  started: "in_progress",
  active: "in_progress",
  working: "in_progress",
  done: "done",
  complete: "done",
  completed: "done",
  closed: "done",
  cancelled: "cancelled",
  canceled: "cancelled",
};

export function normalizeFollowUpStatus(value: unknown): FollowUpStatus {
  return FOLLOW_UP_STATUS_ALIASES[normalizeKey(value)] ?? "unknown";
}

const PRIORITY_ALIASES: Record<string, Priority> = {
  high: "high",
  urgent: "high",
  critical: "high",
  p1: "high",
  medium: "medium",
  normal: "medium",
  moderate: "medium",
  p2: "medium",
  low: "low",
  routine: "low",
  p3: "low",
};

export function normalizePriority(value: unknown): Priority {
  return PRIORITY_ALIASES[normalizeKey(value)] ?? "unknown";
}

function personName(record: Json, prefix: string, ...keys: string[]): string {
  const direct = str(pick(record, ...keys)).trim();
  if (direct) {
    return direct;
  }
  const nested = asRecord(pick(record, prefix, `${prefix}Person`));
  const joined = [
    str(pick(nested, "firstName", "first_name")),
    str(pick(nested, "lastName", "last_name")),
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return joined;
}

export function normalizeAppointment(raw: unknown): Appointment {
  const record = asRecord(raw);
  const client = asRecord(pick(record, "client", "patient"));
  const provider = asRecord(pick(record, "provider", "clinician", "staff"));
  const startRaw = pick(
    record,
    "startTime",
    "start",
    "startsAt",
    "time",
    "from",
  );
  const endRaw = pick(record, "endTime", "end", "endsAt", "to");
  const startTime = clockTime(startRaw);
  let endTime = clockTime(endRaw);
  if (!endTime && startTime) {
    const start = minutesOf(startTime);
    if (start !== null) {
      const end = start + num(pick(record, "durationMinutes", "duration"), 0);
      if (end > start) {
        endTime = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
      }
    }
  }
  const rawStatus = str(pick(record, "status", "state", "appointmentStatus"));
  return {
    id: str(pick(record, "id", "appointmentId", "appointment_id")),
    clientId:
      str(pick(record, "clientId", "client_id", "patientId")) || str(client.id),
    clientName:
      personName(
        record,
        "client",
        "clientName",
        "client_name",
        "patientName",
      ) || [str(client.firstName), str(client.lastName)].join(" ").trim(),
    providerId:
      str(pick(record, "providerId", "provider_id", "clinicianId")) ||
      str(provider.id),
    providerName:
      personName(
        record,
        "provider",
        "providerName",
        "provider_name",
        "clinicianName",
      ) || str(provider.name),
    date: dateOnly(
      pick(
        record,
        "date",
        "day",
        "appointmentDate",
        "scheduledFor",
        "startsAt",
      ),
    ),
    startTime,
    endTime,
    type: str(pick(record, "type", "visitType", "service", "kind")),
    reason: str(pick(record, "reason", "notes", "details")),
    location: str(pick(record, "location", "room", "site")),
    status: normalizeAppointmentStatus(rawStatus),
    rawStatus,
    notes: str(pick(record, "notes", "note")),
  };
}

export function normalizeConsent(record: Json): ConsentSummary {
  const raw = pick(
    record,
    "consent",
    "consentStatus",
    "consent_status",
    "consentState",
  );
  const nested = asRecord(raw);
  const label = str(pick(nested, "status", "label", "state"));
  const grantedRaw =
    typeof raw === "object" && raw !== null
      ? (nested.granted ?? nested.given ?? nested.status ?? nested.state)
      : raw;
  const granted =
    grantedRaw === undefined
      ? bool(
          pick(record, "consentGranted", "consent_given", "hasConsent"),
          false,
        )
      : bool(grantedRaw, false);
  const date = dateOnly(
    pick(nested, "date", "grantedAt", "signedAt", "updatedAt") ??
      pick(record, "consentDate", "consentRecordedAt"),
  );
  const derivedLabel =
    label || (granted ? "Consent recorded" : "Consent not recorded");
  return { granted, label: derivedLabel, date };
}

export function normalizeClient(raw: unknown): Client {
  const record = asRecord(raw);
  const firstName = str(
    pick(record, "firstName", "first_name", "givenName"),
  ).trim();
  const lastName = str(
    pick(record, "lastName", "last_name", "familyName"),
  ).trim();
  const explicitName = str(
    pick(record, "fullName", "full_name", "name"),
  ).trim();
  const fullName =
    explicitName ||
    [firstName, lastName].filter(Boolean).join(" ") ||
    "Unnamed client";
  return {
    id: str(pick(record, "id", "clientId", "client_id")),
    firstName: firstName || fullName.split(" ")[0] || "",
    lastName: lastName || fullName.split(" ").slice(1).join(" "),
    fullName,
    phone: str(pick(record, "phone", "phoneNumber", "mobile", "telephone")),
    email: str(pick(record, "email", "emailAddress")),
    preferredContact: str(
      pick(
        record,
        "preferredContact",
        "preferred_contact",
        "contactPreference",
      ),
    ),
    status: str(pick(record, "status", "clientStatus", "state"), "active"),
    consent: normalizeConsent(record),
    notes: str(pick(record, "notes", "note", "summary")),
    since: dateOnly(
      pick(
        record,
        "createdAt",
        "since",
        "registeredAt",
        "intakeDate",
        "created_at",
      ),
    ),
    language: str(
      pick(record, "language", "preferredLanguage", "languagePreference"),
    ),
  };
}

export function normalizeActivity(raw: unknown): ActivityEntry {
  const record = asRecord(raw);
  return {
    id: str(pick(record, "id", "activityId")),
    summary: str(
      pick(record, "summary", "title", "action", "type", "kind"),
      "Update",
    ),
    detail: str(pick(record, "detail", "description", "notes", "message")),
    kind: str(pick(record, "kind", "type", "category")),
    at: str(pick(record, "at", "createdAt", "timestamp", "occurredAt", "date")),
  };
}

export function normalizeClientDetail(raw: unknown): ClientDetail {
  const base = normalizeClient(raw);
  const record = asRecord(raw);
  return {
    ...base,
    appointments: asArray(pick(record, "appointments", "visits")).map(
      normalizeAppointment,
    ),
    followUps: asArray(
      pick(record, "followUps", "followups", "follow_ups"),
    ).map(normalizeFollowUp),
    activity: asArray(pick(record, "activity", "timeline", "history", "audit"))
      .map(normalizeActivity)
      .filter((entry) => entry.summary !== ""),
  };
}

export function normalizeFollowUp(raw: unknown): FollowUp {
  const record = asRecord(raw);
  const client = asRecord(pick(record, "client", "patient"));
  const rawStatus = str(pick(record, "status", "state"));
  const rawPriority = str(pick(record, "priority", "urgency", "severity"));
  return {
    id: str(pick(record, "id", "followUpId", "followupId")),
    clientId: str(pick(record, "clientId", "client_id")) || str(client.id),
    clientName:
      personName(record, "client", "clientName", "client_name") ||
      [str(client.firstName), str(client.lastName)].join(" ").trim(),
    appointmentId: str(pick(record, "appointmentId", "appointment_id")),
    title: str(pick(record, "title", "summary", "reason", "task"), "Follow-up"),
    detail: str(pick(record, "detail", "details", "description", "notes")),
    priority: normalizePriority(rawPriority),
    rawPriority,
    status: normalizeFollowUpStatus(rawStatus),
    rawStatus,
    dueDate: dateOnly(pick(record, "dueDate", "due_date", "due", "dueOn")),
    assignee: personName(
      record,
      "assignee",
      "assigneeName",
      "assignee_name",
      "owner",
      "ownerName",
    ),
    createdAt: str(pick(record, "createdAt", "created_at")),
    completedAt: str(pick(record, "completedAt", "completed_at", "resolvedAt")),
  };
}

export function normalizeProvider(raw: unknown): Provider {
  const record = asRecord(raw);
  const firstName = str(pick(record, "firstName", "first_name"));
  const lastName = str(pick(record, "lastName", "last_name"));
  return {
    id: str(pick(record, "id", "providerId", "provider_id")),
    name:
      str(pick(record, "name", "fullName", "providerName")).trim() ||
      [firstName, lastName].filter(Boolean).join(" "),
    role: str(pick(record, "role", "title", "position")),
    specialty: str(pick(record, "specialty", "speciality", "service")),
  };
}

export function normalizeSession(raw: unknown): SessionCapacity {
  const record = asRecord(raw);
  const provider = asRecord(pick(record, "provider", "clinician"));
  const startTime = clockTime(
    pick(record, "startTime", "start", "startsAt", "from"),
  );
  return {
    id: str(pick(record, "id", "sessionId")),
    label: str(pick(record, "label", "name", "title", "session")),
    startTime,
    endTime: clockTime(pick(record, "endTime", "end", "endsAt", "to")),
    booked: count(
      pick(
        record,
        "booked",
        "bookedCount",
        "used",
        "filled",
        "reserved",
        "count",
        "appointments",
      ),
      0,
    ),
    capacity: num(
      pick(record, "capacity", "total", "slots", "max", "totalSlots"),
      0,
    ),
    providerName:
      str(pick(record, "providerName", "clinicianName")) ||
      providerName(provider),
    location: str(pick(record, "location", "room", "site")),
  };
}

function providerName(provider: Json): string {
  return (
    str(provider.name) ||
    [str(provider.firstName), str(provider.lastName)].filter(Boolean).join(" ")
  );
}

export function normalizeDashboardMetrics(raw: unknown): DashboardMetrics {
  const record = asRecord(raw);
  return {
    appointmentsToday: num(
      pick(
        record,
        "appointmentsToday",
        "todayAppointments",
        "appointments_today",
        "bookedToday",
        "totalToday",
      ),
      0,
    ),
    booked: num(
      pick(record, "booked", "bookedCount", "bookedToday", "bookings"),
      0,
    ),
    capacity: num(
      pick(
        record,
        "capacity",
        "capacityCount",
        "totalCapacity",
        "slots",
        "slotCount",
      ),
      0,
    ),
    completionRate: percent(
      pick(
        record,
        "completionRate",
        "completedRate",
        "completionRatePct",
        "completionPercent",
      ),
      0,
    ),
    completedToday: num(
      pick(record, "completedToday", "completedCount", "completed"),
      0,
    ),
    openFollowUps: num(
      pick(
        record,
        "openFollowUps",
        "openFollowups",
        "followUpsOpen",
        "openFollowUpCount",
      ),
      0,
    ),
    overdueFollowUps: num(
      pick(
        record,
        "overdueFollowUps",
        "overdueFollowups",
        "followUpsOverdue",
        "overdueFollowUpCount",
      ),
      0,
    ),
    activeClients: num(
      pick(record, "activeClients", "clientsActive", "totalClients", "clients"),
      0,
    ),
  };
}

export function normalizeDashboard(raw: unknown): DashboardData {
  const record = unwrap(raw, "dashboard", "data", "result");
  const clinic = asRecord(pick(record, "clinic", "clinicContext", "context"));
  const metrics = normalizeDashboardMetrics(
    pick(record, "metrics", "summary", "totals") ?? record,
  );
  const upcoming = toList(
    pick(
      record,
      "upcomingAppointments",
      "upcoming",
      "appointments",
      "todayAppointments",
    ),
  ).map(normalizeAppointment);
  const sessions = toList(
    pick(
      record,
      "sessionCapacity",
      "sessions",
      "capacityBySession",
      "sessionBars",
    ),
  ).map(normalizeSession);
  const followUps = toList(
    pick(
      record,
      "followUpPreview",
      "followUps",
      "followups",
      "followUpPreviewList",
    ),
  ).map(normalizeFollowUp);
  const date =
    dateOnly(pick(record, "date", "today", "serviceDate", "clinicDate")) ||
    todayDateOnly();
  const resolvedSessions =
    sessions.length > 0 || metrics.capacity <= 0
      ? sessions
      : [
          {
            id: "today",
            label: "Today's clinic",
            startTime: "",
            endTime: "",
            booked: metrics.booked,
            capacity: metrics.capacity,
            providerName: "",
            location: str(clinic.site),
          },
        ];
  return {
    date,
    clinicName:
      str(pick(record, "clinicName", "clinic_name")) ||
      str(pick(clinic, "name")) ||
      "Caregrid Community Clinic",
    site:
      str(pick(record, "site", "location")) ||
      str(pick(clinic, "site", "location")),
    metrics,
    upcoming,
    sessions: resolvedSessions,
    followUps,
  };
}

/** Drops empty request fields so the API receives only what the coordinator actually entered. */
export function compact(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    output[key] = typeof value === "string" ? value.trim() : value;
  }
  return output;
}
