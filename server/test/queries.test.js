import { beforeEach, describe, expect, it } from 'vitest';
import { Counter, PRIORITY_RANK, WorkItem } from '../src/models/index.js';
import { as, createItem, fixture } from './helpers.js';

let f;
beforeEach(async () => {
  f = await fixture();
});

async function bulkItems(n) {
  const priorities = ['low', 'medium', 'high', 'urgent'];
  const base = Date.now();
  const docs = Array.from({ length: n }, (_, i) => {
    const priority = priorities[i % 4];
    // Deliberately many identical timestamps, to prove the cursor tie-breaks correctly.
    const at = new Date(base - Math.floor(i / 7) * 1000);
    return {
      team: f.teams.pay._id, number: i + 1, key: `PAY-${i + 1}`, title: `Item ${i + 1}`, priority,
      priorityRank: PRIORITY_RANK[priority], reporter: f.users.alice._id, createdAt: at, updatedAt: at,
    };
  });
  await WorkItem.insertMany(docs, { timestamps: false });
  await Counter.create({ _id: `team:${f.teams.pay._id}`, seq: n });
}

async function pageThrough(user, query) {
  const seen = [];
  let cursor = null;
  do {
    const res = await as(user).get(`/api/items?${query}&limit=20${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
    seen.push(...res.body.items);
    cursor = res.body.nextCursor;
  } while (cursor);
  return seen;
}

describe('listing, filtering and pagination', () => {
  it('pages through every item exactly once for each sort order', async () => {
    await bulkItems(130);
    for (const sort of ['updated', 'priority', 'created']) {
      const seen = await pageThrough(f.users.bob, `sort=${sort}`);
      expect(seen).toHaveLength(130);
      expect(new Set(seen.map((i) => i.id)).size).toBe(130);
    }
    const byPriority = await pageThrough(f.users.bob, 'sort=priority');
    const ranks = byPriority.map((i) => PRIORITY_RANK[i.priority]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  it('does not repeat items when new work arrives between pages', async () => {
    await bulkItems(40);
    const first = await as(f.users.bob).get('/api/items?limit=20').expect(200);
    await createItem(f.users.alice, f.teams.pay, { title: 'Brand new urgent thing' });
    const second = await as(f.users.bob).get(`/api/items?limit=20&cursor=${first.body.nextCursor}`).expect(200);
    const ids = [...first.body.items, ...second.body.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('filters by status, priority and assignee, and searches by key or text', async () => {
    const a = await createItem(f.users.alice, f.teams.pay, { title: 'Chargeback dispute for Globex', priority: 'urgent' });
    await createItem(f.users.alice, f.teams.pay, { title: 'Rotate ledger credentials', priority: 'low' });
    await as(f.users.bob).post(`/api/items/${a.id}/claim`).expect(200);

    const mine = await as(f.users.bob).get('/api/items?assignee=me').expect(200);
    expect(mine.body.items.map((i) => i.key)).toEqual([a.key]);
    const unassigned = await as(f.users.bob).get('/api/items?assignee=none&status=open').expect(200);
    expect(unassigned.body.items).toHaveLength(1);
    const urgent = await as(f.users.bob).get('/api/items?priority=urgent,high').expect(200);
    expect(urgent.body.items.map((i) => i.id)).toEqual([a.id]);
    const byKey = await as(f.users.bob).get(`/api/items?q=${a.key.toLowerCase()}`).expect(200);
    expect(byKey.body.items.map((i) => i.id)).toEqual([a.id]);
    const byText = await as(f.users.bob).get('/api/items?q=globex').expect(200);
    expect(byText.body.items.map((i) => i.id)).toEqual([a.id]);
  });

  it('rejects malformed cursors and filters instead of failing', async () => {
    await as(f.users.bob).get('/api/items?cursor=not-a-cursor').expect(400);
    await as(f.users.bob).get('/api/items?team=xyz').expect(400);
    await as(f.users.bob).get('/api/items?sort=random').expect(400);
  });

  it('builds a dashboard of what needs attention', async () => {
    const urgent = await createItem(f.users.alice, f.teams.pay, { priority: 'urgent' });
    const overdue = await createItem(f.users.alice, f.teams.pay, { priority: 'low', dueAt: new Date(Date.now() - 86400_000).toISOString() });
    await as(f.users.bob).post(`/api/items/${overdue.id}/claim`).expect(200);
    const res = await as(f.users.bob).get('/api/dashboard').expect(200);
    const s = res.body.sections;
    expect(s.assignedToMe.items.map((i) => i.id)).toEqual([overdue.id]);
    expect(s.unassignedUrgent.items.map((i) => i.id)).toEqual([urgent.id]);
    expect(s.overdue.count).toBe(1);
    expect(res.body.statusByTeam[0].counts).toEqual({ open: 1, in_progress: 1 });
  });
});
