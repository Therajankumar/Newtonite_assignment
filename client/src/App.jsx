import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import { Layout } from './components/Layout.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { ItemDetail } from './pages/ItemDetail.jsx';
import { ItemsList } from './pages/ItemsList.jsx';
import { Login } from './pages/Login.jsx';
import { NewItem } from './pages/NewItem.jsx';

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <p className="muted center">Loading…</p>;
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="items" element={<ItemsList />} />
        <Route path="items/new" element={<NewItem />} />
        <Route path="items/:id" element={<ItemDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
