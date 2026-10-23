import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';

import { supabase } from './lib/supabase';
import { storageMode } from './lib/db';
import { idbAvailable } from './lib/store/idb';
import Auth from './components/Auth';
import Dashboard from './pages/Dashboard';
import Scan from './pages/Scan';
import Inventory from './pages/Inventory';
import ItemDetail from './pages/ItemDetail';
import SettingsPage from './pages/Settings';
import Sales from './pages/Sales';
import PriceResearch from './pages/PriceResearch';
import CardShow from './pages/CardShow';
import Lots from './pages/Lots';
import CreateListings from './pages/CreateListings';
import CrossPosting from './pages/CrossPosting';

/** Primary navigation. `tab` entries also appear in the phone tab bar. */
const NAV = [
  { to: '/',          label: 'Dashboard',   icon: '◱', tab: true,  end: true },
  { to: '/scan',      label: 'Scan a Card', icon: '⊕', tab: true },
  { to: '/inventory', label: 'Inventory',   icon: '▤', tab: true },
  { to: '/listings',  label: 'Create Listings', icon: '✎' },
  { to: '/crossposting', label: 'Cross-Posting', icon: '⇄' },
  { to: '/pricing',   label: 'Price Research',  icon: '◴' },
  { to: '/lots',      label: 'Bulk & Lots',     icon: '▦' },
  { to: '/sales',     label: 'Sales & Profit',  icon: '$' },
  { to: '/show',      label: 'Card Show Mode',  icon: '⚡' },
  { to: '/settings',  label: 'Settings',    icon: '⚙', tab: true },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Local mode is the only state where the app can run with no backend at
  // all, so it is also the only state where IndexedDB being unavailable is
  // fatal rather than merely inconvenient.
  if (storageMode === 'local' && !idbAvailable()) {
    return (
      <div className="main" style={{ maxWidth: 520 }}>
        <div className="card">
          <h1>Storage unavailable</h1>
          <p className="small muted mt">
            This browser will not let the app store data locally. That usually means a
            private or incognito window, or site data blocked for localhost.
          </p>
          <p className="small muted">
            Open the app in a normal window, or connect a Supabase project to store your
            inventory in the cloud instead.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="main" style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
        <span className="spinner" />
      </div>
    );
  }

  // Supabase mode requires a signed-in user. Local mode has no accounts.
  if (storageMode === 'supabase' && !session) return <Auth />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">CV</span>
          CardVault
        </div>
        <div className="spacer" />
        {storageMode === 'local' ? (
          <NavLink to="/settings" className="badge badge-warn" title="Data is stored in this browser only">
            On this device
          </NavLink>
        ) : (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => supabase?.auth.signOut()}
            title={session?.user.email ?? undefined}
          >
            Sign out
          </button>
        )}
      </header>

      <div className="app-body">
        <nav className="railnav" aria-label="Sections">
          <div className="group-label">Daily</div>
          {NAV.slice(0, 3).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <span aria-hidden>{n.icon}</span> {n.label}
            </NavLink>
          ))}
          <div className="group-label">Selling</div>
          {NAV.slice(3, 6).map((n) => (
            <NavLink key={n.to} to={n.to}>
              <span aria-hidden>{n.icon}</span> {n.label}
            </NavLink>
          ))}
          <div className="group-label">Business</div>
          {NAV.slice(6).map((n) => (
            <NavLink key={n.to} to={n.to}>
              <span aria-hidden>{n.icon}</span> {n.label}
            </NavLink>
          ))}
        </nav>

        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/scan" element={<Scan />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/inventory/:id" element={<ItemDetail />} />
            <Route path="/settings" element={<SettingsPage />} />

            <Route path="/listings" element={<CreateListings />} />
            <Route path="/crossposting" element={<CrossPosting />} />
            <Route path="/pricing" element={<PriceResearch />} />
            <Route path="/lots" element={<Lots />} />
            <Route path="/sales" element={<Sales />} />
            <Route path="/show" element={<CardShow />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      <nav className="tabbar" aria-label="Main">
        {NAV.filter((n) => n.tab).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            <span className="icon" aria-hidden>{n.icon}</span>
            {n.label === 'Scan a Card' ? 'Scan' : n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
