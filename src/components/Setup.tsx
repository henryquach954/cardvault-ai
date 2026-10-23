/**
 * Shown when Supabase credentials are absent.
 *
 * This screen exists because the alternative -- a blank page or a console
 * error -- would be indistinguishable from a broken build. A fresh clone with
 * no keys is a known, expected state, so the app says so and gives the exact
 * steps out of it.
 */
import { supabaseDiagnostics } from '../lib/supabase';

export default function Setup() {
  return (
    <div className="main" style={{ maxWidth: 680 }}>
      <div className="card">
        <h1>Connect your database</h1>
        <p className="muted small mt">
          CardVault stores your inventory, photographs and pricing history in your own
          Supabase project. Nothing works until that connection exists, so the app will
          not pretend otherwise.
        </p>

        <div className="note note-warn mt">
          <strong>Not configured.</strong>{' '}
          {supabaseDiagnostics.urlPresent
            ? 'VITE_SUPABASE_URL is set'
            : 'VITE_SUPABASE_URL is missing'}
          {' · '}
          {supabaseDiagnostics.keyPresent
            ? 'VITE_SUPABASE_ANON_KEY is set'
            : 'VITE_SUPABASE_ANON_KEY is missing'}
          {supabaseDiagnostics.urlValue && (
            <div className="tiny mono mt">URL: {supabaseDiagnostics.urlValue}</div>
          )}
        </div>

        <h2 className="mt">What to do</h2>
        <ol className="small muted" style={{ paddingLeft: 18, lineHeight: 1.75 }}>
          <li>
            Create a free project at{' '}
            <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">
              supabase.com/dashboard
            </a>. Any region near you is fine.
          </li>
          <li>
            Open <strong>Project Settings → API</strong> and copy the{' '}
            <strong>Project URL</strong> and the <strong>anon / public</strong> key.
          </li>
          <li>
            In the project root, copy <span className="mono">.env.example</span> to{' '}
            <span className="mono">.env.local</span> and paste both values in.
          </li>
          <li>
            Apply the database schema: open the Supabase <strong>SQL Editor</strong> and run
            the two files in <span className="mono">supabase/migrations/</span> in order.
          </li>
          <li>Restart the dev server so Vite picks up the new environment file.</li>
        </ol>

        <div className="note note-info mt">
          Only the <strong>anon</strong> key belongs in this app. It is safe in a browser
          because row-level security, not key secrecy, protects your data. Never put the{' '}
          <strong>service_role</strong> key in a <span className="mono">VITE_</span> variable —
          anything prefixed that way is compiled into the JavaScript your browser downloads.
        </div>
      </div>
    </div>
  );
}
