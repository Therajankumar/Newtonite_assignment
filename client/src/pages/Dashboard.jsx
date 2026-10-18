import { Link } from 'react-router-dom';
import { useDashboard } from '../api/hooks.js';
import { ItemTable } from '../components/ItemTable.jsx';
import { STATUS_LABELS } from '../lib/format.js';

const SECTIONS = [
  { key: 'assignedToMe', title: 'Assigned to me', link: '/items?assignee=me&status=active&sort=priority', empty: 'Nothing assigned to you.' },
  { key: 'awaitingMyApproval', title: 'Awaiting my approval', link: '/items?status=awaiting_approval', empty: 'No approvals waiting on you.' },
  { key: 'unassignedUrgent', title: 'Unowned high-priority work', link: '/items?assignee=none&status=open&priority=urgent,high&sort=priority', empty: 'All high-priority work has an owner.' },
  { key: 'overdue', title: 'Overdue', link: '/items?overdue=true&sort=priority', empty: 'Nothing overdue.' },
  { key: 'stale', title: 'Going stale', empty: 'No forgotten work.' },
];

const ACTIVE = ['open', 'in_progress', 'blocked', 'awaiting_approval'];

export function Dashboard() {
  const { data, isLoading, error } = useDashboard();
  if (isLoading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error.message}</p>;

  return (
    <div className="dashboard">
      <h1>What needs attention</h1>
      <div className="sections">
        {SECTIONS.map((s) => {
          const section = data.sections[s.key];
          return (
            <section key={s.key} className={`card section ${section.count ? '' : 'quiet'}`}>
              <header>
                <h2>
                  {s.title} <span className="pill">{section.count}</span>
                </h2>
                {s.link && section.count > 0 && <Link to={s.link}>View all →</Link>}
              </header>
              {s.key === 'stale' && <p className="muted small">Active items with no activity for {data.staleAfterDays}+ days.</p>}
              <ItemTable items={section.items} compact emptyText={s.empty} />
            </section>
          );
        })}
      </div>

      <section className="card">
        <h2>Active work by team</h2>
        <table className="items compact">
          <thead>
            <tr>
              <th>Team</th>
              {ACTIVE.map((s) => <th key={s}>{STATUS_LABELS[s]}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.statusByTeam.map((row) => (
              <tr key={row.team.id}>
                <td><Link to={`/items?team=${row.team.id}&status=active`}>{row.team.name}</Link></td>
                {ACTIVE.map((s) => (
                  <td key={s}>
                    {row.counts[s] ? <Link to={`/items?team=${row.team.id}&status=${s}`}>{row.counts[s]}</Link> : <span className="muted">0</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
