import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { newIdempotencyKey } from '../api/client.js';
import { useActivity, useAddComment, useItem, useItemAction, useMembers } from '../api/hooks.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { DueLabel, Person, PriorityBadge, StatusBadge } from '../components/Badges.jsx';
import { useToast } from '../components/Toasts.jsx';
import { PRIORITIES, STATUS_LABELS, TYPES, formatDate, formatDateTime, humanize, timeAgo } from '../lib/format.js';

// Display metadata only - the server decides which transitions are allowed and validates input.
const TRANSITIONS = {
  request_approval: { label: 'Request approval' },
  approve: { label: 'Approve', note: 'Approval note (optional)', optional: true },
  reject: { label: 'Reject', note: 'Why is this rejected?' },
  block: { label: 'Mark blocked', note: 'What is it blocked on?' },
  unblock: { label: 'Unblock' },
  resolve: { label: 'Resolve', field: 'resolution', note: 'How was this resolved?' },
  reopen: { label: 'Reopen', note: 'Why reopen?' },
  close: { label: 'Close' },
  cancel: { label: 'Cancel item', note: 'Why cancel?', danger: true },
};

const EDIT_FIELDS = ['title', 'description', 'type', 'priority', 'dueAt', 'nextAction', 'requiresApproval'];
const toFormValue = (item, f) => (f === 'dueAt' ? (item.dueAt ? item.dueAt.slice(0, 10) : '') : item[f] ?? '');

export function ItemDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const { data: item, isLoading, error } = useItem(id);
  const action = useItemAction(id, user);
  const [prompt, setPrompt] = useState(null); // transition awaiting a note
  const [editing, setEditing] = useState(false);

  if (isLoading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error.status === 404 ? 'This item does not exist or you do not have access to it.' : error.message}</p>;

  const can = (a) => item.allowedActions?.includes(a);
  const run = (vars, success) =>
    action.mutate(vars, {
      onSuccess: () => success && toast(success, 'success'),
      onError: (err) => {
        if (err.code === 'VERSION_CONFLICT') toast('This item changed since you loaded it. Review the latest state and try again.', 'warn');
        else toast(err.message, 'error');
      },
    });
  const doTransition = (name, input = {}) => run({ kind: 'transition', name, body: { version: item.version, ...input } }, `${TRANSITIONS[name].label}: done`);

  return (
    <div className="detail">
      <div className="crumbs">
        <Link to="/items">Work items</Link> / <span>{item.team.name}</span> / <strong>{item.key}</strong>
      </div>
      <div className="detail-grid">
        <div className="main">
          <div className="card">
            <div className="title-row">
              <h1>{item.title}</h1>
              <div className="badges">
                <PriorityBadge priority={item.priority} />
                <StatusBadge status={item.status} />
              </div>
            </div>

            <div className="action-bar">
              {can('claim') && <button className="btn primary" disabled={action.isPending} onClick={() => run({ kind: 'claim' }, 'You now own this item')}>Take ownership</button>}
              {item._optimistic && <span className="muted">Claiming…</span>}
              {Object.keys(TRANSITIONS).filter(can).map((name) => (
                <button
                  key={name}
                  className={`btn ${TRANSITIONS[name].danger ? 'danger' : ''}`}
                  disabled={action.isPending}
                  onClick={() => (TRANSITIONS[name].note ? setPrompt(name) : doTransition(name))}
                >
                  {TRANSITIONS[name].label}
                </button>
              ))}
              {can('release') && <button className="btn" disabled={action.isPending} onClick={() => run({ kind: 'release' }, 'Released back to the queue')}>Release</button>}
              {can('edit') && !editing && <button className="btn ghost" onClick={() => setEditing(true)}>Edit</button>}
            </div>

            {prompt && (
              <TransitionPrompt
                name={prompt}
                pending={action.isPending}
                onCancel={() => setPrompt(null)}
                onSubmit={(text) => {
                  const meta = TRANSITIONS[prompt];
                  doTransition(prompt, text ? { [meta.field ?? 'note']: text } : {});
                  setPrompt(null);
                }}
              />
            )}

            {item.status === 'awaiting_approval' && (
              <div className="notice">
                Waiting for a team lead to approve.{' '}
                {!can('approve') && item.allowedActions && 'You cannot approve this item (leads cannot approve work they reported or are doing).'}
              </div>
            )}
            {item.approval?.state === 'rejected' && (
              <div className="notice warn">Approval rejected by {item.approval.by?.name}: “{item.approval.note}”</div>
            )}

            {editing ? (
              <EditForm item={item} action={action} onDone={() => setEditing(false)} />
            ) : (
              <>
                {item.nextAction && (
                  <div className="next-action"><strong>Next action:</strong> {item.nextAction}</div>
                )}
                <div className="description">{item.description || <span className="muted">No description.</span>}</div>
                {item.resolution && (
                  <div className="resolution"><strong>Resolution:</strong> {item.resolution}</div>
                )}
              </>
            )}
          </div>
          <Timeline itemId={item.id} />
        </div>

        <aside className="card side">
          <dl>
            <dt>Owner</dt>
            <dd>
              <Person user={item.assignee} />
              {can('assign') && <AssignControl item={item} run={run} />}
            </dd>
            <dt>Status</dt>
            <dd><StatusBadge status={item.status} /></dd>
            <dt>Priority</dt>
            <dd><PriorityBadge priority={item.priority} /></dd>
            <dt>Type</dt>
            <dd>{humanize(item.type)}</dd>
            <dt>Team</dt>
            <dd>{item.team.name}</dd>
            <dt>Reporter</dt>
            <dd><Person user={item.reporter} /></dd>
            <dt>Due</dt>
            <dd>{item.dueAt ? <><DueLabel item={item} /> <span className="muted small">({formatDate(item.dueAt)})</span></> : '—'}</dd>
            <dt>Approval</dt>
            <dd>
              {item.requiresApproval
                ? `${humanize(item.approval?.state === 'none' ? 'required' : item.approval?.state)}${item.approval?.by ? ` by ${item.approval.by.name}` : ''}`
                : 'Not required'}
            </dd>
            <dt>Created</dt>
            <dd title={formatDateTime(item.createdAt)}>{timeAgo(item.createdAt)}</dd>
            <dt>Last activity</dt>
            <dd title={formatDateTime(item.lastActivityAt)}>{timeAgo(item.lastActivityAt)}</dd>
            <dt>Version</dt>
            <dd className="muted">v{item.version} · {item.watcherCount} watching</dd>
          </dl>
        </aside>
      </div>
    </div>
  );
}

function TransitionPrompt({ name, pending, onCancel, onSubmit }) {
  const meta = TRANSITIONS[name];
  const [text, setText] = useState('');
  return (
    <form className="prompt" onSubmit={(e) => { e.preventDefault(); onSubmit(text.trim()); }}>
      <label>
        {meta.note}
        <textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} required={!meta.optional} />
      </label>
      <div className="actions">
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
        <button className={`btn ${meta.danger ? 'danger' : 'primary'}`} disabled={pending}>{meta.label}</button>
      </div>
    </form>
  );
}

function AssignControl({ item, run }) {
  const { data: members } = useMembers(item.team.id);
  const assignable = members?.filter((m) => m.role !== 'viewer') ?? [];
  return (
    <select
      className="assign"
      value={item.assignee?.id ?? ''}
      onChange={(e) => run({ kind: 'assign', body: { version: item.version, assigneeId: e.target.value || null } }, 'Owner updated')}
    >
      <option value="" disabled={item.status === 'awaiting_approval'}>— Unassigned —</option>
      {assignable.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
    </select>
  );
}

/**
 * Edit form with explicit handling of concurrent edits. The form remembers the version it was
 * opened from. If someone else saves meanwhile we warn immediately (via live updates), and
 * if we save anyway the server rejects it with the current state, and we show a field-by-field
 * comparison so the user decides what wins - nothing is silently overwritten.
 */
function EditForm({ item, action, onDone }) {
  const toast = useToast();
  const [baseVersion, setBaseVersion] = useState(item.version);
  const [form, setForm] = useState(() => Object.fromEntries(EDIT_FIELDS.map((f) => [f, toFormValue(item, f)])));
  const [conflict, setConflict] = useState(null);
  const original = useRef(Object.fromEntries(EDIT_FIELDS.map((f) => [f, toFormValue(item, f)])));

  const changed = EDIT_FIELDS.filter((f) => form[f] !== original.current[f]);
  const patchBody = (version) => ({
    version,
    ...Object.fromEntries(changed.map((f) => [f, f === 'dueAt' ? (form.dueAt ? new Date(form.dueAt).toISOString() : null) : form[f]])),
  });

  const save = (version) => {
    if (!changed.length) return onDone();
    action.mutate(
      { kind: 'edit', body: patchBody(version) },
      {
        onSuccess: () => {
          toast('Saved', 'success');
          onDone();
        },
        onError: (err) => {
          if (err.code === 'VERSION_CONFLICT' && err.details?.current) setConflict(err.details.current);
          else toast(err.message, 'error');
        },
      },
    );
  };

  const set = (f, v) => setForm((x) => ({ ...x, [f]: v }));
  const staleWhileEditing = item.version > baseVersion && !conflict;

  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); save(baseVersion); }}>
      {staleWhileEditing && (
        <div className="notice warn">Someone else updated this item while you were editing. Saving will show you what changed.</div>
      )}
      {conflict && (
        <div className="conflict">
          <strong>Your changes conflict with an update made by someone else.</strong>
          <table>
            <thead><tr><th>Field</th><th>Your value</th><th>Current value</th></tr></thead>
            <tbody>
              {changed.map((f) => (
                <tr key={f} className={toFormValue(conflict, f) !== form[f] ? 'diff' : ''}>
                  <td>{humanize(f)}</td>
                  <td>{String(form[f]) || '—'}</td>
                  <td>{String(toFormValue(conflict, f)) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions">
            <button type="button" className="btn" onClick={() => { setConflict(null); onDone(); }}>Discard mine, keep current</button>
            <button type="button" className="btn primary" onClick={() => { setBaseVersion(conflict.version); setConflict(null); save(conflict.version); }}>
              Apply my changes on top
            </button>
          </div>
        </div>
      )}
      <label>Title<input value={form.title} onChange={(e) => set('title', e.target.value)} minLength={3} maxLength={200} required /></label>
      <label>Description<textarea rows={6} value={form.description} onChange={(e) => set('description', e.target.value)} /></label>
      <div className="row">
        <label>Type<select value={form.type} onChange={(e) => set('type', e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</select></label>
        <label>Priority<select value={form.priority} onChange={(e) => set('priority', e.target.value)}>{PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</select></label>
        <label>Due<input type="date" value={form.dueAt} onChange={(e) => set('dueAt', e.target.value)} /></label>
      </div>
      <label>Next action<input value={form.nextAction} onChange={(e) => set('nextAction', e.target.value)} maxLength={500} /></label>
      <label className="check">
        <input type="checkbox" checked={!!form.requiresApproval} onChange={(e) => set('requiresApproval', e.target.checked)} /> Requires approval
      </label>
      {!conflict && (
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onDone}>Cancel</button>
          <button className="btn primary" disabled={action.isPending || !changed.length}>{action.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </form>
  );
}

function describeActivity(a) {
  const d = a.data ?? {};
  switch (a.type) {
    case 'created':
      return 'created this item';
    case 'claimed':
      return 'took ownership';
    case 'released':
      return 'released it back to the queue';
    case 'assigned':
      return d.to ? `assigned it to ${d.to.name}${d.from ? ` (was ${d.from.name})` : ''}` : `unassigned ${d.from?.name ?? ''}`;
    case 'updated':
      return `changed ${Object.entries(d.changes ?? {})
        .map(([f, c]) => (f === 'description' ? 'the description' : `${humanize(f).toLowerCase()} from “${fmt(f, c.from)}” to “${fmt(f, c.to)}”`))
        .join(', ')}`;
    case 'transitioned':
      return `${TRANSITIONS[d.transition]?.label.toLowerCase() ?? d.transition}: ${STATUS_LABELS[d.from]} → ${STATUS_LABELS[d.to]}`;
    default:
      return a.type;
  }
}
const fmt = (f, v) => (v == null || v === '' ? 'none' : f === 'dueAt' ? formatDate(v) : String(v));

function Timeline({ itemId }) {
  const activity = useActivity(itemId);
  const addComment = useAddComment(itemId);
  const toast = useToast();
  const [body, setBody] = useState('');
  const key = useRef(newIdempotencyKey());

  useEffect(() => {
    key.current = newIdempotencyKey();
  }, [itemId]);

  const submit = (e) => {
    e.preventDefault();
    if (!body.trim() || addComment.isPending) return;
    addComment.mutate(
      { body: body.trim(), idempotencyKey: key.current },
      {
        onSuccess: () => {
          setBody('');
          key.current = newIdempotencyKey();
        },
        onError: (err) => {
          // Keep the same key after a network failure, so pressing Send again cannot double-post.
          if (err.isClientError) key.current = newIdempotencyKey();
          toast(err.message, 'error');
        },
      },
    );
  };

  const entries = activity.data?.pages.flatMap((p) => p.activities) ?? [];
  return (
    <div className="card timeline">
      <h2>Activity</h2>
      <form className="comment-form" onSubmit={submit}>
        <textarea rows={2} placeholder="Add a comment…" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="btn primary" disabled={!body.trim() || addComment.isPending}>{addComment.isPending ? 'Posting…' : 'Comment'}</button>
      </form>
      <ul>
        {entries.map((a) => (
          <li key={a.id} className={`entry ${a.type}`}>
            <div className="entry-head">
              <strong>{a.actor?.name ?? 'Someone'}</strong>{' '}
              {a.type !== 'commented' && <span>{describeActivity(a)}</span>}
              <span className="muted small" title={formatDateTime(a.createdAt)}> · {timeAgo(a.createdAt)}</span>
            </div>
            {a.type === 'commented' && <div className="comment">{a.data.body}</div>}
            {a.data?.note && a.type === 'transitioned' && <div className="comment">{a.data.note}</div>}
            {a.data?.resolution && <div className="comment">{a.data.resolution}</div>}
          </li>
        ))}
      </ul>
      {activity.hasNextPage && (
        <button className="btn ghost" onClick={() => activity.fetchNextPage()} disabled={activity.isFetchingNextPage}>
          {activity.isFetchingNextPage ? 'Loading…' : 'Show older activity'}
        </button>
      )}
    </div>
  );
}
