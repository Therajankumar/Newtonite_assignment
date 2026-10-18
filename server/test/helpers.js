import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signToken } from '../src/middleware/auth.js';
import { Membership, Team, User } from '../src/models/index.js';

export const app = createApp({ logRequests: false });

/**
 * Two teams. PAY: alice (lead), linda (lead), bob + erin (members), victor (viewer).
 * SUP: carol (lead) - an outsider as far as PAY is concerned. Plus an org admin.
 */
export async function fixture() {
  const [pay, sup] = await Team.create([
    { key: 'PAY', name: 'Payments' },
    { key: 'SUP', name: 'Support' },
  ]);
  const mk = (name, extra = {}) => User.create({ email: `${name}@test.dev`, name, passwordHash: 'x', ...extra });
  const users = {
    alice: await mk('alice'),
    linda: await mk('linda'),
    bob: await mk('bob'),
    erin: await mk('erin'),
    victor: await mk('victor'),
    carol: await mk('carol'),
    admin: await mk('admin', { isAdmin: true }),
  };
  await Membership.create([
    { user: users.alice._id, team: pay._id, role: 'lead' },
    { user: users.linda._id, team: pay._id, role: 'lead' },
    { user: users.bob._id, team: pay._id, role: 'member' },
    { user: users.erin._id, team: pay._id, role: 'member' },
    { user: users.victor._id, team: pay._id, role: 'viewer' },
    { user: users.carol._id, team: sup._id, role: 'lead' },
  ]);
  return { teams: { pay, sup }, users };
}

/** Supertest client authenticated as `user`. */
export function as(user) {
  const auth = { Authorization: `Bearer ${signToken(user)}` };
  const wrap = (method) => (url) => request(app)[method](url).set(auth);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch') };
}

export const newKey = () => crypto.randomUUID();

export async function createItem(user, team, overrides = {}) {
  const res = await as(user)
    .post('/api/items')
    .send({ team: String(team._id), title: 'Investigate failed payout', priority: 'high', type: 'payment', ...overrides });
  if (res.status !== 201) throw new Error(`createItem failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.item;
}

/** Create an item already claimed by `assignee` (so it is in_progress). */
export async function createClaimedItem(reporter, assignee, team, overrides) {
  const item = await createItem(reporter, team, overrides);
  const res = await as(assignee).post(`/api/items/${item.id}/claim`);
  if (res.status !== 200) throw new Error(`claim failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.item;
}
