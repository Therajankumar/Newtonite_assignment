import { config } from '../config.js';
import { badRequest } from '../errors.js';
import { isObjectId, toObjectId } from '../lib/ids.js';
import { afterCursorFilter, decodeCursor, encodeCursor } from '../lib/cursor.js';
import { ACTIVE_STATUSES, PRIORITY_RANK, Team, WorkItem } from '../models/index.js';
import { teamIdsFor } from '../domain/permissions.js';
import { ITEM_POPULATE, serializeItem } from './serialize.js';

// Every sort ends in _id so the order is total and cursors are unambiguous.
const SORTS = {
  updated: [['updatedAt', -1], ['_id', -1]],
  created: [['createdAt', -1], ['_id', -1]],
  priority: [['priorityRank', -1], ['updatedAt', -1], ['_id', -1]],
};

const KEY_PATTERN = /^[A-Za-z]{2,10}-\d+$/;

/** Restrict any query to the teams the caller can see. Admins see everything. */
function visibleTeamsFilter(user, requestedTeams) {
  if (user.isAdmin) return requestedTeams?.length ? { team: { $in: requestedTeams.map(toObjectId) } } : {};
  const mine = new Set(teamIdsFor(user));
  const teams = requestedTeams?.length ? requestedTeams.filter((t) => mine.has(t)) : [...mine];
  return { team: { $in: teams.map(toObjectId) } };
}

const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

export function buildItemFilter(user, q) {
  const teams = csv(q.team);
  if (teams.some((t) => !isObjectId(t))) throw badRequest('Invalid team id');
  const filter = { ...visibleTeamsFilter(user, teams) };

  const statuses = csv(q.status);
  if (statuses.length === 1 && statuses[0] === 'active') filter.status = { $in: ACTIVE_STATUSES };
  else if (statuses.length) filter.status = { $in: statuses };

  const priorities = csv(q.priority);
  if (priorities.length) filter.priorityRank = { $in: priorities.map((p) => PRIORITY_RANK[p]).filter(Boolean) };

  const types = csv(q.type);
  if (types.length) filter.type = { $in: types };

  if (q.assignee === 'me') filter.assignee = user._id;
  else if (q.assignee === 'none') filter.assignee = null;
  else if (q.assignee) {
    if (!isObjectId(q.assignee)) throw badRequest('Invalid assignee');
    filter.assignee = toObjectId(q.assignee);
  }
  if (q.reporter === 'me') filter.reporter = user._id;

  if (q.overdue === 'true') {
    filter.dueAt = { $lt: new Date() };
    filter.status ??= { $in: ACTIVE_STATUSES };
  }

  const text = q.q?.trim();
  if (text) {
    if (KEY_PATTERN.test(text)) filter.key = text.toUpperCase();
    else filter.$text = { $search: text };
  }
  return filter;
}

export async function listItems(user, q) {
  const sort = SORTS[q.sort ?? 'updated'];
  if (!sort) throw badRequest(`Unknown sort "${q.sort}"`);
  const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '25', 10) || 25, 1), 100);
  const filter = buildItemFilter(user, q);

  let query = filter;
  if (q.cursor) {
    const values = decodeCursor(q.cursor, sort);
    if (!values) throw badRequest('Invalid cursor');
    query = { $and: [filter, afterCursorFilter(values, sort, toObjectId)] };
  }

  const rows = await WorkItem.find(query)
    .select('-description -watchers -resolution')
    .sort(Object.fromEntries(sort))
    .limit(limit + 1)
    .populate(ITEM_POPULATE)
    .lean();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map((i) => serializeItem(i, user, { full: false })),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1], sort) : null,
  };
}

/**
 * "What needs my attention" overview. Each section is a bounded, indexed query
 * (count + top N), so cost does not grow with the total number of items stored.
 */
export async function dashboard(user, { sectionLimit = 8 } = {}) {
  const teamScope = visibleTeamsFilter(user);
  const leadScope = user.isAdmin ? {} : { team: { $in: teamIdsFor(user, 'lead').map(toObjectId) } };
  const now = new Date();
  const staleBefore = new Date(now.getTime() - config.staleAfterDays * 24 * 3600 * 1000);
  const byPriority = { priorityRank: -1, updatedAt: -1, _id: -1 };

  const sections = {
    assignedToMe: { filter: { assignee: user._id, status: { $in: ACTIVE_STATUSES } }, sort: byPriority },
    awaitingMyApproval: {
      filter: { ...leadScope, status: 'awaiting_approval', assignee: { $ne: user._id }, reporter: { $ne: user._id } },
      sort: { updatedAt: 1, _id: 1 },
    },
    unassignedUrgent: {
      filter: { ...teamScope, status: 'open', assignee: null, priorityRank: { $gte: PRIORITY_RANK.high } },
      sort: { priorityRank: -1, createdAt: 1, _id: 1 },
    },
    overdue: { filter: { ...teamScope, status: { $in: ACTIVE_STATUSES }, dueAt: { $lt: now } }, sort: { dueAt: 1, _id: 1 } },
    stale: {
      filter: { ...teamScope, status: { $in: ACTIVE_STATUSES }, lastActivityAt: { $lt: staleBefore } },
      sort: { lastActivityAt: 1, _id: 1 },
    },
  };

  const entries = await Promise.all(
    Object.entries(sections).map(async ([name, { filter, sort }]) => {
      const [count, rows] = await Promise.all([
        WorkItem.countDocuments(filter),
        WorkItem.find(filter).select('-description -watchers -resolution').sort(sort).limit(sectionLimit).populate(ITEM_POPULATE).lean(),
      ]);
      return [name, { count, items: rows.map((i) => serializeItem(i, user, { full: false })) }];
    }),
  );

  const counts = await WorkItem.aggregate([
    { $match: { ...teamScope, status: { $in: ACTIVE_STATUSES } } },
    { $group: { _id: { team: '$team', status: '$status' }, count: { $sum: 1 } } },
  ]);
  const teamIds = [...new Set(counts.map((c) => String(c._id.team)))];
  const teams = await Team.find({ _id: { $in: teamIds } }).lean();
  const statusByTeam = teams
    .map((t) => ({
      team: { id: String(t._id), key: t.key, name: t.name },
      counts: Object.fromEntries(counts.filter((c) => String(c._id.team) === String(t._id)).map((c) => [c._id.status, c.count])),
    }))
    .sort((a, b) => a.team.key.localeCompare(b.team.key));

  return { sections: Object.fromEntries(entries), statusByTeam, staleAfterDays: config.staleAfterDays };
}
