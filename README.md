# Caregrid

A local-first coordination desk for pop-up community health clinics. Caregrid keeps client intake,
conflict-aware appointment scheduling, follow-up work and auditable outcomes in one calm workspace
backed by a single SQLite file on your machine.

- **Frontend:** Lit 3 + Vite (TypeScript, strict)
- **API:** Fastify 5 (TypeScript, strict)
- **Storage:** SQLite via `better-sqlite3`
- **Runtime:** Node 20.19+ and npm 10+

Two capabilities carry the product beyond CRUD:

- **Conflict-aware scheduling and capacity enforcement** — every booking is checked, inside one
  SQLite transaction, against the resolved clinic session, provider and client overlap, and session
  capacity.
- **Auditable status transitions and computed analytics** — appointment and follow-up status changes
  are validated against an explicit transition table, appended to `activity_events`, and the
  dashboard is aggregated server-side in SQL.

See [SPEC.md](SPEC.md) for the user workflows, acceptance criteria, API contract and limitations.

---

## Quick start (three commands)

```bash
npm ci        # install dependencies
npm run build # compile the API (tsc) and the client (Vite)
npm start     # serve dist/client + the API on http://127.0.0.1:4173
```

Open <http://127.0.0.1:4173>. On first start Caregrid creates and seeds the database at
`data/caregrid.sqlite`, so the dashboard, schedule and follow-up queue already hold a deterministic
clinic day.

If you also plan to run the browser tests, install Chromium once after `npm ci`:

```bash
npx playwright install chromium
```

`npm run test:e2e` fails with a clear Playwright message if Chromium is missing; the command above
is the documented fix.

---

## Requirements

| Tool | Version                                 |
| ---- | --------------------------------------- |
| Node | 20.19+ (22.12+ recommended, CI uses 22) |
| npm  | 10+                                     |

`better-sqlite3` ships prebuilt binaries for current Node releases. If a prebuild is unavailable for
your platform, Node's native build toolchain (Python 3, `make`, a C++ compiler) is required; see
[Troubleshooting](#troubleshooting).

---

## Commands

| Command                    | What it does                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run dev`              | Runs the API (`tsx watch`, 4173) and Vite (http://localhost:5173, proxies `/api`)        |
| `npm run dev:server`       | Only the API in watch mode                                                               |
| `npm run dev:client`       | Only the Vite dev server                                                                 |
| `npm run build`            | `tsc` → `dist/server`, then Vite → `dist/client`                                         |
| `npm start`                | Production server: serves `dist/client` and the API on port 4173                         |
| `npm run lint`             | ESLint 9 (flat config) over TypeScript and config files                                  |
| `npm run lint:fix`         | ESLint with `--fix`                                                                      |
| `npm run format:check`     | Prettier check over TS/JSON/MD/YAML/HTML (ignores `dist/`, `data/`, artifacts)           |
| `npm run format`           | Prettier write                                                                           |
| `npm run typecheck`        | `tsc --noEmit` for the app and for the server                                            |
| `npm test`                 | Unit tests: domain rules (`tests/unit`) + pure client helpers (`src/client`), Vitest     |
| `npm test -- --run`        | Same unit suites, explicit run mode                                                      |
| `npm run test:integration` | API + SQLite integration tests (`tests/integration`)                                     |
| `npm run test:e2e`         | Playwright browser tests; starts its own server (see below)                              |
| `npm run db:reset`         | Deletes the SQLite file (`CAREGRID_DB_FILE` or the default) so the next start reseeds it |

`npm test` (or `npm test -- --run` for an explicit run mode) runs both unit suites in one Vitest
pass: the domain tests in `tests/unit` and the pure client helper tests under `src/client`.
Integration tests remain separate in `npm run test:integration`.

`npm run test:e2e` is self-contained: `playwright.config.ts` builds the app, wipes a disposable
database under `data/e2e/`, starts the server on **port 4183** with `CAREGRID_TODAY=2026-10-07`,
waits for `/api/health`, and never reuses a developer's server. The normal production start
(`npm start`) uses **port 4173**.

---

## Environment variables

| Variable           | Default                | Purpose                                                                  |
| ------------------ | ---------------------- | ------------------------------------------------------------------------ |
| `PORT`             | `4173`                 | HTTP port for the production/API server                                  |
| `HOST`             | `0.0.0.0`              | Bind address                                                             |
| `CAREGRID_DB_FILE` | `data/caregrid.sqlite` | SQLite file; `:memory:` is for tests only                                |
| `CAREGRID_TODAY`   | local date             | `YYYY-MM-DD` clinic "today" for the dashboard and overdue classification |
| `CAREGRID_SEED`    | `auto`                 | Any value other than `none` seeds an empty database; `none` starts empty |

Example: run a scratch instance that cannot touch your real data.

```bash
CAREGRID_DB_FILE=:memory: PORT=4199 CAREGRID_TODAY=2026-10-07 npm start
```

`:memory:` is throwaway storage used by tests; the normal local run is the SQLite file above. On
Windows PowerShell use
`$env:CAREGRID_DB_FILE=':memory:'; $env:PORT='4199'; npm start`.

---

## Architecture

```
index.html                  Vite entry (loads /src/client/main.ts)
vite.config.ts              Client build → dist/client, dev proxy /api → 4173, Vitest config
tsconfig.json               Strict config for client + tests (bundler resolution, ES2022)
tsconfig.server.json        Strict config for the API (NodeNext, rootDir src, outDir dist)
playwright.config.ts        E2E: own deterministic server on 4183, disposable DB, desktop + mobile

src/client/                 Lit 3 views, components and the typed API client
src/server/                 Fastify app, routes, domain rules, SQLite store and seed
src/shared/                 Types, constants and Zod schemas shared by client and server
tests/unit/                 Vitest domain-rule tests (`npm test` also runs src/client helper tests)
tests/integration/          Vitest API/storage tests against a real Fastify instance + SQLite
tests/e2e/                  Playwright browser journeys

dist/server/server.js       Compiled API entry point used by `npm start`
dist/client/                Built client served by @fastify/static
data/caregrid.sqlite        Default database (git-ignored, created on first start)
```

**Request flow.** The Lit app calls `/api/*` on the same origin. In development Vite proxies `/api`
to the API server; in production `@fastify/static` serves the built client and non-API GET routes
fall back to `index.html`. The API validates every request body and query with `zod`, applies domain
rules inside `better-sqlite3` transactions, and returns either the resource or the shared error
envelope:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Time slot overlaps an existing booking: provider Dr. Amara Okafor is booked 09:00-09:30.",
    "details": {
      "conflicts": [
        {
          "kind": "provider",
          "id": "prov-0001",
          "name": "Dr. Amara Okafor",
          "startTime": "09:00",
          "endTime": "09:30"
        }
      ]
    }
  }
}
```

Server modules compile with NodeNext, so relative imports inside `src/server` and `src/shared`
include the `.js` extension; Vite, Vitest and TypeScript resolve those specifiers back to the `.ts`
sources. Integration tests build an app with `buildApp()` and use Fastify's `app.inject()` rather
than opening a port.

---

## API overview

| Method     | Path                           | Purpose                                                                                                     |
| ---------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| GET        | `/api/health`                  | Database probe: `200` with `{ "status": "ok", "storage": "sqlite" }`, or `503` with the error envelope      |
| GET        | `/api/dashboard`               | Server-computed metrics, sessions, upcoming appointments and follow-ups for "today"                         |
| GET        | `/api/providers`               | Provider directory (read-only)                                                                              |
| GET        | `/api/sessions`                | Clinic sessions (read-only), filtered by `date` or `from`/`to`                                              |
| GET        | `/api/clients`                 | Client roster; filters `search` (alias `q`) and `status`                                                    |
| POST       | `/api/clients`                 | Register a client; `preferredContact` is `phone`\|`sms`\|`email`\|`letter`\|`in_person`, default `phone`    |
| GET        | `/api/clients/:id`             | Client detail with appointments, follow-ups and the activity trail                                          |
| GET        | `/api/appointments`            | Appointments filtered by `date`, `from`, `to`, `status`, `type`, `clientId`, `providerId`, `sessionId`, `q` |
| POST       | `/api/appointments`            | Create a conflict- and capacity-checked appointment                                                         |
| PATCH/POST | `/api/appointments/:id/status` | Appointment status transition (audited)                                                                     |
| PATCH      | `/api/appointments/:id`        | Alias for the status transition; Caregrid has no reschedule endpoint                                        |
| GET        | `/api/follow-ups`              | Follow-up queue filtered by `status`, `priority`, `assigneeId`, `clientId`, `overdue`, `dueBefore`, `q`     |
| POST       | `/api/follow-ups`              | Create a follow-up                                                                                          |
| PATCH/POST | `/api/follow-ups/:id/status`   | Follow-up status transition (audited)                                                                       |
| GET        | `/api/followups`               | List alias for `/api/follow-ups` (applies the status/assignee/overdue/client filters)                       |
| POST       | `/api/followups`               | Create alias for `/api/follow-ups`                                                                          |
| PATCH      | `/api/followups/:id`           | Alias for the follow-up status transition                                                                   |
| GET        | `/api/export/:entity`          | CSV attachment for `clients`, `appointments` or `follow_ups`                                                |
| GET        | `/api/follow-ups/export.csv`   | CSV attachment of all follow-ups                                                                            |
| POST       | `/api/import/clients`          | JSON client import (`reject_duplicates` or `skip_duplicates`, max 500 rows)                                 |

There is no provider or session create/update/delete, no client update or archive/restore, no
`/api/audit`, no reschedule endpoint, and no pagination wrapper: list endpoints return plain JSON
arrays. Full request shapes, transition tables and error codes are in [SPEC.md](SPEC.md).

---

## Data, seed and determinism

- Data lives in a single SQLite file (`data/caregrid.sqlite` by default) with foreign keys enabled,
  WAL mode for file databases, and an idempotent schema bootstrap at startup. Tables: `providers`,
  `clinic_sessions`, `clients`, `appointments`, `follow_ups`, `activity_events`, `meta`, plus the
  API's `api_record_extras` extension table, which persists fields the store schema does not model:
  client `consentStatus`, `preferredName` and `preferredContact`, appointment `type` and follow-up
  `priority`.
- IDs are readable and stable (`cli-0001`, `apt-0001`, `fup-0001`, `prov-0001`), not UUIDs.
- On first start with an empty database, a deterministic seed creates the 2026-10-06/07/08 clinic
  fixtures: five providers, six sessions, six clients, twelve appointments and seven follow-ups,
  including two overdue items dated 2026-10-05 and 2026-10-03. The seed is guarded by a `meta`
  marker and is idempotent; it never overwrites rows you created.
- Mutations run in transactions and survive close/reopen; the integration suite exercises the
  reopen path and verifies that reopening does not reseed duplicates.
- `CAREGRID_TODAY` selects the clinic "today" used by the dashboard and overdue rules. The seed
  fixtures themselves are fixed to 2026-10-06/07/08; the E2E suite pins `CAREGRID_TODAY=2026-10-07`
  so the demo day lines up.
- To start over: `npm run db:reset` (or delete the file) and restart. Set `CAREGRID_SEED=none` to
  start with an empty database instead.

---

## Troubleshooting

| Symptom                                                      | Fix                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `EADDRINUSE: address already in use 0.0.0.0:4173`            | Another process owns the port: stop it, or use `PORT=4199 npm start`.                                                          |
| `Cannot find module 'dist/server/server.js'`                 | Run `npm run build` before `npm start` (the API is compiled).                                                                  |
| Port 5173 in dev shows API errors like `ECONNREFUSED /api/…` | The API is not running: start `npm run dev` (both processes) or `npm run dev:server` alongside `npm run dev:client`.           |
| `better-sqlite3` fails to build                              | Install the native toolchain (Python 3, `make`, C++ compiler) and re-run `npm rebuild better-sqlite3`; use a current LTS Node. |
| Playwright: "Executable doesn't exist …"                     | Run `npx playwright install chromium` after `npm ci`.                                                                          |
| E2E leaves a port busy after a crash                         | Port 4183 is only used for E2E; rerun, or set `CAREGRID_E2E_PORT=4283 npm run test:e2e`.                                       |
| `SQLITE_BUSY` / database locked                              | Two servers are pointed at the same file. Stop one, or give each its own `CAREGRID_DB_FILE`.                                   |
| Dashboard shows nothing for "today"                          | Run with `CAREGRID_TODAY=2026-10-07`, the day covered by the seeded fixtures.                                                  |
| `npm ci` fails with lockfile errors                          | The lockfile is authoritative: do not delete it; run `npm install` locally if you intentionally changed dependencies.          |

---

## License

MIT — see [LICENSE](LICENSE).
