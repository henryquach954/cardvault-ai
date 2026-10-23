/**
 * Email + password sign in. Supabase Auth handles hashing, sessions and
 * refresh; this component only collects credentials and reports what happened.
 */
import { useState, type FormEvent } from 'react';
import { requireSupabase } from '../lib/supabase';

export default function Auth() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const sb = requireSupabase();
      if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        // When email confirmation is on, there is a user but no session yet.
        if (data.user && !data.session) {
          setNotice(
            'Account created. Check your email for a confirmation link, then sign in. ' +
            'You can turn confirmation off in Supabase under Authentication → Providers → Email.'
          );
          setMode('signin');
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="main" style={{ maxWidth: 400 }}>
      <div className="card">
        <div className="row" style={{ gap: 8, marginBottom: 14 }}>
          <span className="mark" style={{
            display: 'grid', placeItems: 'center', width: 28, height: 28,
            borderRadius: 7, background: 'var(--accent)', color: 'var(--accent-text)',
            fontSize: '0.78rem', fontWeight: 800,
          }}>CV</span>
          <h1>CardVault</h1>
        </div>

        <div className="seg mb">
          <button type="button" aria-pressed={mode === 'signin'} onClick={() => setMode('signin')}>
            Sign in
          </button>
          <button type="button" aria-pressed={mode === 'signup'} onClick={() => setMode('signup')}>
            Create account
          </button>
        </div>

        <form onSubmit={submit}>
          <label className="field">
            <span className="label-text">Email</span>
            <input
              type="email" value={email} required autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="label-text">Password</span>
            <input
              type="password" value={password} required minLength={8}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === 'signup' && <span className="hint">At least 8 characters.</span>}
          </label>

          {error && <div className="note note-danger mb">{error}</div>}
          {notice && <div className="note note-info mb">{notice}</div>}

          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy && <span className="spinner" />}
            {mode === 'signup' ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
