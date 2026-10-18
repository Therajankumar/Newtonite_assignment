import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [demoUsers, setDemoUsers] = useState([]);

  useEffect(() => {
    api('/auth/demo-users').then((r) => setDemoUsers(r.users)).catch(() => {});
  }, []);

  const submit = async (e, creds = { email, password }) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(creds.email, creds.password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Newtonite Ops</h1>
        <p className="muted">Sign in to coordinate operational work.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      {demoUsers.length > 0 && (
        <div className="card demo">
          <h3>Demo accounts</h3>
          <p className="muted small">Password for all: <code>password123</code>. Try two browsers as different users.</p>
          <ul>
            {demoUsers.map((u) => (
              <li key={u.email}>
                <button className="link" disabled={busy} onClick={() => submit(null, { email: u.email, password: 'password123' })}>
                  {u.name}
                </button>
                <span className="muted small">{u.isAdmin ? 'org admin' : u.roles.join(', ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
