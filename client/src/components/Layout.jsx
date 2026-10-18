import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { useLiveUpdates } from '../lib/useLiveUpdates.js';
import { NotificationBell } from './NotificationBell.jsx';

export function Layout() {
  const { user, logout } = useAuth();
  const live = useLiveUpdates(!!user);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Newtonite Ops</div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/items">Work items</NavLink>
          <NavLink to="/items/new">+ New</NavLink>
        </nav>
        <div className="spacer" />
        <span className={`live ${live ? 'on' : ''}`} title={live ? 'Live updates connected' : 'Live updates disconnected - data refreshes periodically'}>
          ● {live ? 'Live' : 'Offline'}
        </span>
        <NotificationBell />
        <div className="me">
          <span>{user.name}</span>
          <span className="muted small">
            {user.isAdmin ? 'Admin' : user.teams.map((t) => `${t.key} ${t.role}`).join(' · ')}
          </span>
        </div>
        <button className="btn ghost" onClick={logout}>Log out</button>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
