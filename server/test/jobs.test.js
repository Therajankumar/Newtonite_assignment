import { beforeEach, describe, expect, it } from 'vitest';
import { Job, Notification } from '../src/models/index.js';
import { drain, leaseNextJob, runJob } from '../src/worker/runner.js';
import { handlers } from '../src/worker/handlers.js';
import { as, createClaimedItem, createItem, fixture } from './helpers.js';

let f;
beforeEach(async () => {
  f = await fixture();
});

const quiet = { error: () => {}, info: () => {} };

describe('asynchronous notification jobs', () => {
  it('notifies the people involved, but not the person who acted', async () => {
    const item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay);
    await drain({ log: quiet });
    await as(f.users.erin).post(`/api/items/${item.id}/comments`).send({ body: 'On it' });
    await drain({ log: quiet });

    const forBob = await Notification.find({ user: f.users.bob._id }).lean();
    const forErin = await Notification.find({ user: f.users.erin._id }).lean();
    expect(forBob.map((n) => n.message)).toEqual([expect.stringContaining('erin commented')]);
    expect(forErin).toHaveLength(0);
    // Alice (reporter) hears about the claim and the comment.
    expect(await Notification.countDocuments({ user: f.users.alice._id })).toBe(2);
  });

  it('asks the other team leads for approval', async () => {
    const item = await createClaimedItem(f.users.bob, f.users.bob, f.teams.pay, { requiresApproval: true });
    await as(f.users.bob).post(`/api/items/${item.id}/transitions/request_approval`).send({ version: item.version });
    await drain({ log: quiet });
    expect(await Notification.countDocuments({ user: f.users.alice._id, message: /awaiting approval/ })).toBe(1);
    expect(await Notification.countDocuments({ user: f.users.linda._id, message: /awaiting approval/ })).toBe(1);
  });

  it('is safe to run the same job twice (at-least-once delivery)', async () => {
    await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay);
    const job = await Job.findOne({ type: 'notify' }).sort({ createdAt: -1 }).lean();
    await handlers.notify(job.payload);
    await handlers.notify(job.payload);
    expect(await Notification.countDocuments({})).toBe(1);
  });

  it('retries failures with backoff and eventually gives up', async () => {
    handlers.flaky = async () => {
      throw new Error('downstream unavailable');
    };
    await Job.create({ type: 'flaky', maxAttempts: 3 });

    const first = await leaseNextJob();
    expect(await runJob(first, { log: quiet })).toBe('pending');
    let stored = await Job.findById(first._id).lean();
    expect(stored.attempts).toBe(1);
    expect(stored.runAt.getTime()).toBeGreaterThan(Date.now()); // not immediately retried
    expect(stored.lastError).toMatch(/downstream unavailable/);
    expect(await leaseNextJob()).toBeNull();

    // Pretend time passes.
    const later = () => new Date(Date.now() + 10 * 60_000);
    expect(await runJob(await leaseNextJob({ now: later() }), { log: quiet })).toBe('pending');
    expect(await runJob(await leaseNextJob({ now: later() }), { log: quiet })).toBe('dead');
    stored = await Job.findById(first._id).lean();
    expect(stored.status).toBe('dead');
    expect(stored.attempts).toBe(3);
    expect(await leaseNextJob({ now: later() })).toBeNull();
    delete handlers.flaky;
  });

  it('recovers jobs from a worker that crashed mid-job', async () => {
    await createItem(f.users.alice, f.teams.pay);
    const leased = await leaseNextJob({ lockMs: 30_000 });
    expect(leased).not.toBeNull();
    // The worker dies here. Nobody else can take the job while the lease is valid...
    expect(await leaseNextJob()).toBeNull();
    // ...but once it expires another worker picks it up.
    const retaken = await leaseNextJob({ now: new Date(Date.now() + 60_000) });
    expect(String(retaken._id)).toBe(String(leased._id));
    expect(retaken.attempts).toBe(2);
  });

  it('never hands the same job to two workers at once', async () => {
    for (let i = 0; i < 5; i++) await createItem(f.users.alice, f.teams.pay, { title: `Item number ${i}` });
    const leases = await Promise.all(Array.from({ length: 20 }, () => leaseNextJob()));
    const got = leases.filter(Boolean).map((j) => String(j._id));
    expect(got).toHaveLength(5);
    expect(new Set(got).size).toBe(5);
  });
});
