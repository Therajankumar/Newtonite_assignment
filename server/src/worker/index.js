// Standalone worker process: `npm run worker` (use with RUN_WORKER=false on the API).
import { connectDb } from '../db.js';
import { ensureIndexes } from '../models/index.js';
import { startWorker } from './runner.js';

await connectDb();
await ensureIndexes();
const stop = startWorker();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stop();
    process.exit(0);
  });
}
