# Caregrid

A local-first coordination desk for pop-up community health clinics. Caregrid keeps client intake,
conflict-aware appointment scheduling, follow-up work and auditable outcomes in one calm workspace
backed by a single SQLite file on your machine.

- **Frontend:** Lit 3 + Vite (TypeScript, strict)
- **API:** Fastify 5 (TypeScript, strict)
- **Storage:** SQLite via `better-sqlite3`
- **Runtime:** Node 20.19+ and npm 10+

The two capabilities that carry the product beyond CRUD are **conflict-aware scheduling with capacity
enforcement** (provider/client overlap and session capacity are checked transactionally on every
booking) and **auditable state transitions plus computed dashboard analytics** (every lifecycle change
writes to an append-only audit log, and the dashboard is aggregated server-side in SQL). See
[SPEC.md](SPEC.md) for the full contract, acceptance criteria and limitations.

---

## Quick start (three commands)

```bash
npm ci        # install dependencies (see the note below about test browsers)
npm run build # compile the API (tsc) and the client (Vite)
npm start     # serve dist/client + the API on http://127.0.0.1:4173
```

Open <http://127.0.0.1:4173>. The database is created and seeded on first start at
`data/caregrid.sqlite`, so the dashboard already has a clinic day to look at.

If you also plan to run the browser tests, install the Chromium build once after `npm ci`:

```bash
npx playwright install chromium
```

There is no hidden browser assumption: `npm run test:e2e` fails with a clear Playwright message if
Chromium is missing, and the command above is the documented fix (CI runs the same two commands).

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
| `npm run typecheck`        | `tsc --noEmit` for the app (bundler resolution) and for the server (NodeNext)            |
| `npm test`                 | Unit tests (`tests/unit`), Vitest                                                        |
| `npm test -- --run`        | Same thing, explicit run mode                                                            |
| `npm run test:integration` | API + SQLite integration tests (`tests/integration`)                                     |
| `npm run test:e2e`         | Playwright browser tests; starts its own server (see below)                              |
| `npm run db:reset`         | Deletes the SQLite file (`CAREGRID_DB_FILE` or the default) so the next start reseeds it |

`npm run test:e2e` is self-contained: `playwright.config.ts` builds the app, starts it on port 4183
with a disposable database (`data/e2e/…sqlite`) and `CAREGRID_TODAY=2026-10-07`, waits for
`/api/health`, and never reuses a server that is already running. Run `npm run build` first only if
you want faster E2E startup; the config builds anyway.

---

## Environment variables

| Variable           | Default                | Purpose                                                                 |
| ------------------ | ---------------------- | ----------------------------------------------------------------------- |
| `PORT`             | `4173`                 | HTTP port for the production/API server                                 |
| `HOST`             | `127.0.0.1`            | Bind address                                                            |
| `CAREGRID_DB_FILE` | `data/caregrid.sqlite` | SQLite file; `:memory:` is supported for throwaway runs                 |
| `CAREGRID_TODAY`   | local date             | `YYYY-MM-DD`; makes dashboards, seeding and overdue rules deterministic |
| `CAREGRID_SEED`    | `auto`                 | `auto` seeds an empty database; `none` starts empty                     |

Example: run a scratch instance that cannot touch your real data.

```bash
CAREGRID_DB_FILE=:memory: PORT=4199 CAREGRID_TODAY=2026-10-07 npm start
```

On Windows PowerShell use `$env:CAREGRID_DB_FILE=':memory:'; $env:PORT='4199'; npm start`.

---

## Architecture

```
index.html                  Vite entry (loads /src/client/main.ts)
vite.config.ts              Client build → dist/client, dev proxy /api → 4173, Vitest config
tsconfig.json               Strict config for client + tests (bundler resolution, ES2022)
tsconfig.server.json        Strict config for the API (NodeNext, rootDir src, outDir dist)
playwright.config.ts        E2E: own deterministic server, disposable DB, chromium desktop + mobile

src/client/                 Lit 3 components (main.ts is the entry referenced by index.html)
src/server/                 Fastify app; server.ts is the entry (`node dist/server/server.js`)
src/shared/                 Types/constants shared by client and server
tests/unit/                 Vitest unit tests for domain rules
tests/integration/          Vitest API/storage tests against a real Fastify instance + SQLite
tests/e2e/                  Playwright browser journeys

dist/server/server.js       Compiled API entry point used by `npm start`
dist/client/                Built client served by @fastify/static
data/caregrid.sqlite        Default database (git-ignored, created on first start)
```

**Request flow.** The browser loads the Lit app (Vite dev server in development, Fastify static in
production) and calls `/api/*` on the same origin. Vite proxies `/api` to the API server in
development, so client code can always use relative URLs. The API validates every request with `zod`,
applies domain rules inside `better-sqlite3` transactions, and returns either the resource or the
shared error envelope:

```json
{
  "error": {
    "code": "capacity_exceeded",
    "message": "…",
    "details": { "capacity": 12, "booked": 12 }
  }
}
```

**Server module conventions.** The API entry is `src/server/server.ts` (started by `npm start` as
`dist/server/server.js`). It reads configuration from the environment, creates the app, and listens.
Because the server compiles with NodeNext, relative imports in `src/server` and `src/shared` must
include the `.js` extension (`import { readHealth } from './health.js'`). TypeScript, Vite and
Vitest all map that specifier back to the `.ts` source. Integration tests build an app instance
directly and use Fastify's `app.inject()` rather than opening a port.

---

## API overview

| Method   | Path                                            | Purpose                                                    |
| -------- | ----------------------------------------------- | ---------------------------------------------------------- |
| GET      | `/api/health`                                   | Liveness + database probe (used by smoke tests and E2E)    |
| GET      | `/api/dashboard?date=`                          | Capacity, status counts, provider load, follow-up pressure |
| GET/POST | `/api/clients`, `/api/clients/:id`              | Intake, search and detail; PATCH updates, archive/restore  |
| GET/POST | `/api/providers`, `/api/providers/:id`          | Provider directory                                         |
| GET/POST | `/api/sessions`, `/api/sessions/:id`            | Clinic sessions with capacity; `/status` transitions       |
| GET/POST | `/api/appointments`, `/api/appointments/:id`    | Conflict-checked booking; `/status` transitions            |
| GET/POST | `/api/follow-ups`, `/api/follow-ups/export.csv` | Follow-up queue, filtered CSV export                       |
| GET      | `/api/audit?entityType=&entityId=`              | Append-only change history for a record                    |

Full request/response shapes, status transition tables and error codes are in [SPEC.md](SPEC.md).

---

## Data, reset and determinism

- Data lives in a single SQLite file (`data/caregrid.sqlite` by default) with WAL mode, foreign keys
  enforced, and a schema bootstrapped idempotently at startup.
- To start over: `npm run db:reset` (or delete the file) and restart. The seed is re-created.
- The seed is anchored to "today": set `CAREGRID_TODAY=2026-10-07` for a repeatable clinic day, which
  is exactly what the E2E suite does.
- On first start with an empty database, Caregrid inserts demo data: two sessions (today and
  tomorrow), several providers with different roles, a set of clients and follow-ups — including one
  overdue item so the queue has something honest to show. Set `CAREGRID_SEED=none` to start empty.

---

## Troubleshooting

| Symptom                                                      | Fix                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `EADDRINUSE: address already in use 127.0.0.1:4173`          | Another Caregrid (or process) owns the port: stop it, or use `PORT=4199 npm start`.                                            |
| `Cannot find module 'dist/server/server.js'`                 | Run `npm run build` before `npm start` (the API is compiled).                                                                  |
| Port 5173 in dev shows API errors like `ECONNREFUSED /api/…` | The API is not running: start `npm run dev` (both processes) or `npm run dev:server` alongside `npm run dev:client`.           |
| `better-sqlite3` fails to build                              | Install the native toolchain (Python 3, `make`, C++ compiler) and re-run `npm rebuild better-sqlite3`; use a current LTS Node. |
| Playwright: "Executable doesn't exist …"                     | Run `npx playwright install chromium` after `npm ci`.                                                                          |
| E2E leaves a port busy after a crash                         | Port 4183 is only used for E2E; rerun, or set `CAREGRID_E2E_PORT=4283 npm run test:e2e`.                                       |
| `SQLITE_BUSY` / database locked                              | Two servers are pointed at the same file. Stop one, or give each its own `CAREGRID_DB_FILE`.                                   |
| Prettier or ESLint complain about generated files            | `dist/`, `data/`, `playwright-report/` and `test-results/` are ignored; delete artifacts you no longer need.                   |
| `npm ci` fails with lockfile errors                          | The lockfile is authoritative: do not delete it; run `npm install` locally if you intentionally changed dependencies.          |

---

## License

MIT — see [LICENSE](LICENSE).
