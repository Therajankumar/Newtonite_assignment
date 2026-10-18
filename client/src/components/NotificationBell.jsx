import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMarkNotificationsRead, useNotifications } from '../api/hooks.js';
import { timeAgo } from '../lib/format.js';

export function NotificationBell() {
  const { data } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const unread = data?.unread ?? 0;
  return (
    <div className="bell" ref={ref}>
      <button className="btn ghost" onClick={() => setOpen((o) => !o)} aria-label={`Notifications (${unread} unread)`}>
        🔔{unread > 0 && <span className="count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="dropdown">
          <div className="dropdown-head">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button className="link" onClick={() => markRead.mutate(null)}>
                Mark all read
              </button>
            )}
          </div>
          {!data?.notifications.length && <p className="empty">You're all caught up.</p>}
          <ul>
            {data?.notifications.map((n) => (
              <li key={n.id} className={n.read ? '' : 'unread'}>
                <button
                  className="notif"
                  onClick={() => {
                    if (!n.read) markRead.mutate([n.id]);
                    setOpen(false);
                    if (n.item) navigate(`/items/${n.item.id}`);
                  }}
                >
                  <span>{n.message}</span>
                  <span className="muted small">{timeAgo(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
