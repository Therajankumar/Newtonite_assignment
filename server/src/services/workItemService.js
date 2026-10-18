import { withTransaction } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isObjectId, sameId, toObjectId } from '../lib/ids.js';
import { Activity, Job, Membership, PRIORITY_RANK, Team, User, WorkItem, nextSequence } from '../models/index.js';
import { atLeast, denyReason, roleIn } from '../domain/permissions.js';
import { TRANSITIONS } from '../domain/workflow.js';
import { ITEM_POPULATE, serializeActivity, serializeItem } from './serialize.js';

/*
 * All writes to a work item follow the same pattern, inside one transaction:
 *   1. read the item and check the caller may see it (404 otherwise)
 *   2. check the caller's expected version, if they sent one (409 VERSION_CONFLICT)
 *   3. check permission + workflow rules against the *current* state (403 / 409)
 *   4. conditional update: { _id, version: <version we just read> } and version += 1
 *   5. append an activity record and an outbox job for asynchronous follow-up work
 * Step 4's condition means a write can never be applied on top of a state it did not see,
 * even if two requests interleave. If a concurrent transaction commits first, MongoDB
 * reports a write conflict and the driver re-runs the whole callback, which then sees the
 * new state and usually fails cleanly at step 2 or 3.
 */

const EDITABLE_FIELDS = ['title', 'description', 'type', 'priority', 'dueAt', 'nextAction', 'requiresApproval'];

async function populated(id) {
  return WorkItem.findById(id).populate(ITEM_POPULATE).lean();
}

async function readVisibleItem(user, id, session) {
  if (!isObjectId(String(id))) throw notFound('Work item');
  const item = await WorkItem.findById(id).session(session ?? null).lean();
  if (!item || !roleIn(user, item.team)) throw notFound('Work item');
  return item;
}

function throwIfDenied(user, item, action) {
  const reason = denyReason(user, item, action);
  if (!reason) return;
  if (reason.kind === 'forbidden') throw forbidden(reason.message);
  throw conflict('INVALID_STATE', reason.message);
}

function versionConflict(item) {
  return conflict('VERSION_CONFLICT', 'This item was changed by someone else since you loaded it', {
    currentVersion: item.version,
    itemId: String(item._id),
  });
}

async function recordActivity(session, { item, actor, type, data = {}, itemVersion = null, clientKey }) {
  const [activity] = await Activity.create(
    [{ item: item._id, team: item.team, actor: actor._id, type, data, itemVersion, clientKey }],
    { session },
  );
  // Outbox: follow-up work is committed atomically with the change that caused it. Recipients
  // are captured now, so a delayed job notifies the people involved at the time of the event.
  const recipients = [...new Set([...(item.watchers ?? []), item.assignee, item.reporter].filter(Boolean).map(String))];
  await Job.create([{ type: 'notify', payload: { activityId: activity._id, recipients } }], { session });
  return activity;
}

/**
 * Generic guarded mutation. `plan(item)` returns { set, activity } describing the change, or
 * null for a no-op. Returns the serialized, updated item.
 */
async function mutate(user, itemId, { action, expectedVersion, plan, addWatchers = [] }) {
  let resultId;
  try {
    await withTransaction(async (session) => {
      const item = await readVisibleItem(user, itemId, session);
      if (expectedVersion != null && item.version !== expectedVersion) throw versionConflict(item);
      throwIfDenied(user, item, action);
      const change = await plan(item, session);
      resultId = item._id;
      if (!change) return;

      const update = {
        $set: { ...change.set, lastActivityAt: new Date() },
        $inc: { version: 1 },
      };
      const watchers = addWatchers.filter(Boolean);
      if (watchers.length) update.$addToSet = { watchers: { $each: watchers } };
      const updated = await WorkItem.findOneAndUpdate({ _id: item._id, version: item.version }, update, {
        new: true,
        session,
        runValidators: true,
      }).lean();
      if (!updated) throw versionConflict(item);

      await recordActivity(session, {
        item: updated,
        actor: user,
        type: change.activity.type,
        data: change.activity.data,
        itemVersion: updated.version,
      });
    });
  } catch (err) {
    if (err.code === 'ALREADY_CLAIMED' || err.code === 'VERSION_CONFLICT' || err.code === 'INVALID_STATE') {
      // Give the client the authoritative current state so it can reconcile immediately.
      const current = await populated(itemId);
      if (current) err.details = { ...err.details, current: serializeItem(current, user) };
    }
    throw err;
  }
  return serializeItem(await populated(resultId), user);
}

// ---------------------------------------------------------------------------------------------

export async function getItem(user, id) {
  if (!isObjectId(String(id))) throw notFound('Work item');
  const item = await populated(id);
  if (!item || !roleIn(user, item.team)) throw notFound('Work item');
  return serializeItem(item, user);
}

export async function createItem(user, input, { createKey } = {}) {
  if (!isObjectId(input.team)) throw badRequest('team is required');
  const role = roleIn(user, input.team);
  if (!role) throw notFound('Team');
  if (!atLeast(role, 'member')) throw forbidden('Viewers cannot create work items');

  // Retried request whose first attempt already committed: return the original item.
  if (createKey) {
    const existing = await WorkItem.findOne({ reporter: user._id, createKey }).populate(ITEM_POPULATE).lean();
    if (existing) return { item: serializeItem(existing, user), replayed: true };
  }

  const team = await Team.findById(input.team).lean();
  if (!team) throw notFound('Team');

  let id;
  try {
    id = await withTransaction(async (session) => {
      const number = await nextSequence(`team:${team._id}`, session);
      const [item] = await WorkItem.create(
        [
          {
            team: team._id,
            number,
            key: `${team.key}-${number}`,
            title: input.title,
            description: input.description ?? '',
            type: input.type,
            priority: input.priority,
            priorityRank: PRIORITY_RANK[input.priority],
            dueAt: input.dueAt ?? null,
            nextAction: input.nextAction ?? '',
            requiresApproval: !!input.requiresApproval,
            reporter: user._id,
            watchers: [user._id],
            createKey,
          },
        ],
        { session },
      );
      await recordActivity(session, {
        item,
        actor: user,
        type: 'created',
        data: { title: item.title, priority: item.priority, type: item.type },
        itemVersion: 1,
      });
      return item._id;
    });
  } catch (err) {
    // Two identical requests raced past the lookup above: the unique index let one win.
    if (err.code === 11000 && createKey) {
      const existing = await WorkItem.findOne({ reporter: user._id, createKey }).populate(ITEM_POPULATE).lean();
      if (existing) return { item: serializeItem(existing, user), replayed: true };
    }
    throw err;
  }
  return { item: serializeItem(await populated(id), user), replayed: false };
}

export function updateItem(user, id, expectedVersion, patch) {
  return mutate(user, id, {
    action: 'edit',
    expectedVersion,
    plan: async (item) => {
      const changes = {};
      const set = {};
      for (const field of EDITABLE_FIELDS) {
        if (!(field in patch)) continue;
        const before = item[field] ?? null;
        const after = patch[field];
        const same = before instanceof Date || after instanceof Date
          ? (before ? new Date(before).getTime() : null) === (after ? new Date(after).getTime() : null)
          : before === after;
        if (same) continue;
        changes[field] = { from: before, to: after };
        set[field] = after;
      }
      if ('requiresApproval' in changes) {
        if (item.status === 'awaiting_approval') throw conflict('INVALID_STATE', 'Cannot change the approval requirement while approval is pending');
        if (changes.requiresApproval.to === false && !atLeast(roleIn(user, item.team), 'lead'))
          throw forbidden('Only a team lead can remove an approval requirement');
      }
      if ('priority' in changes) set.priorityRank = PRIORITY_RANK[set.priority];
      if (!Object.keys(changes).length) return null;
      // Long text is not copied into history in full; only that it changed.
      if (changes.description) changes.description = { changed: true };
      return { set, activity: { type: 'updated', data: { changes } } };
    },
  });
}

export async function claimItem(user, id) {
  return mutate(user, id, {
    action: 'claim',
    addWatchers: [user._id],
    plan: async (item) => ({
      set: { assignee: user._id, status: 'in_progress' },
      activity: { type: 'claimed', data: { from: item.status, to: 'in_progress' } },
    }),
  }).catch(async (err) => {
    // Turn the generic "already assigned" into a specific, actionable conflict.
    if (err.code === 'INVALID_STATE' && err.details?.current?.assignee) {
      const owner = err.details.current.assignee;
      const who = sameId(owner.id, user._id) ? 'you' : owner.name;
      throw new AppError(409, 'ALREADY_CLAIMED', `Already claimed by ${who}`, err.details);
    }
    throw err;
  });
}

export function releaseItem(user, id) {
  return mutate(user, id, {
    action: 'release',
    plan: async (item) => ({
      set: { assignee: null, status: 'open' },
      activity: { type: 'released', data: { from: item.status, to: 'open' } },
    }),
  });
}

export function assignItem(user, id, expectedVersion, assigneeId) {
  return mutate(user, id, {
    action: 'assign',
    expectedVersion,
    addWatchers: assigneeId ? [toObjectId(assigneeId)] : [],
    plan: async (item, session) => {
      if (sameId(item.assignee, assigneeId)) return null;
      let target = null;
      if (assigneeId) {
        if (!isObjectId(assigneeId)) throw badRequest('Invalid assignee');
        const membership = await Membership.findOne({ team: item.team, user: assigneeId }).session(session).lean();
        if (!membership || !atLeast(membership.role, 'member'))
          throw badRequest('Assignee must be a member or lead of this team');
        target = await User.findById(assigneeId).session(session).lean();
      } else if (item.status === 'awaiting_approval') {
        throw conflict('INVALID_STATE', 'Cannot unassign an item that is awaiting approval');
      }
      const previous = item.assignee ? await User.findById(item.assignee).session(session).lean() : null;
      let status = item.status;
      if (target && status === 'open') status = 'in_progress';
      if (!target && ['in_progress', 'blocked'].includes(status)) status = 'open';
      return {
        set: { assignee: target?._id ?? null, status },
        activity: {
          type: 'assigned',
          data: {
            from: previous ? { id: String(previous._id), name: previous.name } : null,
            to: target ? { id: String(target._id), name: target.name } : null,
            ...(status !== item.status ? { status: { from: item.status, to: status } } : {}),
          },
        },
      };
    },
  });
}

export function transitionItem(user, id, expectedVersion, name, input = {}) {
  const t = TRANSITIONS[name];
  if (!t) throw badRequest(`Unknown transition "${name}"`);
  if (t.requires && !input[t.requires]?.trim()) throw badRequest(`"${t.requires}" is required to ${name.replace('_', ' ')}`);
  return mutate(user, id, {
    action: name,
    expectedVersion,
    plan: async (item) => {
      const to = t.to(item);
      return {
        set: { status: to, ...(t.apply ? t.apply(item, user._id, input) : {}) },
        activity: {
          type: 'transitioned',
          data: {
            transition: name,
            from: item.status,
            to,
            ...(input.note ? { note: input.note } : {}),
            ...(input.resolution ? { resolution: input.resolution } : {}),
          },
        },
      };
    },
  });
}

export async function addComment(user, id, body, { clientKey } = {}) {
  if (clientKey) {
    const existing = await Activity.findOne({ actor: user._id, clientKey }).populate('actor', 'name email').lean();
    if (existing) return { activity: serializeActivity(existing), replayed: true };
  }
  let activityId;
  try {
    activityId = await withTransaction(async (session) => {
      const item = await readVisibleItem(user, id, session);
      throwIfDenied(user, item, 'comment');
      const activity = await recordActivity(session, { item, actor: user, type: 'commented', data: { body }, clientKey });
      // Comments do not change the item's content, so they do not bump its version (and do
      // not cause edit conflicts), but they do count as activity.
      await WorkItem.updateOne(
        { _id: item._id },
        { $set: { lastActivityAt: new Date() }, $addToSet: { watchers: user._id } },
        { session },
      );
      return activity._id;
    });
  } catch (err) {
    if (err.code === 11000 && clientKey) {
      const existing = await Activity.findOne({ actor: user._id, clientKey }).populate('actor', 'name email').lean();
      if (existing) return { activity: serializeActivity(existing), replayed: true };
    }
    throw err;
  }
  const activity = await Activity.findById(activityId).populate('actor', 'name email').lean();
  return { activity: serializeActivity(activity), replayed: false };
}

export async function listActivity(user, id, { before, limit = 30 }) {
  const item = await readVisibleItem(user, id);
  const filter = { item: item._id };
  if (before) {
    const cursorDoc = isObjectId(before) ? await Activity.findOne({ _id: before, item: item._id }).lean() : null;
    if (cursorDoc) {
      filter.$or = [
        { createdAt: { $lt: cursorDoc.createdAt } },
        { createdAt: cursorDoc.createdAt, _id: { $lt: cursorDoc._id } },
      ];
    }
  }
  const rows = await Activity.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate('actor', 'name email')
    .lean();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    activities: page.map(serializeActivity),
    nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
  };
}
