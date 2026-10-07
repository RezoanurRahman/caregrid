/**
 * SQLite connection and schema bootstrap for Caregrid.
 *
 * One file database lives at `data/caregrid.sqlite` by default and keeps the
 * clinic roster across restarts. `:memory:` is supported for tests. Foreign
 * keys are always enabled, file databases run in WAL mode so readers do not
 * block the single writer, and every statement that mutates related rows runs
 * inside a transaction in the store layer.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DEFAULT_DATABASE_FILENAME = 'data/caregrid.sqlite';

export const SCHEMA_VERSION = 1;

/** Database values use snake_case; the public store shapes use camelCase. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  role        TEXT NOT NULL DEFAULT 'Care provider' CHECK (length(trim(role)) > 0),
  email       TEXT NOT NULL UNIQUE,
  phone       TEXT,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clinic_sessions (
  id                TEXT PRIMARY KEY,
  date              TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_time        TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time          TEXT NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  location          TEXT NOT NULL CHECK (length(trim(location)) > 0),
  capacity          INTEGER NOT NULL CHECK (capacity > 0),
  lead_provider_id  TEXT REFERENCES providers(id) ON DELETE SET NULL,
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_clinic_sessions_date ON clinic_sessions(date, start_time);

CREATE TABLE IF NOT EXISTS clients (
  id             TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
  email          TEXT,
  phone          TEXT NOT NULL CHECK (length(trim(phone)) > 0),
  date_of_birth  TEXT NOT NULL CHECK (date_of_birth GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status         TEXT NOT NULL CHECK (status IN ('active', 'waitlist', 'inactive')),
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_email_unique ON clients(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(full_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

CREATE TABLE IF NOT EXISTS appointments (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider_id  TEXT NOT NULL REFERENCES providers(id),
  session_id   TEXT NOT NULL REFERENCES clinic_sessions(id),
  date         TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_time   TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time     TEXT NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  status       TEXT NOT NULL CHECK (status IN ('requested', 'confirmed', 'checked_in', 'completed', 'no_show', 'cancelled')),
  reason       TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date, start_time);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id, date);
CREATE INDEX IF NOT EXISTS idx_appointments_provider ON appointments(provider_id, date);
CREATE INDEX IF NOT EXISTS idx_appointments_session ON appointments(session_id);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);

CREATE TABLE IF NOT EXISTS follow_ups (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  appointment_id  TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  assignee_id     TEXT REFERENCES providers(id) ON DELETE SET NULL,
  title           TEXT NOT NULL CHECK (length(trim(title)) > 0),
  detail          TEXT,
  status          TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'done', 'dismissed')),
  due_date        TEXT NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  completed_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_status ON follow_ups(status, due_date);
CREATE INDEX IF NOT EXISTS idx_follow_ups_client ON follow_ups(client_id, status);
CREATE INDEX IF NOT EXISTS idx_follow_ups_assignee ON follow_ups(assignee_id, status);

CREATE TABLE IF NOT EXISTS activity_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('client', 'appointment', 'follow_up')),
  entity_id    TEXT NOT NULL,
  client_id    TEXT REFERENCES clients(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  detail       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_events_client ON activity_events(client_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_entity ON activity_events(entity_type, entity_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

function isMemoryDatabase(db: Database.Database): boolean {
  const name = db.name;
  return name === ':memory:' || name === '' || db.memory === true;
}

/**
 * Applies pragmas and the idempotent schema. Safe to call on every connection.
 */
export function initializeDatabase(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!isMemoryDatabase(db)) {
    // WAL keeps reads non-blocking for the API process; in-memory databases do not support it.
    db.pragma('journal_mode = WAL');
  }
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA_SQL);
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current < SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

/**
 * Opens (or creates) the Caregrid database and makes sure the schema exists.
 * Defaults to `data/caregrid.sqlite`; the parent directory is created unless the
 * special `:memory:` filename is used.
 */
export function createDatabase(filename: string = DEFAULT_DATABASE_FILENAME): Database.Database {
  if (filename === ':memory:') {
    const db = new Database(':memory:');
    initializeDatabase(db);
    return db;
  }
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  initializeDatabase(db);
  return db;
}
