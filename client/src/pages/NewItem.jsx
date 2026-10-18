import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { newIdempotencyKey } from '../api/client.js';
import { useCreateItem, useTeams } from '../api/hooks.js';
import { PRIORITIES, TYPES, humanize } from '../lib/format.js';

export function NewItem() {
  const { data: teams } = useTeams();
  const writable = teams?.filter((t) => t.role !== 'viewer') ?? [];
  const create = useCreateItem();
  const navigate = useNavigate();
  const [form, setForm] = useState({ team: '', title: '', description: '', type: 'task', priority: 'medium', dueAt: '', nextAction: '', requiresApproval: false });
  // One key per submission *intent*: a double-click, or pressing Submit again after a timeout,
  // reuses it so the server creates at most one item. Editing the form after a rejected
  // submission starts a new intent.
  const key = useRef(newIdempotencyKey());
  const update = (k, v) => {
    if (create.isError) key.current = newIdempotencyKey();
    setForm((f) => ({ ...f, [k]: v }));
  };

  const submit = (e) => {
    e.preventDefault();
    if (create.isPending) return;
    const input = { ...form, team: form.team || writable[0]?.id, dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null };
    if (!input.description) delete input.description;
    create.mutate(
      { input, idempotencyKey: key.current },
      {
        onSuccess: (item) => navigate(`/items/${item.id}`, { replace: true }),
        onError: (err) => {
          if (err.isClientError) key.current = newIdempotencyKey();
        },
      },
    );
  };

  if (teams && !writable.length) return <p className="error">You are a viewer on all your teams and cannot create work items.</p>;

  return (
    <form className="card form narrow" onSubmit={submit}>
      <h1>New work item</h1>
      <label>
        Team
        <select value={form.team || writable[0]?.id || ''} onChange={(e) => update('team', e.target.value)}>
          {writable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label>
        Title
        <input value={form.title} onChange={(e) => update('title', e.target.value)} required minLength={3} maxLength={200} placeholder="What needs to happen?" />
      </label>
      <label>
        Description
        <textarea rows={6} value={form.description} onChange={(e) => update('description', e.target.value)} placeholder="Why does this exist? Context, links, customer details…" />
      </label>
      <div className="row">
        <label>
          Type
          <select value={form.type} onChange={(e) => update('type', e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
          </select>
        </label>
        <label>
          Priority
          <select value={form.priority} onChange={(e) => update('priority', e.target.value)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
          </select>
        </label>
        <label>
          Due date
          <input type="date" value={form.dueAt} onChange={(e) => update('dueAt', e.target.value)} />
        </label>
      </div>
      <label>
        Next action
        <input value={form.nextAction} onChange={(e) => update('nextAction', e.target.value)} placeholder="e.g. Confirm amount with finance" maxLength={500} />
      </label>
      <label className="check">
        <input type="checkbox" checked={form.requiresApproval} onChange={(e) => update('requiresApproval', e.target.checked)} />
        Requires approval from a team lead before it can be resolved
      </label>
      {create.error && <p className="error">{create.error.message}</p>}
      <div className="actions">
        <button className="btn primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</button>
      </div>
    </form>
  );
}
