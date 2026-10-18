import { beforeEach, describe, expect, it } from 'vitest';
import { Activity, Job } from '../src/models/index.js';
import { as, createClaimedItem, createItem, fixture } from './helpers.js';

let f;
beforeEach(async () => {
  f = await fixture();
});

const transition = (user, item, name, body = {}) =>
  as(user).post(`/api/items/${item.id}/transitions/${name}`).send({ version: item.version, ...body });

describe('workflow rules', () => {
  it('cannot resolve an item that requires approval until it is approved', async () => {
    let item = await createClaimedItem(f.users.bob, f.users.bob, f.teams.pay, { requiresApproval: true });
    const early = await transition(f.users.bob, item, 'resolve', { resolution: 'Refunded' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INVALID_STATE');
    expect(early.body.error.message).toMatch(/requires approval/);

    item = (await transition(f.users.bob, item, 'request_approval').expect(200)).body.item;
    expect(item.status).toBe('awaiting_approval');
    item = (await transition(f.users.alice, item, 'approve').expect(200)).body.item;
    expect(item.status).toBe('in_progress');
    item = (await transition(f.users.bob, item, 'resolve', { resolution: 'Refunded' }).expect(200)).body.item;
    expect(item.status).toBe('resolved');
  });

  it('rejects transitions that are not valid from the current status', async () => {
    const open = await createItem(f.users.alice, f.teams.pay);
    expect((await transition(f.users.alice, open, 'resolve', { resolution: 'x' })).status).toBe(409);
    const item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay);
    const close = await transition(f.users.alice, item, 'close');
    expect(close.status).toBe(409);
    expect(close.body.error.message).toMatch(/in progress/);
    // Unknown transitions are a validation error, not a generic status setter.
    expect((await transition(f.users.alice, item, 'teleport')).status).toBe(400);
  });

  it('requires a reason for rejections, blocks and cancellations', async () => {
    const item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay);
    expect((await transition(f.users.bob, item, 'block')).status).toBe(400);
    expect((await transition(f.users.alice, item, 'cancel', { note: '   ' })).status).toBe(400);
  });

  it('a rejected approval sends work back and must be re-requested', async () => {
    let item = await createClaimedItem(f.users.bob, f.users.bob, f.teams.pay, { requiresApproval: true });
    item = (await transition(f.users.bob, item, 'request_approval').expect(200)).body.item;
    item = (await transition(f.users.alice, item, 'reject', { note: 'Amount looks wrong' }).expect(200)).body.item;
    expect(item.approval.state).toBe('rejected');
    expect((await transition(f.users.bob, item, 'resolve', { resolution: 'x' })).status).toBe(409);
  });

  it('reopening an approved item requires approval again', async () => {
    let item = await createClaimedItem(f.users.bob, f.users.bob, f.teams.pay, { requiresApproval: true });
    item = (await transition(f.users.bob, item, 'request_approval')).body.item;
    item = (await transition(f.users.alice, item, 'approve')).body.item;
    item = (await transition(f.users.bob, item, 'resolve', { resolution: 'Done' })).body.item;
    item = (await transition(f.users.bob, item, 'reopen', { note: 'Customer says still broken' }).expect(200)).body.item;
    expect(item.status).toBe('in_progress');
    expect(item.approval.state).toBe('none');
  });

  it('releasing returns the item to the queue so someone else can claim it', async () => {
    const item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay);
    const released = (await as(f.users.bob).post(`/api/items/${item.id}/release`).expect(200)).body.item;
    expect(released.status).toBe('open');
    expect(released.assignee).toBeNull();
    await as(f.users.erin).post(`/api/items/${item.id}/claim`).expect(200);
  });

  it('records every change in the history, newest first, and a failed action records nothing', async () => {
    let item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay);
    item = (await as(f.users.bob).patch(`/api/items/${item.id}`).send({ version: item.version, priority: 'urgent' })).body.item;
    await as(f.users.erin).post(`/api/items/${item.id}/comments`).send({ body: 'I can help' });
    const jobsBefore = await Job.countDocuments();
    await transition(f.users.alice, { ...item, version: 1 }, 'block', { note: 'stale' }).expect(409);
    expect(await Job.countDocuments()).toBe(jobsBefore);

    const res = await as(f.users.victor).get(`/api/items/${item.id}/activity`).expect(200);
    expect(res.body.activities.map((a) => a.type)).toEqual(['commented', 'updated', 'claimed', 'created']);
    expect(res.body.activities[1].data.changes.priority).toEqual({ from: 'high', to: 'urgent' });
    expect(res.body.activities[1].actor.name).toBe('bob');
    expect(await Activity.countDocuments({ item: item.id })).toBe(4);
  });
});
