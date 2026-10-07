# Caregrid — Specification

Caregrid is a local-first coordination desk for pop-up community health clinics. It keeps client
intake, conflict-aware appointment scheduling, follow-up work and auditable outcomes in one calm
workspace that runs on a single machine with a SQLite file as the system of record.

This document is the contract of record for behaviour, data shape and API. Where implementation
choices are left open, the acceptance criteria below still apply.

- **Stack:** Lit 3 + Vite frontend, Fastify 5 TypeScript API, SQLite (`better-sqlite3`).
- **Runtime:** Node 20.19+ and npm 10+. TypeScript strict mode everywhere.
- **Ports:** the production server serves `dist/client` and the API on `4173`. In development Vite
  serves the UI on `5173` and proxies `/api` to `4173`.

### Project layout and entry points

| Path                           | Contract                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`                   | Vite entry; must keep loading `/src/client/main.ts` as a module script                                                                                  |
| `src/client/`                  | Lit 3 components; `main.ts` is the client entry point and mounts into `#app`                                                                            |
| `src/server/server.ts`         | API entry point; `npm start` runs its build output as `node dist/server/server.js`                                                                      |
| `src/shared/`                  | Types/constants imported by both sides                                                                                                                  |
| `tests/unit/`                  | Vitest, Node environment (add `// @vitest-environment jsdom` per file for DOM component tests)                                                          |
| `tests/integration/`           | Vitest against a real Fastify instance; use an exported app factory with `app.inject()`, or spawn the server on an ephemeral port with its own database |
| `tests/e2e/`                   | Playwright specs (desktop + mobile projects) against the config-managed server on port 4183                                                             |
| `dist/server/`, `dist/client/` | Build outputs; never edited by hand                                                                                                                     |

Relative imports inside `src/server` and `src/shared` use the `.js` extension in the specifier
(NodeNext); Vite, Vitest and TypeScript resolve them to the `.ts` sources. Client-only modules may
omit the extension.

---

## 1. User

**Primary user:** the community clinic coordinator — the person who runs a pop-up clinic day. They
arrive with a list of clients, a handful of volunteer providers and a room with a fixed number of
seats. They work at a laptop or tablet at the front desk, often in short bursts between people
arriving, and they must not accidentally double-book a provider or overfill a session.

**Jobs to be done**

1. See, at a glance, how much room is left in today's sessions and what still needs attention.
2. Register a client quickly and find them again by name or phone.
3. Book an appointment that is genuinely free for the client, the provider and the session.
4. Move an appointment or follow-up through its lifecycle, with a record of who changed what, when
   and why.
5. Work a follow-up queue and hand a filtered copy to a partner organisation as CSV.

**Out of scope for this product:** clinical decision support, prescriptions, billing/insurance,
authentication, and multi-clinic tenancy (see [Limitations](#13-limitations-and-non-goals)).

---

## 2. Substantive domain capabilities

Two capabilities carry the product beyond CRUD and are the main review targets:

1. **Conflict-aware scheduling and capacity enforcement.** Every appointment write (create or
   reschedule) is validated in one transaction against provider overlap, client overlap, session
   capacity, session state and session date. Conflicts are rejected with a machine-readable code and
   structured details; nothing is partially written.
2. **Auditable state transitions plus computed dashboard analytics.** Appointment, follow-up and
   session lifecycle changes are validated against an explicit transition table and recorded in an
   append-only audit log (actor, reason, timestamps). The dashboard is computed server-side with SQL
   aggregates (capacity/utilisation per session, appointment counts by status, provider load,
   follow-up pressure) rather than being assembled in the browser.

---

## 3. Domain model

All identifiers are opaque strings (UUID v4 generated on the server). Timestamps are ISO-8601 UTC
(`created_at`, `updated_at`, audit `created_at`). Scheduling values are **clinic-local naive**
datetimes: `YYYY-MM-DD` for dates and `HH:MM` (24h) for times, so a clinic day never shifts because
a laptop or server is in another timezone.

### `clients`

| Column               | Type    | Rules                                                    |
| -------------------- | ------- | -------------------------------------------------------- |
| `id`                 | TEXT PK | UUID                                                     |
| `full_name`          | TEXT    | required, trimmed, 2–120 chars                           |
| `phone`              | TEXT    | required, trimmed, 5–30 chars, digits/space/`+`/`-`/`()` |
| `email`              | TEXT    | optional, must contain a single `@` when present         |
| `date_of_birth`      | TEXT    | optional `YYYY-MM-DD`, must not be in the future         |
| `preferred_language` | TEXT    | default `English`                                        |
| `address`            | TEXT    | optional                                                 |
| `notes`              | TEXT    | optional, ≤ 2000 chars                                   |
| `archived_at`        | TEXT    | NULL = active; set by archive, cleared by restore        |
| `created_at`         | TEXT    | ISO-8601 UTC                                             |
| `updated_at`         | TEXT    | ISO-8601 UTC                                             |

### `providers`

| Column       | Type    | Rules                                                                                                                 |
| ------------ | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `id`         | TEXT PK | UUID                                                                                                                  |
| `full_name`  | TEXT    | required, 2–120 chars                                                                                                 |
| `role`       | TEXT    | `physician`, `nurse_practitioner`, `registered_nurse`, `counsellor`, `community_health_worker`, `pharmacist`, `other` |
| `email`      | TEXT    | optional                                                                                                              |
| `active`     | INTEGER | `0`/`1`, default `1`                                                                                                  |
| `created_at` | TEXT    | ISO-8601 UTC                                                                                                          |
| `updated_at` | TEXT    | ISO-8601 UTC                                                                                                          |

### `sessions` (a clinic session on a date)

| Column         | Type    | Rules                                                |
| -------------- | ------- | ---------------------------------------------------- |
| `id`           | TEXT PK | UUID                                                 |
| `name`         | TEXT    | required, 2–120 chars                                |
| `location`     | TEXT    | required, 2–200 chars                                |
| `session_date` | TEXT    | required `YYYY-MM-DD`                                |
| `start_time`   | TEXT    | required `HH:MM`                                     |
| `end_time`     | TEXT    | required `HH:MM`, must be after `start_time`         |
| `capacity`     | INTEGER | required, `1..500`                                   |
| `status`       | TEXT    | `scheduled` (default), `open`, `closed`, `cancelled` |
| `notes`        | TEXT    | optional, ≤ 2000 chars                               |
| `created_at`   | TEXT    | ISO-8601 UTC                                         |
| `updated_at`   | TEXT    | ISO-8601 UTC                                         |

### `appointments`

| Column        | Type    | Rules                                                                                      |
| ------------- | ------- | ------------------------------------------------------------------------------------------ |
| `id`          | TEXT PK | UUID                                                                                       |
| `client_id`   | TEXT    | FK → `clients.id`, required                                                                |
| `provider_id` | TEXT    | FK → `providers.id`, required                                                              |
| `session_id`  | TEXT    | FK → `sessions.id`, required                                                               |
| `starts_at`   | TEXT    | required, `YYYY-MM-DDTHH:MM`, must fall inside the session window and match `session_date` |
| `ends_at`     | TEXT    | required, `YYYY-MM-DDTHH:MM`, after `starts_at`                                            |
| `status`      | TEXT    | `requested` (default), `scheduled`, `checked_in`, `completed`, `cancelled`, `no_show`      |
| `reason`      | TEXT    | optional, ≤ 500 chars                                                                      |
| `notes`       | TEXT    | optional, ≤ 2000 chars                                                                     |
| `created_at`  | TEXT    | ISO-8601 UTC                                                                               |
| `updated_at`  | TEXT    | ISO-8601 UTC                                                                               |

**Slot-occupying statuses:** `requested`, `scheduled`, `checked_in`, `completed` count against
capacity. `cancelled` and `no_show` free the slot.

### `follow_ups`

| Column           | Type    | Rules                                                           |
| ---------------- | ------- | --------------------------------------------------------------- |
| `id`             | TEXT PK | UUID                                                            |
| `client_id`      | TEXT    | FK → `clients.id`, required                                     |
| `appointment_id` | TEXT    | FK → `appointments.id`, optional origin                         |
| `owner_id`       | TEXT    | FK → `providers.id`, optional accountable provider              |
| `due_date`       | TEXT    | required `YYYY-MM-DD`                                           |
| `status`         | TEXT    | `open` (default), `in_progress`, `done`, `cancelled`            |
| `summary`        | TEXT    | required, 3–500 chars                                           |
| `completed_at`   | TEXT    | ISO-8601 UTC, set when status becomes `done`, cleared otherwise |
| `created_at`     | TEXT    | ISO-8601 UTC                                                    |
| `updated_at`     | TEXT    | ISO-8601 UTC                                                    |

### `audit_events` (append-only)

| Column        | Type    | Rules                                                                     |
| ------------- | ------- | ------------------------------------------------------------------------- |
| `id`          | TEXT PK | UUID                                                                      |
| `entity_type` | TEXT    | `appointment`, `follow_up`, `session`, `client`, `provider`               |
| `entity_id`   | TEXT    | id of the affected row                                                    |
| `action`      | TEXT    | `created`, `updated`, `status_changed`, `archived`, `restored`, `deleted` |
| `from_status` | TEXT    | nullable                                                                  |
| `to_status`   | TEXT    | nullable                                                                  |
| `actor`       | TEXT    | required, 1–80 chars; defaults to `coordinator` in the UI                 |
| `reason`      | TEXT    | nullable, ≤ 500 chars                                                     |
| `details`     | TEXT    | nullable JSON string with a diff or rejection context                     |
| `created_at`  | TEXT    | ISO-8601 UTC                                                              |

Audit rows are never updated or deleted by the application.

### Indexes

`appointments(session_id)`, `appointments(provider_id, starts_at)`, `appointments(client_id, starts_at)`,
`appointments(status)`, `follow_ups(status, due_date)`, `follow_ups(client_id)`,
`audit_events(entity_type, entity_id, created_at DESC)`, `sessions(session_date)`.

### Integrity

- SQLite foreign keys are enabled (`PRAGMA foreign_keys = ON`); deleting a client with appointments
  is refused — clients are archived instead.
- Every multi-step rule (conflict checks + insert/update, state change + audit append) runs inside a
  single `better-sqlite3` transaction. A rejected write leaves no partial rows.

---

## 4. Status transition rules

Any transition not listed below is refused with HTTP `409` and error code `invalid_transition`.
Every accepted transition writes exactly one `audit_events` row with `action = "status_changed"`,
`from_status`, `to_status`, `actor` and the optional `reason`.

### Appointments

| From         | Allowed to                           |
| ------------ | ------------------------------------ |
| `requested`  | `scheduled`, `cancelled`             |
| `scheduled`  | `checked_in`, `cancelled`, `no_show` |
| `checked_in` | `completed`                          |
| `completed`  | — (terminal)                         |
| `cancelled`  | — (terminal)                         |
| `no_show`    | — (terminal)                         |

### Follow-ups

| From          | Allowed to                         |
| ------------- | ---------------------------------- |
| `open`        | `in_progress`, `done`, `cancelled` |
| `in_progress` | `open`, `done`, `cancelled`        |
| `done`        | — (terminal)                       |
| `cancelled`   | — (terminal)                       |

### Sessions

| From        | Allowed to            |
| ----------- | --------------------- |
| `scheduled` | `open`, `cancelled`   |
| `open`      | `closed`, `cancelled` |
| `closed`    | — (terminal)          |
| `cancelled` | — (terminal)          |

A session may only be closed when it has no appointment in `requested` or `checked_in` state; that
attempt is refused with `409 invalid_transition` and `details.blockingAppointmentIds`.

Creating an entity is not a status transition, but `created` audit rows are written for clients,
providers, sessions, appointments and follow-ups so the audit endpoint is a complete change history.

---

## 5. Workflows and acceptance criteria

### W1 — Dashboard capacity review

The landing view answers "how full is today, and what needs attention?".

- **AC 1.1** The dashboard defaults to `CAREGRID_TODAY` when set, otherwise the machine's local
  date. `GET /api/dashboard?date=YYYY-MM-DD` overrides it. A malformed date returns `400`
  `validation_error`; a date with no sessions returns an empty `sessions: []` and zeroed totals (not
  a 404).
- **AC 1.2** The page shows: total clients, active providers, appointments today by status, open and
  overdue follow-ups, and one row per session with `booked`, `capacity`, `remaining` and
  `utilization` (0–1, rounded to two decimals).
- **AC 1.3** Sessions at capacity or over capacity are flagged with text ("Full", "Over capacity")
  and an icon — never colour alone. A day with no sessions renders an explicit empty state that
  links to session creation.
- **AC 1.4** Dashboard numbers are computed server-side; after any mutation the client refreshes from
  the API and the numbers change accordingly. The client never recomputes capacity rules locally.

### W2 — Client intake and detail

- **AC 2.1** A new client can be registered with name and phone (the only required fields); on
  success the form resets, a `role="status"` confirmation is announced, and the client appears in the
  list without a manual reload.
- **AC 2.2** Invalid input is rejected client-side and server-side with the same rules and returns
  `400 validation_error` with one entry per invalid field. Field errors are rendered next to the
  input, linked with `aria-describedby`, and focus moves to the error summary.
- **AC 2.3** Client detail shows contact fields, appointment history (newest first, with status and
  provider) and the client's open follow-ups. Status history for that client's records is available
  from the audit endpoint.
- **AC 2.4** Clients can be archived and restored. Archived clients are hidden from the default list,
  are still addressable by id, and cannot receive new appointments (`409 client_archived`).
- **AC 2.5** Search matches name or phone, is case-insensitive and debounced. No matches renders an
  empty state with the query echoed; an empty query renders the full (active) list.

### W3 — Appointment scheduling with conflict and capacity checks

- **AC 3.1** Creating an appointment requires client, provider, session and a start/end time with
  `ends_at > starts_at`; both must fall inside the session window and on the session date. Violations
  return `400 validation_error`.
- **AC 3.2** A provider overlap (`existing.start < new.end AND new.start < existing.end`, same
  provider, slot-occupying statuses on the same date) returns `409 scheduling_conflict` with
  `details.kind = "provider"` and the conflicting appointment id.
- **AC 3.3** A client overlap returns `409 scheduling_conflict` with `details.kind = "client"`.
- **AC 3.4** Booking into a session whose slot-occupying appointment count equals `capacity` returns
  `409 capacity_exceeded` with `details.capacity` and `details.booked`. Booking into a full session
  via reschedule is refused the same way.
- **AC 3.5** A session in `closed`/`cancelled` state, or a session date in the past relative to
  `CAREGRID_TODAY`/local today, returns `409 session_unavailable` with `details.sessionStatus`.
- **AC 3.6** Unknown client/provider/session ids return `404 not_found`; the response identifies which
  id failed.
- **AC 3.7** A successful create returns `201` with the appointment and a `session` summary
  (`booked`, `capacity`, `remaining`). Conflict and capacity checks plus the insert happen in one
  transaction: a rejected booking must not consume capacity.
- **AC 3.8** `PATCH /api/appointments/:id` reschedules and re-runs every check while excluding the
  appointment being edited. The UI shows conflicts inline next to the time fields and keeps the
  entered values so the coordinator can adjust the time instead of retyping the form.

### W4 — Auditable appointment and follow-up status work

- **AC 4.1** The UI offers only transitions allowed by §4 for the current status; the server
  independently enforces the same table.
- **AC 4.2** A refused transition returns `409 invalid_transition` with `details.from` and
  `details.to`; nothing is written.
- **AC 4.3** An accepted transition appends an audit event containing actor, from, to, optional
  reason and timestamp, and the change survives a server restart (SQLite persistence).
- **AC 4.4** The actor defaults to `coordinator` and can be set per action (for example the volunteer
  name at the desk); a reason field is offered for `cancelled`, `no_show` and follow-up `cancelled`.
- **AC 4.5** The appointment and client detail views show a readable history
  ("Maria Lopez · 09:12 · scheduled → checked_in · coordinator · reason").
- **AC 4.6** Marking an appointment `completed` does not silently create a follow-up; a follow-up is
  only created explicitly, and when it is created from an appointment the link is stored.

### W5 — Follow-up queue and CSV export

- **AC 5.1** The queue lists follow-ups with client name, summary, due date, owner and status.
  Overdue items (`due_date < today`, status `open` or `in_progress`) are labelled "Overdue" in text
  and sorted first; then soonest due date, then client name.
- **AC 5.2** Creating a follow-up requires a client, a summary (3–500 chars) and a due date; owner is
  optional. Invalid input returns `400 validation_error`.
- **AC 5.3** Completing a follow-up is a status transition (`→ done`), sets `completed_at`, is
  audited, removes it from the default queue and decreases the open count.
- **AC 5.4** `GET /api/follow-ups/export.csv` exports the currently filtered queue as
  `text/csv; charset=utf-8` with `Content-Disposition: attachment`. Columns:
  `follow_up_id,client_name,client_phone,due_date,status,owner,summary`. Values containing `,`, `"`,
  `\n` or `\r` are quoted and internal quotes doubled. An empty result still returns `200` with a
  header-only body. The export never mutates data.
- **AC 5.5** Applying a filter (status, client, `dueBefore`, overdue-only) updates both the queue and
  the export in the same request shape, and the empty state offers "clear filters".

---

## 6. API contract

All endpoints are JSON (`application/json; charset=utf-8`) except the CSV export. List endpoints
accept `limit` (1–200, default 50) and `offset` (≥ 0, default 0) and return
`{ "items": [...], "total": <number> }`.

| Method | Path                           | Purpose                                                                     |
| ------ | ------------------------------ | --------------------------------------------------------------------------- |
| GET    | `/api/health`                  | Liveness + database probe; `200` or `503`                                   |
| GET    | `/api/dashboard`               | Computed analytics for `?date=`                                             |
| GET    | `/api/clients`                 | List/search clients (`query`, `status`, paging)                             |
| POST   | `/api/clients`                 | Create client                                                               |
| GET    | `/api/clients/:id`             | Client detail with appointments and follow-ups                              |
| PATCH  | `/api/clients/:id`             | Update client fields                                                        |
| POST   | `/api/clients/:id/archive`     | Soft-archive (audited)                                                      |
| POST   | `/api/clients/:id/restore`     | Restore archived client (audited)                                           |
| GET    | `/api/providers`               | List providers (`active`)                                                   |
| POST   | `/api/providers`               | Create provider                                                             |
| PATCH  | `/api/providers/:id`           | Update provider (name, role, email, active)                                 |
| GET    | `/api/sessions`                | List sessions (`date` or `from`/`to`)                                       |
| POST   | `/api/sessions`                | Create session                                                              |
| GET    | `/api/sessions/:id`            | Session detail with capacity summary and appointments                       |
| PATCH  | `/api/sessions/:id`            | Update session details (not status)                                         |
| POST   | `/api/sessions/:id/status`     | Status transition (audited)                                                 |
| GET    | `/api/appointments`            | List appointments (`date`, `sessionId`, `clientId`, `providerId`, `status`) |
| POST   | `/api/appointments`            | Create appointment with conflict/capacity checks                            |
| GET    | `/api/appointments/:id`        | Appointment detail                                                          |
| PATCH  | `/api/appointments/:id`        | Reschedule with conflict/capacity checks                                    |
| POST   | `/api/appointments/:id/status` | Status transition (audited)                                                 |
| GET    | `/api/follow-ups`              | Follow-up queue (`status`, `clientId`, `dueBefore`, `overdue`)              |
| POST   | `/api/follow-ups`              | Create follow-up                                                            |
| PATCH  | `/api/follow-ups/:id`          | Update summary/due date/owner (audited as `updated`)                        |
| POST   | `/api/follow-ups/:id/status`   | Status transition (audited)                                                 |
| GET    | `/api/follow-ups/export.csv`   | CSV export of the filtered queue                                            |
| GET    | `/api/audit`                   | Audit events (`entityType`, `entityId`, `limit`, newest first)              |

Status-transition bodies share one shape:

```json
{ "status": "checked_in", "actor": "coordinator", "reason": "Client arrived at 09:10" }
```

### Error shape

Every non-2xx JSON response uses one envelope:

```json
{
  "error": {
    "code": "scheduling_conflict",
    "message": "Dr. Reyes is already booked 09:30–10:00 in this session.",
    "details": [{ "kind": "provider", "conflictingAppointmentId": "8f1c…" }]
  }
}
```

| HTTP | `error.code`                                                      | Used for                                  |
| ---- | ----------------------------------------------------------------- | ----------------------------------------- |
| 400  | `validation_error`                                                | Body/query/params fail schema validation  |
| 404  | `not_found`                                                       | Unknown id or route                       |
| 409  | `scheduling_conflict`, `capacity_exceeded`, `session_unavailable` | Scheduling rules (W3)                     |
| 409  | `invalid_transition`                                              | Refused status change (W4)                |
| 409  | `client_archived`, `duplicate_phone`                              | Client lifecycle/consistency rules        |
| 500  | `internal_error`                                                  | Unexpected failure; message stays generic |

Successful writes return the created/updated resource (`201` for creates, `200` otherwise).

`GET /api/health` returns:

```json
{ "status": "ok", "today": "2026-10-07", "database": "ok" }
```

`today` is `CAREGRID_TODAY` when set. The endpoint runs a trivial database query so a broken or
unwritable database surfaces as `503` with `{"error":{"code":"internal_error",…}}` rather than a
false green smoke test.

### Dashboard response (abridged)

```json
{
  "date": "2026-10-07",
  "totals": {
    "clients": 42,
    "activeProviders": 6,
    "appointments": 18,
    "byStatus": {
      "requested": 1,
      "scheduled": 9,
      "checked_in": 3,
      "completed": 4,
      "cancelled": 1,
      "no_show": 0
    },
    "openFollowUps": 7,
    "overdueFollowUps": 2
  },
  "sessions": [
    {
      "id": "…",
      "name": "Downtown pop-up",
      "location": "Central Library",
      "sessionDate": "2026-10-07",
      "startTime": "09:00",
      "endTime": "15:00",
      "status": "open",
      "capacity": 24,
      "booked": 18,
      "remaining": 6,
      "utilization": 0.75
    }
  ],
  "providerLoad": [{ "providerId": "…", "providerName": "Dr. Reyes", "appointments": 5 }]
}
```

---

## 7. Persistence decisions

- **Engine:** `better-sqlite3`, used synchronously. A pop-up clinic desk is a single-writer workload;
  the synchronous API removes an entire class of race conditions around the capacity check.
- **Location:** `data/caregrid.sqlite` by default, overridable with `CAREGRID_DB_FILE`. The parent
  directory is created on startup. `:memory:` is supported and used by tests.
- **Pragmas on every connection:** `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`,
  `synchronous = NORMAL`.
- **Schema bootstrap:** idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
  statements run at startup; the schema version is tracked in `PRAGMA user_version` so future
  migrations have a hook. No migration framework.
- **Determinism:** when the database has no sessions (or `CAREGRID_SEED=force`), a deterministic seed
  is inserted, anchored to `CAREGRID_TODAY` (default: the local date): today's and tomorrow's
  sessions, providers with distinct roles, a handful of clients and follow-ups including one overdue
  item. `CAREGRID_SEED=none` disables seeding entirely (integration tests).
- **Durability:** data survives server restarts; the production smoke check and the integration
  suite both exercise reopen-after-write. There is no in-memory production mode.
- **Reset:** `npm run db:reset` removes the SQLite file (plus `-wal`/`-shm`). The next start recreates
  and reseeds it.

### Configuration

| Variable           | Default                | Meaning                                                                 |
| ------------------ | ---------------------- | ----------------------------------------------------------------------- |
| `PORT`             | `4173`                 | HTTP port for the production/API server                                 |
| `HOST`             | `127.0.0.1`            | Bind address                                                            |
| `CAREGRID_DB_FILE` | `data/caregrid.sqlite` | SQLite file; `:memory:` allowed                                         |
| `CAREGRID_TODAY`   | local date             | `YYYY-MM-DD`; overrides "today" for dashboards, seeds and overdue rules |
| `CAREGRID_SEED`    | `auto`                 | `auto` (seed empty database) or `none`                                  |

---

## 8. HTTP server behaviour

- One Fastify 5 process serves both the API and the built client.
- `@fastify/static` serves `dist/client` with `index.html` fallback for client-side routes, and
  `404`s unknown `/api/*` routes with the JSON error envelope (never the SPA shell).
- `dist/client` must exist before `npm start`; `npm run build` produces both `dist/server/server.js`
  and `dist/client/`.
- Graceful shutdown on `SIGINT`/`SIGTERM` closes the database and stops accepting requests.
- Unknown routes and thrown errors return the error envelope from §6; internal errors never leak
  stack traces to clients.

---

## 9. Interface, accessibility and UI states

**Layout.** Persistent top navigation (Dashboard, Clients, Schedule, Follow-ups) with the current
clinic date and a "today" chip. Content is a single column below 768 px, two columns from 768 px, and
a sidebar + content layout from 1280 px. Tables scroll horizontally rather than clipping, and touch
targets are at least 44×44 px.

**Every data view implements four states.**

| State   | Requirement                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------- |
| Loading | Skeleton or spinner marked `aria-busy="true"`, layout reserved so content does not jump              |
| Empty   | Plain-language explanation and one primary action ("Book the first appointment")                     |
| Error   | What failed, retry button, and the server's message when it is safe to show                          |
| Success | `role="status"` confirmation; destructive actions (cancel appointment, archive client) confirm first |

**Accessibility.**

- Semantic landmarks (`header`, `nav`, `main`), one `h1` per view, a skip link to `#main`.
- All inputs have visible `<label>`s; icon-only buttons carry `aria-label`s.
- Full keyboard operation: tab order follows the visual order, `Enter` submits forms, `Escape`
  closes dialogs, dialogs trap focus and restore it to the trigger, and focus is never lost when rows
  are updated.
- Status changes and validation results are announced with `aria-live="polite"` regions.
- Focus is always visible (`:focus-visible` ring, ≥ 2 px, non-colour-only).
- Status is communicated with text plus shape/icon, not colour alone; contrast ≥ 4.5:1 for body text.
- Respect `prefers-reduced-motion` for transitions.
- Tables have `<caption>`s and `scope="col"` headers; the schedule grid is a real table with
  keyboard-selectable cells, not a div grid.

---

## 10. Determinism and testing strategy

| Suite                  | Command                          | Contract                                                                                                                                                                                                |
| ---------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (domain rules)    | `npm test` / `npm test -- --run` | Pure logic: overlap detection, capacity arithmetic, transition tables, CSV quoting, validators. No I/O.                                                                                                 |
| Integration (API + DB) | `npm run test:integration`       | Real Fastify instance via `app.inject()` and real SQLite (`:memory:` or a temp file, `CAREGRID_SEED=none`). Covers validation, conflicts, capacity, transitions, audit rows, persistence across reopen. |
| E2E (browser)          | `npm run test:e2e`               | Playwright starts its own built server with a disposable SQLite file and `CAREGRID_TODAY=2026-10-07`; it never reuses a developer's server. Two core journeys plus one failure path.                    |

- `CAREGRID_TODAY=2026-10-07` makes dashboard defaults, seed dates and overdue classification stable
  in tests; browser tests are written against that date.
- Playwright runs the `chromium` desktop project and a Pixel-class mobile viewport project against
  the same server. `npm run test:e2e` is self-contained: it rebuilds and starts the app on port 4183
  (override with `CAREGRID_E2E_PORT`), using `CAREGRID_DB_FILE` under `data/e2e/`.
- CI (`.github/workflows/ci.yml`) runs the same gates in the same order:
  `npm ci` → `npx playwright install chromium` → lint → format check → typecheck → unit →
  integration → build → e2e → production smoke against `http://127.0.0.1:4173/api/health`.

---

## 11. Milestones (implementation order)

1. Foundation: package/config/CI/docs (this document), server entry + health, client shell.
2. Schema, seed and repositories; dashboard endpoint.
3. Clients and providers CRUD + intake UI.
4. Sessions, appointments, scheduling rules + schedule UI.
5. Status transitions + audit endpoint + history UI.
6. Follow-ups, CSV export + queue UI.
7. Accessibility pass, empty/error states, E2E journeys, CI green.

---

## 12. Definition of done

- Every acceptance criterion in §5 is implemented and covered by at least one automated test.
- `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run test:integration`,
  `npm run build` and `npm run test:e2e` pass from a clean checkout.
- `npm start` serves the built client and `GET /api/health` returns `200` on `127.0.0.1:4173`.
- Data written through the API is still present after a server restart.
- No placeholder controls, mocked production flows or suppressed type errors.

---

## 13. Limitations and non-goals

- **No authentication or authorisation.** Caregrid runs on a trusted local machine. `actor` is a
  self-declared label, not a verified identity, so the audit trail is honest but not tamper-proof.
- **Naive clinic-local datetimes.** No timezone conversion, no DST arithmetic; times are wall-clock
  values for a single location.
- **Single process, single writer.** SQLite handles one writer at a time; two servers must not point
  at the same file.
- **No offline mode or sync.** The client requires the local server; there is no service worker or
  conflict-free replication.
- **No data import.** CSV export is one-way; bulk client import is out of scope.
- **No SMS/email reminders.** Follow-ups are a worklist, not a notification system.
- **No clinical records.** Appointments store a reason and notes, not diagnoses or prescriptions.
- **Pagination is offset-based** (`limit`/`offset`), which is fine at clinic scale (< 10k rows) but
  not at national scale.
- **Audit retention is unbounded.** Nothing prunes `audit_events`; a production deployment would need
  a retention policy.
- **SQLite file is unencrypted**, as is typical for a local desktop tool; the file must live on a
  disk the operator controls.
