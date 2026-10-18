import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useItems, useTeams } from '../api/hooks.js';
import { ItemTable } from '../components/ItemTable.jsx';
import { PRIORITIES, STATUSES, STATUS_LABELS, TYPES, humanize } from '../lib/format.js';

const FILTER_KEYS = ['q', 'team', 'status', 'priority', 'type', 'assignee', 'overdue', 'sort'];

/** Filters live in the URL so views can be bookmarked and shared. */
export function ItemsList() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])), [params]);
  const { data: teams } = useTeams();
  const [search, setSearch] = useState(filters.q);

  const set = (key, value) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };

  // Debounce free-text search so we query once the user pauses typing.
  useEffect(() => {
    const t = setTimeout(() => search !== filters.q && set('q', search.trim()), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query = useItems(filters);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      <h1>Work items</h1>
      <div className="filters card">
        <input className="search" placeholder="Search title, description or key (e.g. PAY-12)…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={filters.team} onChange={(e) => set('team', e.target.value)}>
          <option value="">All my teams</option>
          {teams?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Any status</option>
          <option value="active">Active (not done)</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <select value={filters.priority} onChange={(e) => set('priority', e.target.value)}>
          <option value="">Any priority</option>
          <option value="urgent,high">High or urgent</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
        </select>
        <select value={filters.type} onChange={(e) => set('type', e.target.value)}>
          <option value="">Any type</option>
          {TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
        </select>
        <select value={filters.assignee} onChange={(e) => set('assignee', e.target.value)}>
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={filters.overdue === 'true'} onChange={(e) => set('overdue', e.target.checked ? 'true' : '')} />
          Overdue
        </label>
        <select value={filters.sort || 'updated'} onChange={(e) => set('sort', e.target.value === 'updated' ? '' : e.target.value)}>
          <option value="updated">Recently updated</option>
          <option value="priority">Highest priority</option>
          <option value="created">Newest</option>
        </select>
        {FILTER_KEYS.some((k) => filters[k]) && (
          <button className="link" onClick={() => { setSearch(''); setParams({}, { replace: true }); }}>Clear</button>
        )}
      </div>

      {query.error && <p className="error">{query.error.message}</p>}
      <div className={`card ${query.isFetching && !query.isFetchingNextPage ? 'refreshing' : ''}`}>
        {query.isLoading ? <p className="muted">Loading…</p> : <ItemTable items={items} emptyText="No work items match these filters." />}
        {query.hasNextPage && (
          <div className="more">
            <button className="btn" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
        {!query.isLoading && items.length > 0 && <p className="muted small">Showing {items.length}{query.hasNextPage ? '+' : ''} items</p>}
      </div>
    </div>
  );
}
