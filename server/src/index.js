import { config } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { createApp } from './app.js';
import { ensureIndexes } from './models/index.js';
import { startRealtime } from './services/realtime.js';
import { startWorker } from './worker/runner.js';

await connectDb();
await ensureIndexes();

const stopRealtime = startRealtime();
const stopWorker = config.runWorker ? startWorker() : () => {};
const server = createApp().listen(config.port, () => console.log(`[api] listening on http://localhost:${config.port}`));

async function shutdown() {
  console.log('[api] shutting down');
  stopWorker();
  await stopRealtime();
  server.close();
  await disconnectDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
