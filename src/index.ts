import { loadConfig } from './config';
import { createGoogleAuth } from './core/auth/google';
import { seedDefaults } from './core/layers/service';
import { createProviderBackoff } from './core/pipeline/backoff';
import { createPricing } from './core/pricing';
import { createPgBossQueue } from './core/queue/pg-boss';
import { seedAllScenarios } from './core/scenarios/service';
import { startWorker } from './core/queue/worker';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { startServer } from './server/app';

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

const integer = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** `all` runs API + worker in one process; split with ROLE=server / ROLE=worker when scaling out. */
const role = env('ROLE', 'all') as 'all' | 'server' | 'worker';
const connectionString = env('DATABASE_URL');

/** `bun --hot` re-runs this module but keeps `globalThis`; the previous run's connections go first, or every reload leaks a pool. */
declare global {
  var loqoRuntime: { stop: () => Promise<void> } | undefined;
}
await globalThis.loqoRuntime?.stop();

const { db, pool } = createDb(connectionString, { poolSize: integer('DATABASE_POOL_SIZE', 10) });
await runMigrations(db);
const config = await loadConfig({ db });
const seeded = await seedDefaults(db, config.prompts);
const seededScenarios = await seedAllScenarios(db);
if (seeded.layers > 0 || seeded.prompts > 0 || seededScenarios > 0) {
  console.log(`[seed] built-in pipeline installed: ${seeded.layers} layers, ${seeded.prompts} prompts, ${seededScenarios} scenarios`);
}
const pricing = createPricing(db);
await pricing.start();
const queue = await createPgBossQueue(connectionString);
globalThis.loqoRuntime = {
  stop: async () => {
    await queue.stop({ graceful: false });
    await pool.end();
  },
};

if (role !== 'server') {
  const backoff = createProviderBackoff({ maxRetries: integer('TRANSLATE_MAX_RETRIES', 5) });
  await startWorker(queue, { db, config, pricing, backoff }, {
    fieldsPerCall: integer('TRANSLATE_BATCH_SIZE', 20),
    concurrency: integer('TRANSLATE_CONCURRENCY', 2),
  });
  console.log('[worker] listening on queue "translate"');
}

if (role !== 'worker') {
  const production = process.env.NODE_ENV === 'production';
  const auth = createGoogleAuth({ clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET'), appUrl: env('APP_URL') });
  const server = startServer(
    { db, queue, config, pricing, auth, secureCookies: production },
    { port: integer('PORT', 3000), development: !production },
  );
  console.log(`[server] http://localhost:${server.port} (${role})`);
}

const shutdown = async (signal: string) => {
  console.log(`[${signal}] shutting down`);
  await queue.stop({ graceful: true, timeoutMs: 30_000 });
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
