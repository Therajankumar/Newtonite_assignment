import os from 'node:os';
import { config } from '../config.js';
import { Job } from '../models/index.js';
import { handlers } from './handlers.js';

const workerId = `${os.hostname()}:${process.pid}`;

export function backoffMs(attempts) {
  // 2s, 4s, 8s, 16s ... capped at 5 minutes.
  return Math.min(2 ** attempts * 1000, 5 * 60 * 1000);
}

/**
 * Atomically lease the next runnable job. A job is runnable when it is pending and due, or
 * when it is "running" but its lease expired (the worker that took it crashed or hung).
 * findOneAndUpdate guarantees that only one worker gets any given job per lease.
 */
export async function leaseNextJob({ now = new Date(), lockMs = config.jobLockMs } = {}) {
  return Job.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', runAt: { $lte: now } },
        { status: 'running', lockedUntil: { $lt: now } },
      ],
    },
    {
      $set: { status: 'running', lockedBy: workerId, lockedUntil: new Date(now.getTime() + lockMs) },
      $inc: { attempts: 1 },
    },
    { sort: { runAt: 1 }, new: true },
  ).lean();
}

/**
 * Run one job. Delivery is at-least-once: a job can run more than once if a worker dies
 * after doing the work but before recording success, so every handler must be idempotent.
 */
export async function runJob(job, { log = console } = {}) {
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`No handler for job type "${job.type}"`);
    await handler(job.payload, job);
    // Only the current lease holder may complete the job.
    await Job.updateOne(
      { _id: job._id, lockedBy: job.lockedBy, attempts: job.attempts },
      { $set: { status: 'done', completedAt: new Date(), lockedUntil: null, lastError: null } },
    );
    return 'done';
  } catch (err) {
    const exhausted = job.attempts >= (job.maxAttempts ?? config.jobMaxAttempts);
    const status = exhausted ? 'dead' : 'pending';
    await Job.updateOne(
      { _id: job._id, lockedBy: job.lockedBy, attempts: job.attempts },
      {
        $set: {
          status,
          lockedUntil: null,
          lastError: String(err?.stack || err).slice(0, 2000),
          runAt: new Date(Date.now() + backoffMs(job.attempts)),
        },
      },
    );
    log.error?.(`[worker] job ${job._id} (${job.type}) failed attempt ${job.attempts}: ${err.message}${exhausted ? ' - giving up' : ''}`);
    return status;
  }
}

/** Process jobs until none are runnable. Returns how many were processed. */
export async function drain(opts = {}) {
  let n = 0;
  for (;;) {
    const job = await leaseNextJob(opts);
    if (!job) return n;
    await runJob(job, opts);
    n++;
  }
}

export function startWorker({ pollMs = config.workerPollMs, log = console } = {}) {
  let stopped = false;
  let timer;
  const tick = async () => {
    try {
      await drain({ log });
    } catch (err) {
      log.error('[worker] poll failed', err.message);
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };
  tick();
  log.info?.(`[worker] started as ${workerId}`);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
