# Caregrid — Specification

Caregrid is a local-first coordination desk for pop-up community health clinics. It keeps client
intake, conflict-aware appointment scheduling, follow-up work and auditable outcomes in one calm
workspace that runs on a single machine with a SQLite file as the system of record.

This document is the contract of record for the behaviour that is actually shipped. It describes
the user, five connected workflows, the data model, the HTTP API, persistence, testing and the
honest limitations.

- **Stack:** Lit 3 + Vite frontend, Fastify 5 TypeScript API, SQLite via `better-sqlite3`, zod
  request validation.
- **Runtime:** Node 20.19+ and npm 10+. TypeScript strict mode.
- **Ports:** production `npm run build && npm start` serves `dist/client` and the API on `4173`
  (default host `0.0.0.0`). Development runs Vite on `5173` and proxies `/api` to `4173`.
- **Entry points:** `src/client/main.ts` (Lit app), `src/server/server.ts` (compiled to
  `dist/server/server.js`), `src/shared/` (types, constants, Zod schemas). Server-side relative
  imports use the `.js` extension because the server compiles with NodeNext.

---

## 1. User and scope

**Primary user: the community clinic coordinator.** One person at the front desk of a pop-up clinic,
working on a laptop or tablet in short bursts between clients arriving. They keep the roster, book
visits without double-booking a provider or overfilling a room, move work through a lifecycle, and
hand a partner organisation a CSV at the end of the day.

**Jobs to be done**

1. See how full today is and what still needs attention.
2. Register a client quickly and find them again by name, email or phone.
3. Book an appointment that is genuinely free for the client, the provider and the session.
4. Move appointments and follow-ups through their lifecycle and see what changed.
5. Filter the follow-up queue, work it, and export clinic data as CSV.

**Out of scope:** clinical decision support, prescriptions, billing/insurance, authentication and
multi-clinic tenancy (see §11).

---

## 2. Substantive capabilities

1. **Conflict-aware scheduling and capacity enforcement.** Every appointment create is one
   `better-sqlite3` transaction that resolves the clinic session for the requested date, checks the
   window against the session's hours, rejects provider and client overlap for blocking statuses,
   and rejects a full session. The insert and its activity event commit together or not at all, so
   a rejected booking consumes no capacity and leaves no partial row.
2. **Auditable status transitions and computed analytics.** Appointments and follow-ups move only
   through an explicit transition table. Every accepted create and status change appends a row to
   `activity_events`, and the client record exposes that trail. The dashboard is aggregated
   server-side in SQL — capacity, status counts, completion rate and follow-up pressure are
   computed by the database, never by the browser.

---

## 3. Data model

All identifiers are readable, stable strings: `prov-0001`, `sess-2026-10-07-am`, `cli-0001`,
`apt-0001`, `fup-0001`. `activity_events.id` is an autoincrementing integer. Timestamps are ISO-8601
UTC strings; clinic dates and times are naive wall-clock values (`YYYY-MM-DD`, `HH:mm`), so the
clinic day does not shift with the server timezone.

### 3.1 SQLite tables

These are the tables actually created by `src/server/db.ts` (plus the API extension table created by
`src/server/routes.ts`):

| Table               | Key columns                                                                                                                          | Notes                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`         | `id`, `name`, `role`, `email` (unique), `phone`, `active`, `created_at`, `updated_at`                                                | Read-only through the API; populated by the seed.                                                                                                                    |
| `clinic_sessions`   | `id`, `date`, `start_time`, `end_time`, `location`, `capacity`, `lead_provider_id`, `notes`, timestamps                              | `CHECK (end_time > start_time)`. Read-only through the API; populated by the seed.                                                                                   |
| `clients`           | `id`, `full_name`, `email`, `phone`, `date_of_birth`, `status` (`active`/`waitlist`/`inactive`), `notes`, timestamps                 | The API composes `full_name` from `firstName` + `lastName`.                                                                                                          |
| `appointments`      | `id`, `client_id`, `provider_id`, `session_id`, `date`, `start_time`, `end_time`, `status`, `reason`, `notes`, timestamps            | Status values are the public ones in §4.4.                                                                                                                           |
| `follow_ups`        | `id`, `client_id`, `appointment_id`, `assignee_id`, `title`, `detail`, `status`, `due_date`, `completed_at`, timestamps              | `completed_at` is set exactly when status is `done`.                                                                                                                 |
| `activity_events`   | `id` (autoincrement), `entity_type` (`client`/`appointment`/`follow_up`), `entity_id`, `client_id`, `action`, `detail`, `created_at` | Append-only trail for creates and status changes; no update or delete path.                                                                                          |
| `meta`              | `key`, `value`                                                                                                                       | Holds the seed marker `seed_version`.                                                                                                                                |
| `api_record_extras` | `entity`, `record_id`, `data` (JSON), `updated_at`                                                                                   | API extension table for fields the store schema does not model: client `consentStatus`/`preferredName`/`preferredContact`, appointment `type`, follow-up `priority`. |

Indexes cover appointments by session/provider/client/status, follow-ups by status/client/assignee,
activity events by client and entity, sessions by date, and client names/status. Foreign keys are
enabled on every connection.

### 3.2 Public JSON vocabulary

The HTTP contract uses camelCase names and a small number of presentation-friendly aliases:

- Clients: `firstName`, `lastName`, `preferredName`, `preferredContact`
  (`phone`|`sms`|`email`|`letter`|`in_person`, default `phone`), `accessNotes`, `consentStatus`,
  `status`, `dateOfBirth` (null when unknown).
- Sessions: `opensAt`/`closesAt` plus `startTime`/`endTime`, `booked`, `remaining` and
  `utilization` (0–1, rounded to two decimals).
- Appointments: `date`, `startTime`, `endTime`, `type`, `status`, plus the denormalized
  `clientName`, `providerName`, `sessionId` and `location`.
- Follow-ups: `title`, `dueDate`, `priority`, `status`, `overdue`, `completedAt`, plus
  `clientName`/`assigneeName`.

Some legacy vocabulary remains in the storage and presentation layers and is mapped at the
boundary: API client status `archived` is stored as `inactive` and `waitlist` passes through; the
Lit client labels a `requested` appointment "Scheduled" internally. The HTTP contract in §6 is
canonical.

---

## 4. Scheduling, status and transaction rules

### 4.1 Session resolution and validation

- `POST /api/appointments` accepts `date`, `startTime` and `endTime`; the request does not carry a
  `sessionId`. The server picks a session **on that date** whose `start_time <= startTime` and
  `end_time >= endTime`, preferring one with available capacity. If no session covers the window,
  the response is `409 CONFLICT` with `details.kind = "session_unavailable"` and the requested
  window.
- `endTime` must be later than `startTime` (`400 VALIDATION`), and the window must fall inside the
  resolved session's hours and match its date (`400 VALIDATION`).
- Unknown client, provider or session ids return `404 NOT_FOUND`. A client that is not `active`, or
  a provider that is not active, cannot be booked (`400 VALIDATION`).

### 4.2 Conflicts

Provider and client overlap use half-open intervals (`[start, end)`), so a booking that touches the
previous one end-to-start is allowed. Only **blocking statuses** occupy calendars:

`requested`, `confirmed`, `checked_in`, `completed`.

`cancelled` and `no_show` do not block. A clash returns `409 CONFLICT` with
`details.conflicts: [{ kind: "provider" | "client", id, name, startTime, endTime }]`. The same
booking may report a provider and a client conflict; both are listed.

### 4.3 Capacity

Capacity counts appointments whose status is `requested`, `confirmed`, `checked_in`, `completed` or
`no_show`; `cancelled` releases the slot. A session whose available capacity is zero rejects the
booking with `409 CONFLICT` and `details.capacity` / `details.booked`.

### 4.4 Status transitions

The store enforces the tables below on every status write. Anything else returns
`409 INVALID_TRANSITION` with `details.from`, `details.to` and `details.allowed`. Creates are not
transitions; they append a `created` activity event.

**Appointments**

| From                                | Allowed to                           |
| ----------------------------------- | ------------------------------------ |
| `requested`                         | `confirmed`, `cancelled`             |
| `confirmed`                         | `checked_in`, `no_show`, `cancelled` |
| `checked_in`                        | `completed`, `no_show`               |
| `completed`, `no_show`, `cancelled` | — terminal                           |

**Follow-ups**

| From                | Allowed to                  |
| ------------------- | --------------------------- |
| `open`              | `in_progress`, `dismissed`  |
| `in_progress`       | `open`, `done`, `dismissed` |
| `done`, `dismissed` | — terminal                  |

Every accepted appointment/follow-up create and status change appends exactly one row to
`activity_events` inside the same transaction as the data change. The trail is readable through
`GET /api/clients/:id` (up to 200 events, newest first). There is no standalone audit endpoint.

### 4.5 Transactions

- Client create: duplicate-email check, insert and activity event in one transaction.
- Appointment create: session resolution, client/provider checks, capacity check, conflict query,
  insert and activity event in one immediate transaction.
- Appointment status change and follow-up status change: read, transition check, update and
  activity event in one immediate transaction.
- Follow-up create: client/provider/appointment checks, insert and activity event in one
  transaction.
- Bulk client import: every row (and its activity event) in one immediate transaction; in
  `reject_duplicates` mode one duplicate aborts the whole import.

---

## 5. Workflows and acceptance criteria

### W1 — Overview: capacity and attention

The landing view answers "how full is today, and what needs attention?".

- **AC 1.1** The dashboard uses `CAREGRID_TODAY` when it is set to a valid date, otherwise the
  machine's local date. There is no `?date=` override; the response's `asOfDate` and `today` state
  which day was used.
- **AC 1.2** The response exposes `metrics.appointmentsToday`, `metrics.completedToday`,
  `metrics.openFollowUps`, `metrics.overdueFollowUps` and `metrics.availableCapacityToday`, plus the
  compatibility fields `capacityTotal`, `capacityBooked`, `completionRate` (0–1) and `byStatus`
  (counts per appointment status for today).
- **AC 1.3** `sessions` contains sessions dated on or after "today" (ordered, capped at 20) with
  `booked`, `remaining` and `utilization`; `upcomingAppointments` contains `requested`/`confirmed`/
  `checked_in` appointments on or after today (capped 25); `followUps` contains open/in-progress
  follow-ups (capped 25) and `overdueFollowUps` the overdue subset.
- **AC 1.4** The UI renders metric cards, a capacity bar per session, the upcoming list and the
  follow-up preview, with loading, empty and error states and a refresh action.
- **AC 1.5** Dashboard numbers are computed by the API. After a mutation, the relevant view reloads
  from the API rather than recomputing capacity or conflict rules in the browser.

### W2 — Client intake, search and detail

- **AC 2.1** `POST /api/clients` requires a name (either `firstName` + `lastName` or `fullName`) and
  a phone. `email`, `preferredName`, `dateOfBirth`, `accessNotes`/`notes`, `consentStatus`
  (`pending`|`granted`|`declined`), `preferredContact`
  (`phone`|`sms`|`email`|`letter`|`in_person`, default `phone`) and `status`
  (`active`|`archived`|`waitlist`) are optional. Success returns `201` with
  `Location: /api/clients/:id` and the created client; an omitted `preferredContact` is stored and
  returned as `phone`.
- **AC 2.2** Invalid input returns `400 VALIDATION` with `details.issues: [{ path, message }]`. The
  UI validates the same rules before submitting, renders field-level and form-level errors, and
  keeps the entered values so nothing has to be retyped.
- **AC 2.3** `GET /api/clients?search=` matches name, email or phone case-insensitively (`q` is an
  alias); `status` filters `active`/`archived`/`waitlist`. The response is a plain JSON array.
- **AC 2.4** `GET /api/clients/:id` returns `{ client, summary, appointments, followUps, activity }`.
  `summary` carries appointment totals, open/overdue follow-ups and the last completed visit date;
  appointments are newest first, open follow-ups come first, and `activity` is the newest-first
  trail for the client and their records.
- **AC 2.5** The UI offers debounced search, a labelled intake dialog, a roster with an empty state,
  and a detail panel with contact, consent, appointment history, follow-up history and the activity
  timeline.

### W3 — Appointment scheduling

- **AC 3.1** `POST /api/appointments` requires `clientId`, `providerId`, `date`, `startTime` and
  `endTime`. `type` (`intake`|`check_in`|`follow_up`|`screening`|`other`, default `other`), `reason`
  and `notes` are optional. Success returns `201` with `Location` and the resolved `sessionId`.
- **AC 3.2** Session resolution, window checks, provider/client overlap and capacity are enforced as
  in §4; failures return the shared error envelope with a machine-readable code and structured
  details.
- **AC 3.3** `GET /api/appointments` filters by `date`, `from`, `to`, `status`, `type`, `clientId`,
  `providerId`, `sessionId` and free-text `q`; the result is a plain array ordered by date and start
  time.
- **AC 3.4** Status changes go through `PATCH` or `POST /api/appointments/:id/status`. The §4.4
  table is enforced server-side and every change is audited. `PATCH /api/appointments/:id` calls the
  same status handler; there is no reschedule or field-update endpoint.
- **AC 3.5** The UI offers date, status and provider filters, a labelled create dialog (client,
  provider, date, type, start/end, reason, notes), status actions per row, and renders conflict
  responses inline on the form — including no-session, overlap and capacity messages — while
  preserving the entered values.

### W4 — Follow-up queue

- **AC 4.1** `POST /api/follow-ups` (alias `POST /api/followups`) requires `clientId` and `title`.
  `dueDate` defaults to seven days after the server's current date; `assigneeId` (or an `assignee`
  provider id/name/email), `appointmentId`, `priority` (`low`|`normal`|`high`) and
  `notes`/`detail` are optional. Success returns `201` with `Location`.
- **AC 4.2** `GET /api/follow-ups` filters by `status` (`open`|`in_progress`|`done`|`dismissed`),
  `priority`, `assigneeId`, `clientId`, `overdue`, `dueBefore` and free-text `q`; the result is a
  plain array with open and overdue work ordered first.
- **AC 4.3** Status changes go through `PATCH` or `POST /api/follow-ups/:id/status` and the
  `PATCH /api/followups/:id` alias. The §4.4 transitions are enforced and audited; reaching `done`
  sets `completedAt`.
- **AC 4.4** The UI renders filter chips (all, open, in progress, done, overdue), a labelled create
  form, status actions per row, overdue text labels, and loading/empty/error states with retry or
  "clear filters" actions. The server remains authoritative: an action outside §4.4 is rejected and
  the error is shown without changing the row.

### W5 — CSV export and JSON client import

- **AC 5.1** `GET /api/export/:entity` accepts `clients`, `appointments` and `follow_ups` (plus the
  `follow-ups`/`followups` aliases) and returns `text/csv; charset=utf-8` with
  `Content-Disposition: attachment`. `GET /api/follow-ups/export.csv` exports follow-ups. Unknown
  entities return `404 NOT_FOUND` and list the supported values.
- **AC 5.2** CSV values containing a comma, quote, CR or LF are wrapped in double quotes with
  embedded quotes doubled (RFC 4180). Exports are whole-table snapshots with no filter query
  parameters, and they never mutate data.
- **AC 5.3** `POST /api/import/clients` accepts `{ rows: [...], mode }` with up to 500 rows, where
  `mode` is `reject_duplicates` or `skip_duplicates`. Each row requires `firstName` and `lastName`
  (phone optional), and duplicates are detected by email or normalised full name.
  `reject_duplicates` aborts with `409 CONFLICT`; `skip_duplicates` imports the rest and returns
  `{ mode, totalRows, imported, created, skipped, errors }` (`errors` is present and empty today;
  row failures use the error envelope).
- **AC 5.4** The Overview offers CSV export buttons for clients and appointments (the API also
  exports follow-ups). The UI reports the downloaded filename and row count, and surfaces export
  failures as an alert.
- **AC 5.5** Imported clients are created in one transaction, receive a `created` activity event
  whose detail says they were added by CSV import, and appear in the roster immediately.

---

## 6. HTTP API contract

All responses are JSON (`application/json; charset=utf-8`) except the CSV endpoints. API responses
carry `cache-control: no-store` and an `x-request-id` header.

| Method      | Path                           | Query / body                                                                                                  | Returns                                                                                      |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| GET         | `/api/health`                  | —                                                                                                             | `200 { "status": "ok", "storage": "sqlite" }`, or `503` with the error envelope              |
| GET         | `/api/dashboard`               | —                                                                                                             | `{ asOfDate, today, metrics, upcomingAppointments, followUps, overdueFollowUps, sessions }`  |
| GET         | `/api/providers`               | —                                                                                                             | Array of providers                                                                           |
| GET         | `/api/sessions`                | `date` or `from`/`to`                                                                                         | Array of sessions with capacity summaries                                                    |
| GET         | `/api/clients`                 | `search`/`q`, `status`                                                                                        | Array of clients                                                                             |
| POST        | `/api/clients`                 | client fields (§5 W2)                                                                                         | `201` created client + `Location`                                                            |
| GET         | `/api/clients/:id`             | —                                                                                                             | `{ client, summary, appointments, followUps, activity }`                                     |
| GET         | `/api/appointments`            | `date`, `from`, `to`, `status`, `type`, `clientId`, `providerId`, `sessionId`, `q`                            | Array of appointments                                                                        |
| POST        | `/api/appointments`            | `clientId`, `providerId`, `date`, `startTime`, `endTime`, `type?`, `reason?`, `notes?`                        | `201` created appointment + `Location`                                                       |
| PATCH, POST | `/api/appointments/:id/status` | `{ status }`                                                                                                  | Updated appointment                                                                          |
| PATCH       | `/api/appointments/:id`        | `{ status }`                                                                                                  | Alias of the status endpoint; not a reschedule                                               |
| GET         | `/api/follow-ups`              | `status`, `priority`, `assigneeId`, `clientId`, `overdue`, `dueBefore`, `q`                                   | Array of follow-ups                                                                          |
| POST        | `/api/follow-ups`              | `clientId`, `title`, `dueDate?`, `assigneeId?`/`assignee?`, `appointmentId?`, `priority?`, `notes?`/`detail?` | `201` created follow-up + `Location`                                                         |
| PATCH, POST | `/api/follow-ups/:id/status`   | `{ status }`                                                                                                  | Updated follow-up                                                                            |
| GET         | `/api/followups`               | status/assignee/overdue/client filters                                                                        | List alias of `/api/follow-ups` (priority, `dueBefore` and `q` are not applied by the alias) |
| POST        | `/api/followups`               | same body as `/api/follow-ups`                                                                                | Create alias                                                                                 |
| PATCH       | `/api/followups/:id`           | `{ status }`                                                                                                  | Alias of the follow-up status endpoint                                                       |
| GET         | `/api/export/:entity`          | `clients` \| `appointments` \| `follow_ups`                                                                   | `text/csv` attachment                                                                        |
| GET         | `/api/follow-ups/export.csv`   | —                                                                                                             | `text/csv` attachment                                                                        |
| POST        | `/api/import/clients`          | `{ rows, mode? }`                                                                                             | `{ mode, totalRows, imported, created, skipped, errors }`                                    |

**Not implemented — do not call or document as existing:** provider or session create/update/delete,
client update/archive/restore, `/api/audit`, appointment reschedule/field update, list pagination
(`limit`/`offset`) or pagination envelopes, dashboard `date` override, session status lifecycle.

### 6.1 Request enums

| Field                    | Values                                                                      |
| ------------------------ | --------------------------------------------------------------------------- |
| Appointment type         | `intake`, `check_in`, `follow_up`, `screening`, `other`                     |
| Appointment status       | `requested`, `confirmed`, `checked_in`, `completed`, `no_show`, `cancelled` |
| Follow-up status         | `open`, `in_progress`, `done`, `dismissed`                                  |
| Follow-up priority       | `low`, `normal`, `high`                                                     |
| Client consent           | `pending`, `granted`, `declined`                                            |
| Client preferred contact | `phone`, `sms`, `email`, `letter`, `in_person` (default `phone`)            |
| Client status            | `active`, `archived`, `waitlist` (the API stores `archived` as `inactive`)  |

### 6.2 Health

`GET /api/health` returns exactly `{ "status": "ok", "storage": "sqlite" }` when a trivial store
read succeeds. When the database is broken or unwritable it returns `503` with
`{ "error": { "code": "INTERNAL", "message": "The clinic database is unavailable." } }`; a failed
probe never reports healthy.

### 6.3 Dashboard payload (abridged)

```json
{
  "asOfDate": "2026-10-07",
  "today": "2026-10-07",
  "metrics": {
    "activeClients": 6,
    "appointmentsToday": 8,
    "completedToday": 2,
    "openFollowUps": 3,
    "overdueFollowUps": 2,
    "availableCapacityToday": 14,
    "capacityTotal": 22,
    "capacityBooked": 8,
    "completionRate": 0.25,
    "byStatus": {
      "requested": 1,
      "confirmed": 3,
      "checked_in": 1,
      "completed": 2,
      "cancelled": 1,
      "no_show": 0
    }
  },
  "upcomingAppointments": [],
  "followUps": [],
  "overdueFollowUps": [],
  "sessions": []
}
```

The counts above illustrate the shape; exact values depend on the seed and mutations. `completionRate`
is `completedToday / capacityBooked`, `0` when nothing is booked, rounded to two decimals;
`availableCapacityToday` never goes below zero.

### 6.4 CSV columns

| Export         | Header row                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `clients`      | `id,full_name,email,phone,date_of_birth,status,notes,created_at,updated_at`                                                        |
| `appointments` | `id,date,start_time,end_time,status,client_id,client_name,provider_id,provider_name,session_id,reason,notes,created_at,updated_at` |
| `follow_ups`   | `id,client_id,client_name,assignee_id,assignee_name,title,detail,status,due_date,overdue,completed_at,created_at,updated_at`       |

---

## 7. Errors

Every non-2xx JSON response uses one envelope:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Session sess-2026-10-07-am is full (12 slots booked).",
    "details": {
      "field": "sessionId",
      "sessionId": "sess-2026-10-07-am",
      "capacity": 12,
      "booked": 12
    }
  }
}
```

| HTTP | `error.code`         | Used for                                                                                                               |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION`         | Body/query/params fail zod validation, malformed JSON, window/date failures, inactive client or provider               |
| 404  | `NOT_FOUND`          | Unknown record id, unknown API route, unknown export entity (the 404 body is the envelope, never the SPA shell)        |
| 409  | `CONFLICT`           | No session covers the window, provider/client overlap, capacity exceeded, duplicate client email, duplicate import row |
| 409  | `INVALID_TRANSITION` | Status change outside §4.4                                                                                             |
| 500  | `INTERNAL`           | Unexpected failure; logged server-side with a generic message to the client                                            |

The error mapper can also emit `METHOD_NOT_ALLOWED` (405), `PAYLOAD_TOO_LARGE` (413) and
`UNSUPPORTED_MEDIA_TYPE` (415) when Fastify reports those statuses. `details` is optional:
`VALIDATION` errors may carry `details.issues: [{ path, message }]`, and domain errors carry
structured context such as `conflicts`, `capacity`/`booked`, `kind: "session_unavailable"`, or
`from`/`to`/`allowed`. Messages never include SQL text or stack traces.

---

## 8. UI decisions

**Layout and navigation.** A persistent shell with Overview, Appointments, Clients and Follow-ups, a
clinic context line (date and "updated at") and one polite live region for announcements. The
layout is single-column on small screens and wider on tablet/desktop; lists scroll rather than
clip; touch targets stay finger-sized; dialogs become full-screen under 640px.

**States.** Every data view implements:

| State   | Decision                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------- |
| Loading | Skeleton/status panel with `role="status"` and `aria-busy` semantics; layout reserved so it does not jump |
| Empty   | Plain-language explanation plus one primary action ("Add a client", "Book the first appointment")         |
| Error   | What failed, the server's safe message and a retry action                                                 |
| Success | `role="status"` announcement (and toast for background actions); destructive actions confirm first        |

Mutations reload the affected data from the API; the browser never recomputes conflict or capacity
rules.

**Accessibility.** Semantic landmarks, one `h1` per view, a skip link to `#main`, visible labels for
every input, `aria-label`s for icon-only controls, `aria-live="polite"` for status messages and
`role="alert"` for failures. Dialogs are Lit elements that move focus into the panel, trap Tab,
close on `Escape`, always offer a labelled close button and restore focus to the trigger. Status is
conveyed with text plus icon/shape, never colour alone; `prefers-reduced-motion` is respected and
focus is always visible.

**Forms.** Client, appointment and follow-up forms validate client-side with the same rules as the
API (required fields, lengths, email/phone shape, end after start), keep values after a failed
submit, and render server field errors beside the inputs. Appointment conflict responses (overlap,
capacity, no session) are shown inline on the form.

---

## 9. Persistence, seed and configuration

- **Engine:** `better-sqlite3`, used synchronously. A pop-up desk is a single-writer workload, and
  the synchronous API removes a class of races around capacity checks.
- **Pragmas:** `foreign_keys = ON`, `busy_timeout = 5000`, `journal_mode = WAL` for file databases
  (`:memory:` cannot use WAL), `synchronous = NORMAL`; schema version tracked in
  `PRAGMA user_version = 1`.
- **Location:** `data/caregrid.sqlite` by default, overridable with `CAREGRID_DB_FILE`. The parent
  directory is created on startup. `:memory:` is supported for tests only; it is not a production
  mode.
- **Schema bootstrap:** idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` on
  every connection. `api_record_extras` is created by the API layer. There is no migration
  framework; the `user_version` pragma is the hook.
- **Client extras:** client `consentStatus`, `preferredName` and `preferredContact` are persisted
  as JSON rows in `api_record_extras`, so they survive close/reopen with the rest of the database.
  A missing or unrecognised `preferredContact` reads back as `phone`.
- **Seed:** when `CAREGRID_SEED` is not `none`, an empty database receives deterministic fixtures
  for a clinic on 2026-10-06, 2026-10-07 and 2026-10-08: five providers (one inactive), six
  sessions, six clients, twelve appointments with status history, and seven follow-ups, including
  two overdue open items (due 2026-10-05 and 2026-10-03). The `meta.seed_version` marker makes
  seeding idempotent; a database that has rows but no marker is marked as already seeded rather
  than overwritten. Mutations persist across close/reopen, and the integration suite verifies that
  reopening does not reseed duplicates.
- **Determinism:** `CAREGRID_TODAY` (a valid `YYYY-MM-DD`) overrides the clinic's "today" for the
  dashboard and overdue classification. The seed fixture dates are fixed; the E2E suite pins
  `CAREGRID_TODAY=2026-10-07` so the demo day matches them.
- **Reset:** `npm run db:reset` removes the SQLite file plus its `-wal`/`-shm` companions; the next
  start recreates and reseeds it.

| Variable           | Default                | Meaning                                                          |
| ------------------ | ---------------------- | ---------------------------------------------------------------- |
| `PORT`             | `4173`                 | HTTP port for the production/API server                          |
| `HOST`             | `0.0.0.0`              | Bind address                                                     |
| `CAREGRID_DB_FILE` | `data/caregrid.sqlite` | SQLite file; `:memory:` for tests                                |
| `CAREGRID_TODAY`   | local date             | `YYYY-MM-DD` clinic "today" for dashboards and overdue rules     |
| `CAREGRID_SEED`    | `auto`                 | `none` disables seeding; any other value seeds an empty database |

**HTTP server behaviour.** One Fastify 5 process serves both the API and the built client.
`@fastify/static` serves `dist/client`, unknown non-API GET routes fall back to `index.html` when a
build exists, and unknown `/api/*` routes return the JSON envelope. `SIGINT`/`SIGTERM` close the
database and stop the server. `npm start` requires `npm run build` to have produced
`dist/server/server.js` and `dist/client/`.

---

## 10. Test strategy and gates

| Suite       | Command                    | Coverage                                                                                                                                                                                                                                                            |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `npm test -- --run`        | Pure domain rules: transition tables, half-open overlap, session-window assertions, capacity counting, CSV quoting, client-side validation and normalisation. No I/O.                                                                                               |
| Integration | `npm run test:integration` | Real Fastify instance via `app.inject()` and real SQLite: health contract, seeded dashboard and reads, validation/404 envelopes, provider and client conflicts, status transitions, follow-up workflow, CSV exports, import modes, persistence across close/reopen. |
| End-to-end  | `npm run test:e2e`         | Playwright `chromium` and `mobile-chromium` (Pixel 7): conflict-aware booking journey, `Escape` closes the booking dialog, client intake → follow-up completion journey, responsive shell.                                                                          |
| Smoke       | `npm start`                | Production server serves the built client and answers `GET http://127.0.0.1:4173/api/health`.                                                                                                                                                                       |

- `npm run test:e2e` is self-managing: `playwright.config.ts` wipes `data/e2e/playwright.sqlite`
  (override `CAREGRID_E2E_DB_FILE`), builds the app, starts it on **port 4183** (override
  `CAREGRID_E2E_PORT`) with `CAREGRID_TODAY=2026-10-07`, waits for `/api/health`, and never reuses
  a server that is already running. The normal production server runs on **port 4173**.
- `CAREGRID_TODAY=2026-10-07` makes dashboard defaults and overdue classification stable in tests;
  the seed fixture dates match it.
- The registered gates, in order:
  1. `npm ci && npx playwright install chromium`
  2. `npm run lint && npm run format:check`
  3. `npm run typecheck`
  4. `npm test -- --run`
  5. `npm run test:integration`
  6. `npm run build`
  7. `npm run test:e2e`
  8. `npm start`, then health URL `http://127.0.0.1:4173/api/health`

---

## 11. Limitations and non-goals

- **No authentication or authorisation.** Caregrid runs on a trusted local machine; there is no
  login, role or tenancy model.
- **No actor identity or reasons.** Status changes record the action and a human-readable detail,
  but no user/actor or reason field is accepted or stored.
- **Providers and sessions are read-only.** `GET /api/providers` and `GET /api/sessions` expose
  seeded data; there is no provider/session create, update, delete or status endpoint, and no
  session lifecycle beyond date, hours, location and capacity.
- **No archive/restore.** There are no client update or archive/restore endpoints and no UI for
  them; `archived` is an API-level client status mapped to the store's `inactive`.
- **No reschedule endpoint or UI.** `PATCH /api/appointments/:id` is the status-change alias;
  changing a time means cancelling and booking again.
- **No standalone audit endpoint.** The `activity_events` trail is append-only but is only exposed
  through `GET /api/clients/:id`, capped at 200 events; there is no dashboard provider-load metric.
- **No pagination.** List endpoints return plain arrays; the dashboard caps its session,
  appointment and follow-up lists (20/25/25) but the other endpoints return everything.
- **CSV export is whole-table and one-way.** Exports have no filter parameters and never mutate
  data. JSON client import is implemented (up to 500 rows) with duplicate handling by email or
  normalised name.
- **No SMS/email reminders.** Follow-ups are a worklist, not a notification system.
- **No clinical records.** Appointments store a reason and notes, not diagnoses or prescriptions.
- **Naive clinic-local datetimes.** No timezone conversion and no DST arithmetic.
- **Single process, single writer.** Two servers must not point at the same SQLite file.
- **No offline mode or sync.** The client requires the local API; there is no service worker or
  replication.
- **SQLite is unencrypted.** The file must live on a disk the operator controls.
