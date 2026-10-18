import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { WorkItem } from '../src/models/index.js';
import { app, as, createClaimedItem, createItem, fixture } from './helpers.js';

let f;
beforeEach(async () => {
  f = await fixture();
});

describe('authorization is enforced by the API', () => {
  it('requires authentication', async () => {
    await request(app).get('/api/items').expect(401);
    await request(app).get('/api/items').set('Authorization', 'Bearer garbage').expect(401);
  });

  it('hides other teams\' items entirely (404, not 403) and excludes them from lists and search', async () => {
    const item = await createItem(f.users.alice, f.teams.pay, { title: 'Secret payout investigation' });
    await as(f.users.carol).get(`/api/items/${item.id}`).expect(404);
    await as(f.users.carol).post(`/api/items/${item.id}/comments`).send({ body: 'hi' }).expect(404);
    await as(f.users.carol).post(`/api/items/${item.id}/claim`).expect(404);
    const list = await as(f.users.carol).get('/api/items?q=payout').expect(200);
    expect(list.body.items).toHaveLength(0);
    // Asking for the other team explicitly does not widen access either.
    const explicit = await as(f.users.carol).get(`/api/items?team=${f.teams.pay._id}`).expect(200);
    expect(explicit.body.items).toHaveLength(0);
  });

  it('lets viewers read and comment but not change work', async () => {
    const item = await createItem(f.users.alice, f.teams.pay);
    const v = as(f.users.victor);
    const read = await v.get(`/api/items/${item.id}`).expect(200);
    expect(read.body.item.allowedActions).toEqual(['comment']);
    await v.post(`/api/items/${item.id}/comments`).send({ body: 'FYI' }).expect(201);
    await v.post(`/api/items/${item.id}/claim`).expect(403);
    await v.patch(`/api/items/${item.id}`).send({ version: 1, title: 'Hijacked title' }).expect(403);
    await v.post('/api/items').send({ team: String(f.teams.pay._id), title: 'New thing' }).expect(403);
  });

  it('only lets leads assign work to other people, and only to team members', async () => {
    const item = await createItem(f.users.alice, f.teams.pay);
    await as(f.users.bob).post(`/api/items/${item.id}/assign`).send({ version: 1, assigneeId: String(f.users.erin._id) }).expect(403);
    const notMember = await as(f.users.alice).post(`/api/items/${item.id}/assign`).send({ version: 1, assigneeId: String(f.users.carol._id) });
    expect(notMember.status).toBe(400);
    const viewer = await as(f.users.alice).post(`/api/items/${item.id}/assign`).send({ version: 1, assigneeId: String(f.users.victor._id) });
    expect(viewer.status).toBe(400);
    const ok = await as(f.users.alice).post(`/api/items/${item.id}/assign`).send({ version: 1, assigneeId: String(f.users.erin._id) }).expect(200);
    expect(ok.body.item.assignee.id).toBe(String(f.users.erin._id));
    expect(ok.body.item.status).toBe('in_progress');
  });

  it('only lets the assignee (or a lead) progress an item', async () => {
    const item = await createClaimedItem(f.users.alice, f.users.bob, f.teams.pay, { requiresApproval: false });
    await as(f.users.erin).post(`/api/items/${item.id}/transitions/resolve`).send({ version: item.version, resolution: 'done' }).expect(403);
    await as(f.users.erin).patch(`/api/items/${item.id}`).send({ version: item.version, priority: 'low' }).expect(403);
    await as(f.users.erin).post(`/api/items/${item.id}/release`).expect(403);
    await as(f.users.bob).post(`/api/items/${item.id}/transitions/resolve`).send({ version: item.version, resolution: 'done' }).expect(200);
  });

  it('enforces separation of duties on approvals', async () => {
    // Alice (a lead) reports and is assigned the item; she must not approve her own request.
    const item = await createClaimedItem(f.users.alice, f.users.alice, f.teams.pay, { requiresApproval: true });
    const pending = (await as(f.users.alice).post(`/api/items/${item.id}/transitions/request_approval`).send({ version: item.version }).expect(200)).body.item;
    expect(pending.allowedActions).not.toContain('approve');

    const self = await as(f.users.alice).post(`/api/items/${item.id}/transitions/approve`).send({ version: pending.version });
    expect(self.status).toBe(403);
    await as(f.users.bob).post(`/api/items/${item.id}/transitions/approve`).send({ version: pending.version }).expect(403);
    const ok = await as(f.users.linda).post(`/api/items/${item.id}/transitions/approve`).send({ version: pending.version }).expect(200);
    expect(ok.body.item.approval.state).toBe('approved');
    expect(ok.body.item.approval.by.id).toBe(String(f.users.linda._id));
  });

  it('stops a member from silently removing an approval requirement', async () => {
    const item = await createClaimedItem(f.users.bob, f.users.bob, f.teams.pay, { requiresApproval: true });
    await as(f.users.bob).patch(`/api/items/${item.id}`).send({ version: item.version, requiresApproval: false }).expect(403);
    expect((await WorkItem.findById(item.id).lean()).requiresApproval).toBe(true);
  });

  it('lets admins see every team', async () => {
    const item = await createItem(f.users.alice, f.teams.pay);
    await as(f.users.admin).get(`/api/items/${item.id}`).expect(200);
  });
});
