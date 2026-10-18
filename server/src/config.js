import 'dotenv/config';

function int(name, fallback) {
  const v = process.env[name];
  return v === undefined ? fallback : Number.parseInt(v, 10);
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int('PORT', 4000),
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/newtonite?directConnection=true',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtTtl: process.env.JWT_TTL || '12h',
  // Run the background job worker inside the API process. In production you would
  // set this to false and run `npm run worker` as a separate process.
  runWorker: (process.env.RUN_WORKER ?? 'true') === 'true',
  workerPollMs: int('WORKER_POLL_MS', 1000),
  jobLockMs: int('JOB_LOCK_MS', 30_000),
  jobMaxAttempts: int('JOB_MAX_ATTEMPTS', 5),
  idempotencyTtlSeconds: int('IDEMPOTENCY_TTL_SECONDS', 24 * 3600),
  staleAfterDays: int('STALE_AFTER_DAYS', 3),
  clientDist: process.env.CLIENT_DIST || null,
  // Exposes the demo account list on the login screen. Never enable for real data.
  demoLogin: (process.env.DEMO_LOGIN ?? String(process.env.NODE_ENV !== 'production')) === 'true',
};
