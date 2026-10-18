import { Link } from 'react-router-dom';
import { timeAgo, humanize } from '../lib/format.js';
import { DueLabel, Person, PriorityBadge, StatusBadge } from './Badges.jsx';

export function ItemTable({ items, compact = false, emptyText = 'Nothing here.' }) {
  if (!items?.length) return <p className="empty">{emptyText}</p>;
  return (
    <table className={`items ${compact ? 'compact' : ''}`}>
      <thead>
        <tr>
          <th>Key</th>
          <th>Title</th>
          <th>Priority</th>
          <th>Status</th>
          <th>Owner</th>
          {!compact && <th>Type</th>}
          {!compact && <th>Due</th>}
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id}>
            <td className="key">
              <Link to={`/items/${i.id}`}>{i.key}</Link>
            </td>
            <td className="title">
              <Link to={`/items/${i.id}`}>{i.title}</Link>
              {i.requiresApproval && <span className="tag" title="Requires approval">approval</span>}
            </td>
            <td><PriorityBadge priority={i.priority} /></td>
            <td><StatusBadge status={i.status} /></td>
            <td><Person user={i.assignee} /></td>
            {!compact && <td className="muted">{humanize(i.type)}</td>}
            {!compact && <td><DueLabel item={i} /></td>}
            <td className="muted nowrap" title={new Date(i.updatedAt).toLocaleString()}>{timeAgo(i.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
