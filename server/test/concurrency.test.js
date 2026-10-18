import { beforeEach, describe, expect, it } from 'vitest';
import { Activity, Job, Membership, User, WorkItem } from '../src/models/index.js';
import { as, createClaimedItem, createItem, fixture } from './helpers.js';

let f;
beforeEach(async () => {
  f = await fixture();
});

describe('claiming work concurrently', () => {
  it('lets exactly one of many simultaneous claims win', async () => {
    // Ten extra members of the team all race to claim the same item.
    const racers = [];
    for (let i = 0; i < 10; i++) {
      const u = await User.create({ email: `racer${i}@test.dev`, name: `Racer ${i}`, passwordHash: 'x' });
      await Membership.create({ user: u._id, team: f.teams.pay._id, role: 'member' });
      racers.push(u);
    }
    const item = await createItem(f.users.alice, f.teams.pay);

    const results = await Promise.all(racers.map((u) => as(u).post(`/api/items/${item.id}/claim`)));

    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);
    for (const r of losers) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('ALREADY_CLAIMED');
      // Losers are told who won and given the current state, so the UI can reconcile.
      expect(r.body.error.details.current.assignee.id).toBe(winners[0].body.item.assignee.id);
    }

    const stored = await WorkItem.findById(item.id).lean();
    expect(String(stored.assignee)).toBe(winners[0].body.item.assignee.id);
    expect(stored.status).toBe('in_progress');
    expect(stored.version).toBe(2);
    // History and follow-up work reflect a single claim, not ten.
    expect(await Activity.countDocuments({ item: item.id, type: 'claimed' })).toBe(1);
    expect(await Job.countDocuments({})).toBe(2); // created + claimed
  });

  it('tells a user who claims twice that they already own it', async () => {
    const item = await createItem(f.users.alice, f.teams.pay);
    await as(f.users.bob).post(`/api/items/${item.id}/claim`).expect(200);
    const again = await as(f.users.bob).post(`/api/items/${item.id}/claim`);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('Already claimed by you');
  });
});

describe('stale updates (optimistic concurrency)', () => {
  it('rejects an edit based on an old version and returns the current state', async () => {
    const item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay);
    // Bob and Alice both have version 2 open in their browsers.
    await as(f.users.bob).patch(`/api/items/${item.id}`).send({ version: item.version, priority: 'urgent' }).expect(200);

    const stale = await as(f.users.alice).patch(`/api/items/${item.id}`).send({ version: item.version, priority: 'low' });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.current.priority).toBe('urgent');
    expect(stale.body.error.details.current.version).toBe(item.version + 1);
    const stored = await WorkItem.findById(item.id).lean();
    expect(stored.priority).toBe('urgent'); // Alice's stale write did not silently overwrite Bob's.
  });

  it('applies exactly one of several simultaneous edits made from the same version', async () => {
    const item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay);
    const editors = [f.users.alice, f.users.linda, f.users.bob, f.users.alice, f.users.linda];
    const results = await Promise.all(
      editors.map((u, i) => as(u).patch(`/api/items/${item.id}`).send({ version: item.version, title: `Edit number ${i}` })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const stored = await WorkItem.findById(item.id).lean();
    expect(stored.version).toBe(item.version + 1);
    expect(await Activity.countDocuments({ item: item.id, type: 'updated' })).toBe(1);
  });

  it('refuses to approve an item that changed after the approver looked at it', async () => {
    const item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay, { requiresApproval: true });
    const pending = (
      await as(f.users.bob).post(`/api/items/${item.id}/transitions/request_approval`).send({ version: item.version }).expect(200)
    ).body.item;
    // Linda opens the approval screen; meanwhile Bob changes the item's description.
    await as(f.users.bob).patch(`/api/items/${item.id}`).send({ version: pending.version, description: 'Actually refund $50,000' }).expect(200);

    const approve = await as(f.users.linda).post(`/api/items/${item.id}/transitions/approve`).send({ version: pending.version });

    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('VERSION_CONFLICT');
    expect((await WorkItem.findById(item.id).lean()).approval.state).toBe('pending');
  });

  it('does not bump the version for no-op edits or comments', async () => {
    const item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay);
    const same = await as(f.users.bob).patch(`/api/items/${item.id}`).send({ version: item.version, priority: item.priority }).expect(200);
    expect(same.body.item.version).toBe(item.version);
    await as(f.users.alice).post(`/api/items/${item.id}/comments`).send({ body: 'Looking into it' }).expect(201);
    // A comment arriving mid-edit must not make the editor's save fail.
    await as(f.users.bob).patch(`/api/items/${item.id}`).send({ version: item.version, nextAction: 'Call bank' }).expect(200);
  });
});
