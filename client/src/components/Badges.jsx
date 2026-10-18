import { STATUS_LABELS, humanize, isOverdue } from '../lib/format.js';

export const StatusBadge = ({ status }) => <span className={`badge status-${status}`}>{STATUS_LABELS[status] ?? status}</span>;

export const PriorityBadge = ({ priority }) => <span className={`badge priority-${priority}`}>{humanize(priority)}</span>;

export const DueLabel = ({ item }) =>
  item.dueAt ? (
    <span className={isOverdue(item) ? 'overdue' : 'muted'}>
      {isOverdue(item) ? 'Overdue · ' : 'Due '}
      {new Date(item.dueAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
    </span>
  ) : null;

export const Person = ({ user, empty = 'Unassigned' }) =>
  user ? <span className="person">{user.name}</span> : <span className="muted">{empty}</span>;
