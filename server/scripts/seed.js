/**
 * Seed demo data. Usage:
 *   npm run seed                 # wipe and create demo users/teams + 3,000 items
 *   npm run seed -- --items 30000
 */
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/db.js';
import {
  Activity, Counter, IdempotencyKey, Job, Membership, Notification, PRIORITIES, PRIORITY_RANK, Team, User, WorkItem, ensureIndexes,
} from '../src/models/index.js';

const argIdx = process.argv.indexOf('--items');
const ITEM_COUNT = argIdx > -1 ? Number(process.argv[argIdx + 1]) : 3000;
const PASSWORD = 'password123';

const TEAMS = [
  { key: 'PAY', name: 'Payments' },
  { key: 'SUP', name: 'Customer Support' },
  { key: 'ENG', name: 'Platform Engineering' },
  { key: 'CMP', name: 'Compliance' },
  { key: 'OPS', name: 'Operations' },
];

// [email, name, isAdmin, { TEAM: role }]
const USERS = [
  ['admin@newtonite.test', 'Ada Admin', true, {}],
  ['alice@newtonite.test', 'Alice Lead', false, { PAY: 'lead', ENG: 'member' }],
  ['bob@newtonite.test', 'Bob Member', false, { PAY: 'member', SUP: 'member' }],
  ['carol@newtonite.test', 'Carol Support', false, { SUP: 'lead', PAY: 'viewer' }],
  ['dave@newtonite.test', 'Dave Engineer', false, { ENG: 'lead', OPS: 'member' }],
  ['erin@newtonite.test', 'Erin Engineer', false, { ENG: 'member', PAY: 'member' }],
  ['frank@newtonite.test', 'Frank Ops', false, { OPS: 'lead', CMP: 'member' }],
  ['grace@newtonite.test', 'Grace Compliance', false, { CMP: 'lead', PAY: 'viewer' }],
  ['victor@newtonite.test', 'Victor Viewer', false, { PAY: 'viewer', SUP: 'viewer', ENG: 'viewer' }],
];

const TEMPLATES = {
  incident: ['API latency spike on {svc}', 'Elevated 5xx errors from {svc}', '{svc} queue backlog growing', 'Pager alert: {svc} health check failing'],
  customer_issue: ['Customer {cust} cannot log in', '{cust} reports missing invoice', 'Refund request from {cust}', '{cust} charged twice for subscription'],
  engineering: ['Upgrade {svc} dependencies', 'Flaky test in {svc} pipeline', 'Add metrics to {svc}', 'Investigate memory growth in {svc}'],
  payment: ['Investigate failed payout batch #{n}', 'Chargeback dispute for {cust}', 'Reconcile settlement mismatch #{n}', 'Payment stuck in pending for {cust}'],
  compliance: ['KYC review for {cust}', 'Data deletion request from {cust}', 'Quarterly access review #{n}', 'Audit evidence request #{n}'],
  task: ['Rotate credentials for {svc}', 'Update runbook for {svc}', 'Onboard new vendor #{n}', 'Prepare weekly ops report #{n}'],
};
const SERVICES = ['billing-api', 'ledger', 'auth-service', 'checkout', 'notifications', 'search', 'payouts', 'reporting'];
const CUSTOMERS = ['Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark Ind.', 'Wayne Ent.', 'Soylent'];
const TEAM_TYPES = {
  PAY: ['payment', 'customer_issue', 'incident', 'task'],
  SUP: ['customer_issue', 'task'],
  ENG: ['engineering', 'incident', 'task'],
  CMP: ['compliance', 'task'],
  OPS: ['task', 'incident', 'compliance'],
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const weighted = (pairs) => {
  let r = Math.random() * pairs.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[0][0];
};

await connectDb();
console.log('Resetting database...');
await mongoose.connection.db.dropDatabase();
await ensureIndexes();

const teams = await Team.insertMany(TEAMS);
const teamByKey = Object.fromEntries(teams.map((t) => [t.key, t]));
const passwordHash = await bcrypt.hash(PASSWORD, 10);
const users = await User.insertMany(USERS.map(([email, name, isAdmin]) => ({ email, name, isAdmin, passwordHash })));
const memberships = [];
USERS.forEach(([, , , roles], i) => {
  for (const [key, role] of Object.entries(roles)) memberships.push({ user: users[i]._id, team: teamByKey[key]._id, role });
});
await Membership.insertMany(memberships);

const workersByTeam = Object.fromEntries(
  teams.map((t) => [String(t._id), memberships.filter((m) => String(m.team) === String(t._id) && m.role !== 'viewer').map((m) => m.user)]),
);

console.log(`Creating ${ITEM_COUNT} work items...`);
const counters = Object.fromEntries(teams.map((t) => [String(t._id), 0]));
const now = Date.now();
const BATCH = 2000;
for (let start = 0; start < ITEM_COUNT; start += BATCH) {
  const docs = [];
  for (let i = start; i < Math.min(start + BATCH, ITEM_COUNT); i++) {
    const team = pick(teams);
    const workers = workersByTeam[String(team._id)];
    const number = ++counters[String(team._id)];
    const type = pick(TEAM_TYPES[team.key]);
    const title = pick(TEMPLATES[type])
      .replace('{svc}', pick(SERVICES))
      .replace('{cust}', pick(CUSTOMERS))
      .replace('{n}', String(1000 + Math.floor(Math.random() * 9000)));
    const priority = weighted([['low', 3], ['medium', 5], ['high', 2], ['urgent', 0.6]]);
    // Older items are more likely to be finished.
    const ageDays = Math.random() ** 2 * 120;
    const createdAt = new Date(now - ageDays * 86400_000);
    const status =
      ageDays > 20
        ? weighted([['closed', 6], ['resolved', 2], ['cancelled', 1], ['in_progress', 0.5], ['open', 0.3]])
        : weighted([['open', 3], ['in_progress', 4], ['blocked', 0.6], ['awaiting_approval', 0.5], ['resolved', 1]]);
    const requiresApproval = type === 'payment' || type === 'compliance' ? Math.random() < 0.5 : status === 'awaiting_approval';
    // Invariant kept by the API: open items are unassigned, in-flight items always have an owner.
    const assignee = status === 'open' || (status === 'cancelled' && Math.random() < 0.5) ? null : pick(workers);
    const updatedAt = new Date(createdAt.getTime() + Math.random() * (now - createdAt.getTime()));
    const reporter = pick(workers);
    docs.push({
      team: team._id,
      number,
      key: `${team.key}-${number}`,
      title,
      description: `Seeded ${type.replace('_', ' ')} for demo purposes.\n\nReported via the ${pick(['#ops', '#support', 'email', 'phone', 'monitoring'])} channel.`,
      type,
      priority,
      priorityRank: PRIORITY_RANK[priority],
      status,
      assignee,
      reporter,
      requiresApproval: status === 'awaiting_approval' ? true : requiresApproval,
      approval: { state: status === 'awaiting_approval' ? 'pending' : requiresApproval && ['resolved', 'closed'].includes(status) ? 'approved' : 'none' },
      dueAt: Math.random() < 0.35 ? new Date(createdAt.getTime() + (2 + Math.random() * 20) * 86400_000) : null,
      nextAction: ['open', 'in_progress', 'blocked'].includes(status) ? pick(['Confirm scope with requester', 'Check logs', 'Waiting on vendor reply', 'Draft fix', '']) : '',
      resolution: ['resolved', 'closed'].includes(status) ? 'Handled - see comments.' : '',
      watchers: [...new Set([String(reporter), assignee && String(assignee)].filter(Boolean))],
      version: 1,
      lastActivityAt: updatedAt,
      createdAt,
      updatedAt,
    });
  }
  const inserted = await WorkItem.insertMany(docs, { timestamps: false });
  await Activity.insertMany(
    inserted.map((it) => ({ item: it._id, team: it.team, actor: it.reporter, type: 'created', data: { title: it.title, priority: it.priority, type: it.type }, itemVersion: 1, createdAt: it.createdAt })),
    { timestamps: false },
  );
  process.stdout.write(`  ${Math.min(start + BATCH, ITEM_COUNT)}\r`);
}
await Counter.insertMany(Object.entries(counters).map(([teamId, seq]) => ({ _id: `team:${teamId}`, seq })));
await Promise.all([Job.deleteMany({}), Notification.deleteMany({}), IdempotencyKey.deleteMany({})]);

console.log(`\nDone. Log in with any of these (password: ${PASSWORD}):`);
for (const [email, , isAdmin, roles] of USERS) {
  console.log(`  ${email.padEnd(24)} ${isAdmin ? 'admin' : Object.entries(roles).map(([k, r]) => `${k}:${r}`).join(', ')}`);
}
await disconnectDb();
