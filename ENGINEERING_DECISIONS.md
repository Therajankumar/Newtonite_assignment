# Engineering Decisions

This document explains the most important decisions behind Newtonite Ops and the trade-offs
each one involves. Each section covers what was chosen, why, and what it costs.

---

## 1. Optimistic concurrency with a version number on every work item, enforced in the write itself

**Decision.** Every work item has a `version` integer. Every write that changes an item's
content (edit, assign, workflow transition, claim, release) increments it. Clients must send
the version they based the change on (`{ "version": 4, ... }`). The write itself is conditional:

```js
WorkItem.findOneAndUpdate({ _id, version: versionWeJustRead }, { $set: ..., $inc: { version: 1 } })
```

If the caller's version doesn't match, the API returns `409 VERSION_CONFLICT` **with the
current state of the item**. The UI uses that state to show a field-by-field comparison
("your value" vs "current value") and lets the user choose between discarding their edits
and re-applying them on top.

**Why.** The brief's main risks are "one user viewing information another user has just
changed" and "multiple updates within a short period". Last-write-wins would silently undo
someone's work. That is exactly the "important actions silently disappear" problem the
company has today. Pessimistic locks (an "editing…" lock on an item) are fragile in a
browser app: tabs close, laptops sleep, and locks go stale.

**Applied to approvals too.** Approving an item requires the version the approver was
looking at. If the assignee changes the description (e.g. the refund amount) after the lead
opened the item, the approval is rejected. A lead never approves something they didn't see.
This is tested in `concurrency.test.js`.

**Trade-offs.**
- Conflicts are per item, not per field. Two people editing *different* fields still
  conflict. The UI's "apply my changes on top" re-sends only the fields the user changed,
  which covers the common case in one click. Automatic field-level merging was left out:
  it adds complexity, and it is sometimes wrong (a title and a description often change
  together for a reason).
- Comments do **not** bump the version. A busy discussion thread would otherwise make
  every edit fail. They only update `lastActivityAt`.

---

## 2. "Claim" is a conditional atomic update, not read-then-write

**Decision.** Taking ownership (`POST /items/:id/claim`) needs no version from the client.
The server reads the item, checks it is `open` and unassigned, and writes with the same
version guard. If ten people click "Take ownership" at the same moment, exactly one write
matches. The rest get `409 ALREADY_CLAIMED` with the winner's name and the item's current
state.

On the frontend, claiming is **optimistic**: the UI shows you as the owner immediately.
If the server says someone else won, the mutation's `onError` replaces the optimistic state
with the authoritative state from the 409 body (not the cached state from before) and shows
"Already claimed by Alice". This avoids a refetch, and the UI can never be left believing a
claim succeeded when it didn't.

**Why.** "Two users attempting to take responsibility for the same work" is the most
common real-world race in this domain. Claim doesn't require a client version because the
user's intent ("I'll take it if nobody has") doesn't depend on what else they saw. Requiring
one would cause spurious failures whenever someone edited an unrelated field.

**Tested.** `concurrency.test.js` fires 10 simultaneous claims from different users and
asserts: exactly one 200, nine 409s naming the winner, one `claimed` activity, and one
follow-up job.

---

## 3. One MongoDB transaction per change: item update + history entry + outbox job

**Decision.** Every mutation runs in a multi-document transaction that:
1. updates the work item (conditionally, see above),
2. appends an `Activity` document (the item's history: who, what, from → to), and
3. inserts a `Job` document for asynchronous follow-up work (notifications).

This is the **transactional outbox** pattern. A worker polls the `jobs` collection and
leases jobs atomically with `findOneAndUpdate` (status → running, `lockedUntil` = now + 30s).

**Why.**
- History must be trustworthy. "What happened and why" was an explicit requirement, so an
  item change without its history entry (or the reverse) must be impossible. Writing both
  in one transaction guarantees it.
- Notifications should not slow down or break the main action, but they must not be lost
  either. Firing them from an in-memory queue or a `setTimeout` after the response would
  lose them on a crash. The outbox makes them exactly as durable as the change itself.

**Failure behaviour of the worker.**
| Situation | What happens |
|---|---|
| Handler throws | `attempts++`, rescheduled with exponential backoff (2s, 4s, 8s… capped at 5 min) |
| Fails `maxAttempts` times | Marked `dead` with `lastError`, so it is visible and not retried forever |
| Worker crashes mid-job | Lease expires; another worker re-leases it (`status: running, lockedUntil < now`) |
| Job runs twice | Handlers are idempotent: notifications are upserted on a unique `(user, activity)` key |
| Job delayed | Recipients are captured **when the event happens** (in the job payload), so a delayed job notifies the people involved at the time, not whoever is watching later |

The last row came from a bug the test suite caught: computing recipients at run time
notified a user about an event from before they joined the item.

**Trade-offs.**
- Transactions require MongoDB running as a replica set (a single-node one is fine). This
  adds a setup step, which docker-compose handles.
- Concurrent creates in the same team contend on that team's counter document (used for
  human-friendly keys like `PAY-142`). The driver retries transient write conflicts
  automatically. At much higher write rates I would allocate numbers outside the transaction
  and accept gaps.
- Polling adds up to `WORKER_POLL_MS` (1s) of latency to notifications. That is acceptable
  for in-app notifications. A change stream on `jobs` could remove it.

---

## 4. Authorization: per-team roles, resource-level checks, one pure policy module

**Decision.** Users have a role **per team** (`viewer < member < lead`), stored in a separate
`memberships` collection. Org admins act as leads everywhere. All rules live in one pure
function, `denyReason(user, item, action)` in `server/src/domain/permissions.js`. It combines:

- the caller's role in the **item's team**, and
- their **relationship to the item** (assignee, reporter).

| Action | Rule |
|---|---|
| View, comment | Any role in the item's team |
| Create | member+ |
| Edit | lead, or a member who is the assignee or reporter |
| Claim | member+, and the item must be open and unassigned |
| Assign to someone else | lead; the target must be a member/lead of that team |
| Progress (block, resolve, request approval) | the assignee, or a lead |
| Approve / reject | a lead who is **neither the reporter nor the assignee** (separation of duties) |
| Remove an approval requirement | lead only (a member can't quietly skip approval) |

The same function both **enforces** permissions in the service layer and produces the
`allowedActions` array the UI uses to decide which buttons to show. The UI never decides
permissions itself, and the two can't drift apart.

Items in teams you don't belong to return **404, not 403**, and every list or search query is
scoped to your teams *inside the database query*. You can't discover that an item exists
by guessing its ID, and you can't see it by passing `?team=<other team>`.

Roles are **not** stored in the JWT. They are loaded per request (one indexed query), so
removing someone from a team takes effect immediately rather than when their token expires.

**Trade-offs.** A fixed role hierarchy is simpler than a configurable permission system
and covers the brief. A real company would eventually want per-team custom roles. Because
everything goes through `denyReason`, that change is contained in one module.

---

## 5. Idempotency keys for every unsafe request, with a database-level backstop

**Decision.** The client sends an `Idempotency-Key` header (a UUID) with every write.
Middleware reserves the key (unique index on `user + key`), runs the handler, and stores the
response:

- **Retry after success** → the stored response is replayed (`Idempotent-Replayed: true`). The handler doesn't run again.
- **Retry while the first request is still running** → `409 REQUEST_IN_PROGRESS`; the client waits and retries.
- **Same key, different body** → `422`. That is a client bug, not a retry.
- **Handler failed with a 5xx** → the reservation is released so the retry can run.
- **Process died mid-request** → the reservation has a lock expiry, after which a retry can take it over.

The frontend `api()` wrapper retries network errors and 502/503/504 **only** for GETs and for
writes that carry a key, and always with the **same** key. Forms keep one key per
*intent*: double-clicking Submit, or pressing it again after a timeout, reuses the key.
Changing the form after a rejected (4xx) submission generates a new one.

For **create item** and **add comment**, which are the operations where a duplicate is most
harmful, the key is also stored on the created document under a unique index. Even if the
idempotency record were lost, the database itself rejects the duplicate and we return the
original.

**Why.** "A user repeating an action because they are unsure whether the first request
succeeded" is very common in a stressed operational setting: slow networks, double-clicks,
impatient refreshes. Without this, a retried "resolve" after a timeout would come back as a
confusing VERSION_CONFLICT about the user's *own* change, and a retried create would open a
duplicate incident. Both cases are tested in `idempotency.test.js`.

**Trade-off.** The idempotency record and the business transaction are not written
atomically. A crash between them is covered by the lock expiry plus, for creates and
comments, the unique index. For other operations the version check turns a re-execution
into a clean 409 rather than a double write.

---

## Other decisions, briefly

- **Named workflow transitions instead of a "status" field you can set.** `POST
  /items/:id/transitions/resolve`, not `PATCH {status: 'resolved'}`. Every transition has
  explicit allowed source states, an actor rule, required input (e.g. a resolution note) and
  guards (e.g. "approval required before resolving"). Invalid transitions return `409
  INVALID_STATE`. Reopening an approved item resets the approval, because work done after
  approval hasn't been approved.
- **Keyset (cursor) pagination, never offsets.** Lists sort by `(updatedAt, _id)` or
  `(priorityRank, updatedAt, _id)`. The cursor encodes the last row's sort values. Pages
  stay fast at any depth and don't duplicate or skip rows when items change between page
  loads (tested). There are no total counts on lists, because they are expensive at scale.
  The dashboard runs bounded `count + top N` queries.
- **Indexes match the access paths.** All list and dashboard queries are scoped by
  `team` (or `assignee`) first, with compound indexes for each. There is also a weighted
  text index on key, title and description, and exact key lookups (`PAY-12`) bypass text
  search.
- **Live updates are hints, not data.** A MongoDB change stream feeds Server-Sent Events
  carrying only `{itemId, version}`. Clients refetch through the normal authorized API.
  Because the change stream is shared across API instances, this works when the API is
  scaled out, and a missed event only means slightly older data. Live updates are also
  what show the "someone else updated this item while you were editing" warning *before*
  the user hits Save.
- **Server state lives in TanStack Query, not a global store.** Every server-derived piece
  of UI state has a query key. Mutations write the server's response into the cache and
  invalidate affected lists. There is no Redux or other hand-maintained mirror of
  server data that could drift.

## Deliberately not built

- SSO, user and team administration screens (managed via the seed script).
- Email or Slack delivery of notifications. The outbox handler is the place to add it, and
  the idempotency rules above apply unchanged.
- Attachments, SLAs and automatic escalation, custom fields, saved views.
- Rate limiting, audit export, and history retention or archival.
