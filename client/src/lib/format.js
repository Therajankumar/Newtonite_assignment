export const STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  awaiting_approval: 'Awaiting approval',
  resolved: 'Resolved',
  closed: 'Closed',
  cancelled: 'Cancelled',
};
export const STATUSES = Object.keys(STATUS_LABELS);
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
export const TYPES = ['incident', 'customer_issue', 'engineering', 'payment', 'compliance', 'task'];
export const humanize = (s) =>
  s ? s.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '';

export function timeAgo(date) {
  if (!date) return '';
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const [n, unit] =
    a < 60 ? [a, 's'] : a < 3600 ? [Math.round(a / 60), 'm'] : a < 86400 ? [Math.round(a / 3600), 'h'] : [Math.round(a / 86400), 'd'];
  if (a < 30) return 'just now';
  return future ? `in ${n}${unit}` : `${n}${unit} ago`;
}

export const formatDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const formatDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const isOverdue = (item) => item.dueAt && new Date(item.dueAt) < new Date() && ['open', 'in_progress', 'blocked', 'awaiting_approval'].includes(item.status);
