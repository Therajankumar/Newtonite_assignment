import { allowedActions } from '../domain/permissions.js';

const userRef = (u) => (u && u._id ? { id: String(u._id), name: u.name, email: u.email } : u ? { id: String(u) } : null);
const teamRef = (t) => (t && t._id ? { id: String(t._id), key: t.key, name: t.name } : { id: String(t) });

export const ITEM_POPULATE = [
  { path: 'assignee', select: 'name email' },
  { path: 'reporter', select: 'name email' },
  { path: 'team', select: 'key name' },
  { path: 'approval.by', select: 'name email' },
];

export function serializeItem(item, user, { full = true } = {}) {
  const out = {
    id: String(item._id),
    key: item.key,
    team: teamRef(item.team),
    title: item.title,
    type: item.type,
    priority: item.priority,
    status: item.status,
    assignee: userRef(item.assignee),
    reporter: userRef(item.reporter),
    nextAction: item.nextAction,
    dueAt: item.dueAt,
    requiresApproval: item.requiresApproval,
    approval: item.approval ? { ...item.approval, by: userRef(item.approval.by) } : null,
    version: item.version,
    lastActivityAt: item.lastActivityAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (full) {
    out.description = item.description;
    out.resolution = item.resolution;
    out.watcherCount = item.watchers?.length ?? 0;
  }
  if (user) out.allowedActions = allowedActions(user, item);
  return out;
}

export function serializeActivity(a) {
  return {
    id: String(a._id),
    type: a.type,
    actor: userRef(a.actor),
    data: a.data,
    itemVersion: a.itemVersion,
    createdAt: a.createdAt,
  };
}
