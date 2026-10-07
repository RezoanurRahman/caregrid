/**
 * Caregrid Fastify application factory.
 *
 * `buildApp` wires the SQLite store, the API routes, the shared error envelope,
 * local development CORS and (when a build exists) the Lit client served from
 * `dist/client`. It is the single entry point used by `server.ts`, the
 * integration tests and any future server side tooling.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { DEFAULT_DATABASE_FILENAME, createDatabase } from './db.js';
import { errorPayload, installErrorHandler } from './errors.js';
import { createRecordExtras, registerRoutes } from './routes.js';
import { seedDatabase } from './seed.js';
import { createStore, type Store } from './store.js';

export interface BuildAppOptions {
  /** SQLite file to open. Defaults to `CAREGRID_DB_FILE` or `data/caregrid.sqlite`. */
  dbFile?: string;
  /** Pre-built store (tests). When present the database is owned by the caller. */
  store?: Store;
  /** Fastify logger toggle; on by default. */
  logger?: boolean;
}

/** Vite writes the client bundle here; the server bundle lives in `dist/server`. */
const CLIENT_DIRECTORY = join('dist', 'client');

/** Vite's default output directory, accepted only when it is not the server build. */
const LEGACY_CLIENT_DIRECTORY = 'dist';

/** Vite's dev server may call the API from another local port. */
const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * `CAREGRID_SEED=none` starts an empty database (used by tests that manage
 * their own data); anything else seeds an empty database on first start.
 */
export function shouldSeed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CAREGRID_SEED ?? 'auto').trim().toLowerCase() !== 'none';
}

/** Resolves the database file from the explicit option, then the environment. */
export function resolveDbFile(dbFile?: string): string {
  const candidate = dbFile ?? process.env.CAREGRID_DB_FILE ?? DEFAULT_DATABASE_FILENAME;
  const trimmed = candidate.trim();
  return trimmed === '' ? DEFAULT_DATABASE_FILENAME : trimmed;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Directory that holds the built client, when one is available. `dist/client` is
 * the real build output; the bare `dist` fallback exists for older layouts and
 * is skipped when it also contains the compiled server.
 */
export function resolveClientRoot(cwd: string = process.cwd()): string | undefined {
  const primary = resolve(cwd, CLIENT_DIRECTORY);
  if (isFile(join(primary, 'index.html'))) return primary;
  const fallback = resolve(cwd, LEGACY_CLIENT_DIRECTORY);
  if (isFile(join(fallback, 'server', 'server.js'))) return undefined;
  if (isFile(join(fallback, 'index.html'))) return fallback;
  return undefined;
}

/** Allows the Vite dev origin to call the API locally; everything else is same-origin. */
function installDevCors(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    const allowed = typeof origin === 'string' && LOCAL_ORIGIN_PATTERN.test(origin);
    if (!allowed) return;
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    reply.header('access-control-allow-headers', 'content-type,accept,x-request-id');
    reply.header('access-control-max-age', '600');
    const requestedMethod = request.headers['access-control-request-method'];
    if (request.method === 'OPTIONS' && requestedMethod !== undefined) {
      reply.status(204).send();
    }
  });
}

/** API responses are never cached and always carry the request id. */
function installApiHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (request.url === '/api' || request.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
      reply.header('x-request-id', request.id);
    }
    return payload;
  });
}

/** Registers `@fastify/static` for the built client, when a build is present. */
async function installClientAssets(app: FastifyInstance): Promise<string | undefined> {
  const clientRoot = resolveClientRoot();
  if (clientRoot === undefined) return undefined;
  await app.register(fastifyStatic, { root: clientRoot, index: ['index.html'] });
  app.log.info({ clientRoot }, 'serving the built client');
  return clientRoot;
}

function closeQuietly(target: unknown, app: FastifyInstance): void {
  if (typeof target !== 'object' || target === null) return;
  const close = (target as { close?: unknown }).close;
  if (typeof close !== 'function') return;
  try {
    (close as (this: unknown) => unknown).call(target);
  } catch (error) {
    app.log.warn({ err: error }, 'failed to close a database handle');
  }
}

/**
 * Builds the Caregrid API. The returned instance owns the database unless a
 * store was injected, in which case the caller keeps ownership.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    requestIdHeader: 'x-request-id',
  });

  let database: unknown;
  let store = options.store;
  if (store === undefined) {
    database = createDatabase(resolveDbFile(options.dbFile)) as unknown;
    if (shouldSeed()) {
      seedDatabase(database as Parameters<typeof seedDatabase>[0]);
    }
    store = createStore(database as Parameters<typeof createStore>[0]);
  }

  registerRoutes(app, { store, extras: createRecordExtras(database) });
  installErrorHandler(app);
  installDevCors(app);
  installApiHeaders(app);
  const clientRoot = await installClientAssets(app);

  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    const isApiRoute = request.url === '/api' || request.url.startsWith('/api/');
    if (!isApiRoute && request.method === 'GET' && clientRoot !== undefined) {
      const html = await readFile(join(clientRoot, 'index.html'), 'utf8');
      reply.status(200).type('text/html; charset=utf-8').send(html);
      return;
    }
    reply
      .status(404)
      .send(errorPayload('NOT_FOUND', `Route ${request.method} ${request.url} was not found.`));
  });

  app.addHook('onClose', async () => {
    if (database === undefined) return;
    // Flush the store first (some stores close their own handles), then the file.
    closeQuietly(store, app);
    closeQuietly(database, app);
  });

  return app;
}
