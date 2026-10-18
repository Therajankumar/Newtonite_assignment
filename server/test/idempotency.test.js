import { beforeEach, describe, expect, it } from 'vitest';
import { Activity, WorkItem } from '../src/models/index.js';
import { as, createClaimedItem, fixture, newKey } from './helpers.js';

let f;
beforeEach(async () => {
  f = await fixture();
});

const body = () => ({ team: String(f.teams.pay._id), title: 'Customer charged twice', priority: 'urgent' });

describe('duplicate request protection', () => {
  it('replays the original response when a create is retried with the same key', async () => {
    const key = newKey();
    const first = await as(f.users.bob).post('/api/items').set('Idempotency-Key', key).send(body());
    const retry = await as(f.users.bob).post('/api/items').set('Idempotency-Key', key).send(body());

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.item.id).toBe(first.body.item.id);
    expect(await WorkItem.countDocuments({})).toBe(1);
  });

  it('creates exactly one item when identical requests arrive simultaneously', async () => {
    const key = newKey();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => as(f.users.bob).post('/api/items').set('Idempotency-Key', key).send(body())),
    );
    expect(await WorkItem.countDocuments({})).toBe(1);
    const ids = new Set(results.filter((r) => r.status < 300).map((r) => r.body.item.id));
    expect(ids.size).toBe(1);
    for (const r of results) expect([200, 201, 409]).toContain(r.status);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('REQUEST_IN_PROGRESS');
  });

  it('still de-duplicates at the database level if the idempotency record is lost', async () => {
    const key = newKey();
    await as(f.users.bob).post('/api/items').set('Idempotency-Key', key).send(body()).expect(201);
    const { IdempotencyKey } = await import('../src/models/index.js');
    await IdempotencyKey.deleteMany({});
    const retry = await as(f.users.bob).post('/api/items').set('Idempotency-Key', key).send(body());
    expect(retry.status).toBe(200);
    expect(await WorkItem.countDocuments({})).toBe(1);
  });

  it('rejects reuse of a key for a different request', async () => {
    const key = newKey();
    await as(f.users.bob).post('/api/items').set('Idempotency-Key', key).send(body()).expect(201);
    const reused = await as(f.users.bob).post('/api/items').set('Idempotency-Key', key).send({ ...body(), title: 'Something else' });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('scopes keys per user', async () => {
    const key = newKey();
    await as(f.users.bob).post('/api/items').set('Idempotency-Key', key).send(body()).expect(201);
    await as(f.users.erin).post('/api/items').set('Idempotency-Key', key).send(body()).expect(201);
    expect(await WorkItem.countDocuments({})).toBe(2);
  });

  it('does not post a comment twice when the user retries', async () => {
    const item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay);
    const key = newKey();
    const send = () => as(f.users.bob).post(`/api/items/${item.id}/comments`).set('Idempotency-Key', key).send({ body: 'Refund issued' });
    await Promise.all([send(), send(), send()]);
    await send();
    expect(await Activity.countDocuments({ item: item.id, type: 'commented' })).toBe(1);
  });

  it('replays a transition instead of failing on the now-stale version', async () => {
    const item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay);
    const key = newKey();
    const req = () =>
      as(f.users.bob).post(`/api/items/${item.id}/transitions/block`).set('Idempotency-Key', key).send({ version: item.version, note: 'Waiting on bank' });
    const first = await req();
    const retry = await req();
    expect(first.status).toBe(200);
    // Without idempotency the retry would get a confusing VERSION_CONFLICT for the user's own change.
    expect(retry.status).toBe(200);
    expect(retry.body.item.version).toBe(first.body.item.version);
    expect(await Activity.countDocuments({ item: item.id, type: 'transitioned' })).toBe(1);
  });
});
