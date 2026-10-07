/**
 * Caregrid production entry point.
 *
 * Opens the SQLite backed store (honouring `CAREGRID_DB_FILE`), starts Fastify
 * on `HOST`/`PORT`, and shuts down cleanly on SIGINT/SIGTERM so the database
 * file is closed before the process exits. Everything the API needs is built in
 * `app.ts`; this module only owns listening and process level concerns.
 */

import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

/** Health/smoke probes and documents expect Caregrid on 4173. */
export const DEFAULT_PORT = 4173;

/** Listening on all interfaces keeps the server reachable inside containers. */
export const DEFAULT_HOST = '0.0.0.0';

const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Resolves the listen port, falling back to {@link DEFAULT_PORT}. */
export function resolvePort(raw: string | undefined = process.env.PORT): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return DEFAULT_PORT;
  return port;
}

/** Resolves the listen host, falling back to {@link DEFAULT_HOST}. */
export function resolveHost(raw: string | undefined = process.env.HOST): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HOST;
  return raw.trim();
}

function resolveDbFile(): string | undefined {
  const file = process.env.CAREGRID_DB_FILE;
  return file === undefined || file.trim() === '' ? undefined : file.trim();
}

/**
 * Builds the app, starts listening and installs graceful shutdown handlers.
 * Exported so integration tests can start the real production server.
 */
export async function startServer(): Promise<FastifyInstance> {
  const app = await buildApp({ dbFile: resolveDbFile(), logger: true });
  const port = resolvePort();
  const host = resolveHost();

  app.addHook('onClose', async () => {
    app.log.info('caregrid server stopped');
  });

  await app.listen({ port, host });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exitCode = 0;
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  return app;
}

startServer().catch((error: unknown) => {
  // Startup failures happen before the logger exists, so this is the one place
  // that writes to the console directly.
  console.error('caregrid server failed to start');
  console.error(error);
  process.exitCode = 1;
});
