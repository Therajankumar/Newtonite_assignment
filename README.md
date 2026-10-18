# Newtonite Ops

An internal web application for coordinating operational work (incidents, customer issues,
payment investigations, compliance requests, approvals) across many teams. It replaces chat
threads and spreadsheets with one reliable system of record.

**Stack:** MongoDB · Express · React (Vite, TanStack Query) · Node.js

- **[ENGINEERING_DECISIONS.md](./ENGINEERING_DECISIONS.md)**: the key decisions and their trade-offs
- [Running it](#running-it) · [Tests](#tests) · [Architecture](#architecture) · [Known limitations](#known-limitations)

---

## What it does

- **Work items** with a type, priority, owner, reporter, due date, a "next action" line,
  and an optional **approval requirement**. They get human-friendly keys like `PAY-142`.
- **A workflow** of named transitions: claim → in progress ⇄ blocked → (request approval →
  approve/reject) → resolve → close, plus reopen and cancel, all with server-enforced rules.
- **Teams and per-team roles** (viewer / member / lead, plus org admins), enforced by the API
  at the resource level, including **separation of duties**: nobody can approve work they
  reported or are doing.
- **A full history** of each item. Every change records who did it, what changed (from → to) and
  any note, together with comments, in one paginated timeline.
- **A "What needs attention" dashboard**: assigned to me, awaiting my approval, unowned
  high-priority work, overdue, going stale (no activity for N days), and active counts per team.
- **Search and filters** (free text, exact key, team, status, priority, type, assignee, overdue)
  stored in the URL, with cursor pagination that stays fast as data grows.
- **In-app notifications**, generated asynchronously by a durable job queue.
- **Live updates** over Server-Sent Events. Open pages refresh when someone else changes
  an item, and an editor is warned *before* saving over someone else's change.

### Behaviour beyond simple CRUD

| Situation | How it's handled | Test |
|---|---|---|
| Two people claim the same item at once | Atomic conditional update: exactly one wins; others get `409 ALREADY_CLAIMED` with the winner's name. The UI claims optimistically and rolls back to the server's state. | `concurrency.test.js` |
| Editing or approving based on stale data | Version check on every write → `409 VERSION_CONFLICT` with the current item. The UI shows a field-by-field conflict view. Approvals of an item that changed are rejected. | `concurrency.test.js` |
| User repeats a request (double-click, retry after timeout) | `Idempotency-Key` on every write: replays the first response, rejects key reuse with a different body, and de-duplicates at the database level for creates and comments | `idempotency.test.js` |
| Workflow rules | Named transitions only; e.g. can't resolve an approval-required item until a different lead approves it | `workflow.test.js` |
| Resource-level authorization | Other teams' items are invisible (404) everywhere, including search; role and relationship checks on every action | `authorization.test.js` |
| Reliable async work | Transactional outbox, leased jobs, retries with backoff, dead-lettering, crash recovery, idempotent handlers | `jobs.test.js` |
| Large datasets | Indexed, team-scoped queries; keyset pagination with no duplicates or gaps while data changes | `queries.test.js` |

---

## Running it

### Option A: Docker (one command)

Requires Docker Desktop (or Docker Engine with the compose plugin).

```bash
docker compose up --build -d
docker compose exec app npm run seed          # demo users + 3,000 items (add -- --items 20000 for more)
```

Open **http://localhost:4000**. The login page lists the demo accounts; the password for all of them is `password123`.

### Option B: Local development (hot reload)

Requires **Node.js 20+** and Docker (only to run MongoDB).

```bash
# 1. MongoDB as a single-node replica set (needed for transactions and change streams)
docker compose up -d mongo

# 2. Install dependencies
npm run install:all

# 3. Configure and seed
cp server/.env.example server/.env
npm run seed

# 4. Start the API (http://localhost:4000) and the client (http://localhost:5173) in two terminals
npm run dev:server
npm run dev:client
```

Open **http://localhost:5173**.

> **Using your own MongoDB?** It must be a replica set. MongoDB Atlas, including the free
> tier, already is. Set `MONGO_URI` in `server/.env`. A standalone `mongod` will fail on
> the first write with "Transaction numbers are only allowed on a replica set member".

### Demo accounts (password `password123`)

| Email | Roles |
|---|---|
| admin@newtonite.test | Org admin (sees every team) |
| alice@newtonite.test | Payments **lead**, Engineering member |
| bob@newtonite.test | Payments member, Support member |
| carol@newtonite.test | Support **lead**, Payments viewer |
| dave@newtonite.test | Engineering **lead**, Ops member |
| erin@newtonite.test | Engineering member, Payments member |
| frank@newtonite.test | Ops **lead**, Compliance member |
| grace@newtonite.test | Compliance **lead**, Payments viewer |
| victor@newtonite.test | Viewer on Payments, Support, Engineering |

### Things to try in the demo

1. **Claim race.** Open the same open item as Bob and as Erin, in two different browsers or a
   private window. Click *Take ownership* in both. One wins; the other sees "Already claimed by…"
   and the page corrects itself.
2. **Edit conflict.** Open an item as Alice (lead) and as its assignee, and click *Edit* in both.
   Save a change in one. The other immediately shows "Someone else updated this item". Saving there
   shows a comparison and lets that user choose what wins.
3. **Approval flow.** As Bob, create a Payments item with *Requires approval*, claim it, and try
   to resolve it (refused). *Request approval*, then approve as Alice. Bob can now resolve it.
   Alice can't approve an item she reported herself.
4. **Permissions.** Log in as Victor (viewer): items are read-only except for commenting. Log in as
   Carol: Payments items are visible (she's a viewer there), but Engineering items don't exist for her.

### Configuration (`server/.env`)

| Variable | Default | Meaning |
|---|---|---|
| `MONGO_URI` | `mongodb://localhost:27017/newtonite?directConnection=true` | Must be a replica set |
| `JWT_SECRET` | dev value | **Change in any real deployment** |
| `RUN_WORKER` | `true` | Run the job worker inside the API. Set `false` and run `npm run worker` separately to scale them independently |
| `STALE_AFTER_DAYS` | `3` | Threshold for the dashboard's "going stale" section |
| `DEMO_LOGIN` | `true` outside production | Show demo accounts on the login page |

---

## Tests

```bash
npm test            # from the repo root (or `npm test` inside server/)
```

The tests run against a real MongoDB **replica set** started in memory by
`mongodb-memory-server`. The first run downloads a MongoDB binary (about 100 MB, then cached).
They exercise the HTTP API end to end with supertest and are built around the behaviours that
would be most dangerous if wrong: concurrent claims and edits, stale approvals, duplicate requests,
authorization boundaries, workflow guards, job retry and crash recovery, and pagination correctness.
There are 39 tests in 6 files, and they take about 15 seconds.

> Offline or behind a proxy that blocks fastdl.mongodb.org? Point the tests at a local
> binary: `MONGOMS_SYSTEM_BINARY=/path/to/mongod npm test`.

---

## Architecture

```
 Browser (React + TanStack Query)
   │  REST/JSON  (+ Idempotency-Key on writes, version on edits)
   │  SSE /api/events  ◄────────────────────────────────┐
   ▼                                                    │ "item X is now version N"
 Express API ── auth (JWT → user + team roles from DB)  │
   │            idempotency middleware                  │
   │            zod validation                          │
   ▼                                                    │
 Service layer ── permissions.js (pure policy)          │
   │              workflow.js   (state machine)         │
   │                                                    │
   │  one transaction per change:                       │
   │   ├─ conditional update of the work item (version) │
   │   ├─ insert Activity (history)                     │
   │   └─ insert Job (outbox)                           │
   ▼                                                    │
 MongoDB replica set ── change stream ──────────────────┘
   ▲
   │ lease (findOneAndUpdate) → run → done | retry w/ backoff | dead
 Job worker (in-process or `npm run worker`) ── idempotent handlers (notifications)
```

### Repository layout

```
server/
  src/
    domain/        permissions.js (authorization policy), workflow.js (state machine): pure, no I/O
    services/      workItemService.js (all writes), queryService.js (lists, dashboard), realtime.js (SSE)
    worker/        runner.js (lease/retry/backoff), handlers.js (idempotent job handlers)
    middleware/    auth, idempotency, validation, error handling
    models/        Mongoose schemas and indexes
    routes/        thin HTTP layer
  scripts/seed.js  demo data generator (tens of thousands of items in seconds)
  test/            integration tests (in-memory replica set)
client/
  src/api/         fetch wrapper (retries with the same idempotency key) and query/mutation hooks
  src/pages/       Dashboard, ItemsList, ItemDetail (conflict handling), NewItem, Login
  src/lib/         live updates (SSE → cache invalidation), formatting
```

### API overview

| Method & path | Purpose |
|---|---|
| `POST /api/auth/login` · `GET /api/auth/me` | Session |
| `GET /api/teams` · `GET /api/teams/:id/members` | My teams; assignable members |
| `GET /api/items?q&team&status&priority&type&assignee&overdue&sort&cursor&limit` | Filtered, cursor-paginated list |
| `POST /api/items` | Create (idempotent) |
| `GET /api/items/:id` | Item + `allowedActions` for the caller |
| `PATCH /api/items/:id` `{version, ...fields}` | Edit (optimistic concurrency) |
| `POST /api/items/:id/claim` · `/release` | Take or give up ownership |
| `POST /api/items/:id/assign` `{version, assigneeId}` | Lead assigns |
| `POST /api/items/:id/transitions/:name` `{version, note?, resolution?}` | Workflow step |
| `GET /api/items/:id/activity?before=` · `POST /api/items/:id/comments` | History and comments |
| `GET /api/dashboard` | Attention overview |
| `GET /api/notifications` · `POST /api/notifications/read` | In-app notifications |
| `GET /api/events?token=` | Server-Sent Events stream |

Errors share one shape: `{ "error": { "code", "message", "details" } }`. Codes include
`VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`VERSION_CONFLICT` / `ALREADY_CLAIMED` / `INVALID_STATE` / `REQUEST_IN_PROGRESS` (409) and
`IDEMPOTENCY_KEY_REUSED` (422). Conflict responses include `details.current`, the
authoritative item.

---

## Known limitations

- **Authentication is basic.** Email and password with a 12-hour JWT stored in `localStorage`;
  there are no refresh tokens, SSO or password reset. The SSE stream takes the token in the
  query string, because `EventSource` can't send headers. In production I would swap it for
  a short-lived stream ticket or use cookies.
- **No admin UI** for users, teams or memberships; they are created by the seed script.
- **Conflicts are per item, not per field.** Two people editing different fields still
  conflict. The UI makes resolving it one click.
- **Notifications are in-app only.** There is no email or Slack. The worker polls every
  second rather than being event-driven.
- **Free-text search** uses MongoDB's text index: word-based, with no fuzzy or prefix
  matching, and results are ordered by the chosen sort, not by relevance. At larger scale
  this would move to Atlas Search, OpenSearch or similar.
- **The dashboard's counts** are computed live with indexed queries. At far larger volumes
  they would come from pre-aggregated counters.
- **History grows without bound.** It has no archival or retention policy yet. It is
  paginated, so reading it stays cheap.
- **Frontend tests** are not included. Testing effort went to the server, where the
  correctness rules live. The UI flows (claim race, edit conflict) were checked manually and
  with a scripted browser run.

## What I'd do next with another week

1. Playwright tests for the conflict and claim flows in the UI.
2. SLA rules per priority: escalation jobs when urgent work sits unowned, built on the
   existing outbox.
3. Saved views and a "my teams' queue" board with drag-to-claim.
4. Email and Slack notification delivery with per-user preferences and digesting.
5. Admin screens for teams and roles, plus an audit log of permission changes.
6. Metrics and tracing (queue depth, job age, dead-job alerts, p95 latency per endpoint).
