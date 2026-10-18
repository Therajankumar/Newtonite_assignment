import { ACTIVE_STATUSES } from '../models/WorkItem.js';

/**
 * The work item state machine. Every status change goes through one of these named
 * transitions; there is no generic "set status" operation, so workflow rules cannot be
 * bypassed by a crafted request.
 *
 *   open --claim/assign--> in_progress <--> blocked
 *   in_progress --request_approval--> awaiting_approval --approve/reject--> in_progress
 *   in_progress --resolve--> resolved --close--> closed
 *   resolved --reopen--> in_progress | open
 *   any active status --cancel--> cancelled
 *
 * `actor` names the rule in permissions.js deciding who may perform the transition.
 * `requires` names a free-text field the request must include.
 */
export const TRANSITIONS = {
  block: {
    label: 'Mark blocked',
    from: ['in_progress'],
    to: () => 'blocked',
    actor: 'owner',
    requires: 'note',
  },
  unblock: {
    label: 'Unblock',
    from: ['blocked'],
    to: () => 'in_progress',
    actor: 'owner',
  },
  request_approval: {
    label: 'Request approval',
    from: ['in_progress'],
    to: () => 'awaiting_approval',
    actor: 'owner',
    guard: (item) => {
      if (!item.requiresApproval) return 'This item does not require approval';
      if (item.approval?.state === 'approved') return 'This item is already approved';
      return null;
    },
    apply: () => ({ 'approval.state': 'pending', 'approval.by': null, 'approval.at': null, 'approval.note': '' }),
  },
  approve: {
    label: 'Approve',
    from: ['awaiting_approval'],
    to: () => 'in_progress',
    actor: 'approver',
    apply: (item, actorId, input) => ({
      'approval.state': 'approved',
      'approval.by': actorId,
      'approval.at': new Date(),
      'approval.note': input.note || '',
    }),
  },
  reject: {
    label: 'Reject',
    from: ['awaiting_approval'],
    to: () => 'in_progress',
    actor: 'approver',
    requires: 'note',
    apply: (item, actorId, input) => ({
      'approval.state': 'rejected',
      'approval.by': actorId,
      'approval.at': new Date(),
      'approval.note': input.note,
    }),
  },
  resolve: {
    label: 'Resolve',
    from: ['in_progress'],
    to: () => 'resolved',
    actor: 'owner',
    requires: 'resolution',
    guard: (item) =>
      item.requiresApproval && item.approval?.state !== 'approved'
        ? 'This item requires approval before it can be resolved'
        : null,
    apply: (item, actorId, input) => ({ resolution: input.resolution }),
  },
  reopen: {
    label: 'Reopen',
    from: ['resolved'],
    to: (item) => (item.assignee ? 'in_progress' : 'open'),
    actor: 'participant',
    requires: 'note',
    // Work done after reopening has not been approved, so approval must be obtained again.
    apply: (item) => (item.requiresApproval ? { 'approval.state': 'none', 'approval.by': null, 'approval.at': null } : {}),
  },
  close: {
    label: 'Close',
    from: ['resolved'],
    to: () => 'closed',
    actor: 'lead',
  },
  cancel: {
    label: 'Cancel',
    from: ACTIVE_STATUSES,
    to: () => 'cancelled',
    actor: 'canceller',
    requires: 'note',
  },
};

export const TRANSITION_NAMES = Object.keys(TRANSITIONS);

/** Returns an error message if the transition cannot be applied to the item's current state, else null. */
export function transitionStateError(item, name) {
  const t = TRANSITIONS[name];
  if (!t) return `Unknown transition "${name}"`;
  if (!t.from.includes(item.status)) return `Cannot ${name.replace('_', ' ')} an item that is ${item.status.replace('_', ' ')}`;
  return t.guard ? t.guard(item) : null;
}
