import { ACTIVE_STATUSES, TERMINAL_STATUSES } from '../models/WorkItem.js';
import { sameId } from '../lib/ids.js';
import { TRANSITIONS, TRANSITION_NAMES, transitionStateError } from './workflow.js';

/**
 * Authorization model
 * -------------------
 * Users hold a role per team (viewer < member < lead). Org admins act as leads everywhere.
 * Permissions are decided per item from the caller's role in the item's team plus their
 * relationship to the item (assignee / reporter). This module is pure: it is used both to
 * enforce permissions in the service layer and to tell the UI which actions to offer.
 */

const RANK = { viewer: 1, member: 2, lead: 3 };

export function roleIn(user, teamId) {
  if (user.isAdmin) return 'lead';
  return user.roles?.get(String(teamId?._id ?? teamId)) ?? null;
}

export function atLeast(role, min) {
  return role != null && RANK[role] >= RANK[min];
}

export function teamIdsFor(user, minRole = 'viewer') {
  return [...(user.roles?.entries() ?? [])].filter(([, r]) => atLeast(r, minRole)).map(([t]) => t);
}

const relationship = (user, item) => ({
  isAssignee: sameId(item.assignee, user._id),
  isReporter: sameId(item.reporter, user._id),
});

// Who may perform a transition. Each rule returns null when allowed, or a reason.
const ACTOR_RULES = {
  owner: (role, rel) =>
    rel.isAssignee && atLeast(role, 'member') ? null : atLeast(role, 'lead') ? null : 'Only the assignee or a team lead can do this',
  approver: (role, rel) => {
    if (!atLeast(role, 'lead')) return 'Only a team lead can approve or reject';
    // Separation of duties: nobody approves work they requested or are doing themselves.
    if (rel.isAssignee || rel.isReporter) return 'You cannot approve an item you reported or are assigned to';
    return null;
  },
  participant: (role, rel) =>
    atLeast(role, 'lead') || (atLeast(role, 'member') && (rel.isAssignee || rel.isReporter))
      ? null
      : 'Only the reporter, assignee or a team lead can do this',
  lead: (role) => (atLeast(role, 'lead') ? null : 'Only a team lead can do this'),
  canceller: (role, rel, item) =>
    atLeast(role, 'lead') || (atLeast(role, 'member') && rel.isReporter && item.status === 'open')
      ? null
      : 'Only a team lead (or the reporter, while the item is open) can cancel',
};

/**
 * Decide whether `user` may perform `action` on `item` right now.
 * Returns null if allowed, otherwise { kind: 'forbidden' | 'state', message }.
 * 'forbidden' means the user lacks permission; 'state' means the action is not valid
 * in the item's current state (the API maps these to 403 and 409 respectively).
 */
export function denyReason(user, item, action) {
  const role = roleIn(user, item.team);
  if (!role) return { kind: 'forbidden', message: 'Not a member of this team' };
  const rel = relationship(user, item);
  const forbidden = (message) => ({ kind: 'forbidden', message });
  const state = (message) => ({ kind: 'state', message });

  switch (action) {
    case 'view':
    case 'comment':
      return null;
    case 'edit':
      if (!(atLeast(role, 'lead') || (atLeast(role, 'member') && (rel.isAssignee || rel.isReporter))))
        return forbidden('Only the reporter, assignee or a team lead can edit this item');
      if (TERMINAL_STATUSES.includes(item.status)) return state(`Item is ${item.status}`);
      return null;
    case 'claim':
      if (!atLeast(role, 'member')) return forbidden('Viewers cannot take ownership of work');
      if (item.assignee) return state('Item is already assigned');
      if (item.status !== 'open') return state(`Cannot claim an item that is ${item.status.replace('_', ' ')}`);
      return null;
    case 'release':
      if (!rel.isAssignee) return forbidden('Only the assignee can release an item');
      if (!['in_progress', 'blocked'].includes(item.status)) return state(`Cannot release an item that is ${item.status.replace('_', ' ')}`);
      return null;
    case 'assign':
      if (!atLeast(role, 'lead')) return forbidden('Only a team lead can assign work to others');
      if (!ACTIVE_STATUSES.includes(item.status)) return state(`Cannot reassign an item that is ${item.status}`);
      return null;
    default: {
      const t = TRANSITIONS[action];
      if (!t) return forbidden(`Unknown action "${action}"`);
      const actorErr = ACTOR_RULES[t.actor](role, rel, item);
      if (actorErr) return forbidden(actorErr);
      const stateErr = transitionStateError(item, action);
      return stateErr ? state(stateErr) : null;
    }
  }
}

export const ITEM_ACTIONS = ['comment', 'edit', 'claim', 'release', 'assign', ...TRANSITION_NAMES];

/** Actions the UI should offer. The server re-checks every one of them on submission. */
export function allowedActions(user, item) {
  return ITEM_ACTIONS.filter((a) => denyReason(user, item, a) === null);
}
