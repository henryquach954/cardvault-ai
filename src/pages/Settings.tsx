/**
 * Settings — provider status and pricing preferences.
 *
 * The provider table is the honesty surface of the whole application. Every
 * source named in the product appears, with its real connection state and a
 * verified reason when it is unavailable. Nothing is listed as connected
 * merely because the app knows its name.
 */
import { useEffect, useState } from 'react';
import {
  CATALOG_PROVIDERS, PRICING_PROVIDERS, UNAVAILABLE_PROVIDERS,
} from '../providers/registry';
import {
  assertBundle, currentUserId, exportAll, getPricingSettings, importAll, storageEstimate,
  storageMode, updatePricingSettings,
  type BackupBundle, type PricingSettingsRow,
} from '../lib/db';
import { centsToInput, parseMoney } from '../lib/money';
import { CONDITIONS } from '../providers/types';

/** NM is the anchor (always 100%) and NEEDS_REVIEW has no known condition. */
const ADJUSTABLE_CONDITIONS = CONDITIONS.filter(
  (c) => c.value !== 'NM' && c.value !== 'NEEDS_REVIEW'
);

export default function SettingsPage() {
  const [settings, setSettings] = useState<PricingSettingsRow | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    currentUserId()
      .then(async (uid) => {
        setUserId(uid);
        setSettings(await getPricingSettings(uid));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings.'));
  }, []);

  async function patch(p: Partial<PricingSettingsRow>) {
    if (!userId || !settings) return;
    setSettings({ ...settings, ...p });
    try {
      await updatePricingSettings(userId, p);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  }

  const available = PRICING_PROVIDERS.filter((p) => p.isConfigured());

  return (
    <>
      <div className="section-head">
        <h1>Settings</h1>
        {saved && <span className="badge badge-ok">Saved</span>}
      </div>

      {error && <div className="note note-danger">{error}</div>}

      <StorageSection userId={userId} />

      {/* Catalog ------------------------------------------------------- */}
      <div className="card">
        <h2>Card catalogs</h2>
        <p className="small muted" style={{ marginTop: 4 }}>
          Used to identify cards. All of these are free and need no account.
        </p>
        <div className="scroll-x">
          <table className="data mt">
            <thead>
              <tr><th>Provider</th><th>Games</th><th>Status</th></tr>
            </thead>
            <tbody>
              {CATALOG_PROVIDERS.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a href={p.homepage} target="_blank" rel="noreferrer">{p.label}</a>
                  </td>
                  <td className="tiny">{p.games.join(', ')}</td>
                  <td><span className="badge badge-ok">Connected</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pricing providers --------------------------------------------- */}
      <div className="card">
        <h2>Price sources</h2>
        <p className="small muted" style={{ marginTop: 4 }}>
          {available.length} of {PRICING_PROVIDERS.length} sources are usable right now.
        </p>

        <div className="scroll-x">
          <table className="data mt">
            <thead>
              <tr>
                <th>Source</th><th>Status</th>
                <th>By condition</th><th>Graded</th><th>Real sales</th>
              </tr>
            </thead>
            <tbody>
              {PRICING_PROVIDERS.map((p) => (
                <tr key={p.id}>
                  <td><a href={p.homepage} target="_blank" rel="noreferrer">{p.label}</a></td>
                  <td>
                    {p.isConfigured()
                      ? <span className="badge badge-ok">Connected</span>
                      : <span className="badge badge-warn">Unavailable</span>}
                  </td>
                  <td>{p.capabilities.conditionSpecific ? 'yes' : 'no'}</td>
                  <td>{p.capabilities.gradedPricing ? 'yes' : 'no'}</td>
                  <td>{p.capabilities.individualSales ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="mt">Why sources are unavailable</h3>
        <p className="tiny dim">Verified 22 October 2026.</p>
        {UNAVAILABLE_PROVIDERS.map((p) => (
          <details key={p.id} style={{ marginTop: 7 }}>
            <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
              {p.label}
            </summary>
            <div className="small muted" style={{ padding: '6px 0 0 14px' }}>
              <p style={{ marginBottom: 5 }}>{p.configurationNote}</p>
              <p style={{ margin: 0 }}><strong>What you can do:</strong> {p.remediation}</p>
            </div>
          </details>
        ))}

        <div className="note note-info mt">
          Because no connected source provides individual completed sales, graded-slab
          comps must be entered by hand. Open any item and use <strong>Add a comp
          manually</strong> — those entries are real dated sales and feed the averaging
          exactly as an API source would.
        </div>
      </div>

      {/* Pricing preferences -------------------------------------------- */}
      {settings && (
        <div className="card">
          <h2>Pricing preferences</h2>

          <label className="field mt">
            <span className="label-text">How should asking prices be suggested?</span>
            <select
              value={settings.asking_price_strategy}
              onChange={(e) => patch({ asking_price_strategy: e.target.value })}
            >
              <option value="manual">Always enter manually</option>
              <option value="market">Match the market estimate</option>
              <option value="market_plus_percent">Market estimate plus a percentage</option>
              <option value="market_plus_fixed">Market estimate plus a fixed amount</option>
            </select>
            <span className="hint">
              A suggestion only. Nothing ever changes a live listing's price without you.
            </span>
          </label>

          {settings.asking_price_strategy === 'market_plus_percent' && (
            <label className="field">
              <span className="label-text">Markup percentage</span>
              <input
                type="number" step="1" value={settings.markup_percent}
                onChange={(e) => patch({ markup_percent: Number(e.target.value) })}
              />
            </label>
          )}
          {settings.asking_price_strategy === 'market_plus_fixed' && (
            <label className="field">
              <span className="label-text">Fixed markup</span>
              <input
                type="text" inputMode="decimal"
                defaultValue={centsToInput(settings.markup_fixed_cents)}
                onBlur={(e) => patch({ markup_fixed_cents: parseMoney(e.target.value) ?? 0 })}
              />
            </label>
          )}

          <div className="grid grid-3">
            <label className="field">
              <span className="label-text">Minimum sales for a comp</span>
              <input
                type="number" min="1" max="10" value={settings.min_sales_for_comp}
                onChange={(e) => patch({ min_sales_for_comp: Number(e.target.value) })}
              />
              <span className="hint">Below this, confidence is forced to low.</span>
            </label>
            <label className="field">
              <span className="label-text">Maximum sales averaged</span>
              <input
                type="number" min="1" max="20" value={settings.max_sales_for_comp}
                onChange={(e) => patch({ max_sales_for_comp: Number(e.target.value) })}
              />
              <span className="hint">The most recent N sales form the average.</span>
            </label>
            <label className="field">
              <span className="label-text">Prices go stale after</span>
              <input
                type="number" min="1" value={settings.stale_after_days}
                onChange={(e) => patch({ stale_after_days: Number(e.target.value) })}
              />
              <span className="hint">Days.</span>
            </label>
          </div>

          <h3 className="mt">Condition adjustments</h3>
          <div className="note note-info">
            No connected source provides condition-specific pricing, so every raw price
            arrives anchored to Near Mint. These are <strong>your</strong> percentages,
            applied to that anchor and labelled as a derived estimate — never presented
            as provider data, and always capped at low confidence.
          </div>

          <label className="row small mt" style={{ gap: 7 }}>
            <input
              type="checkbox" style={{ width: 16, minHeight: 0 }}
              checked={settings.apply_condition_adjustments}
              onChange={(e) => patch({ apply_condition_adjustments: e.target.checked })}
            />
            <span>Apply my condition adjustments to Near-Mint-anchored prices</span>
          </label>

          <div className="grid grid-auto mt">
            {ADJUSTABLE_CONDITIONS.map(({ value, label }) => (
              <label className="field" key={value}>
                <span className="label-text">{label}</span>
                <div className="row row-tight" style={{ flexWrap: 'nowrap' }}>
                  <input
                    type="number" min="1" max="100" step="1"
                    disabled={!settings.apply_condition_adjustments}
                    value={settings.condition_adjustments?.[value] ?? ''}
                    placeholder="—"
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const next = { ...(settings.condition_adjustments ?? {}) };
                      if (!e.target.value || !Number.isFinite(n)) delete next[value];
                      else next[value] = Math.min(100, Math.max(1, Math.round(n)));
                      patch({ condition_adjustments: next });
                    }}
                  />
                  <span className="muted small">%</span>
                </div>
              </label>
            ))}
          </div>
          <p className="tiny dim" style={{ marginTop: -4 }}>
            Percentage of the Near Mint price. Near Mint is the anchor and is always 100%.
            Leave one blank and the app will warn rather than guess for that condition.
          </p>
        </div>
      )}

      <div className="card">
        <h2>About this build</h2>
        <p className="small muted" style={{ marginTop: 4 }}>
          Stage 1 (core inventory) is complete and tested. Stages 2 to 6 are listed in
          the navigation with their real status. No integration is simulated.
        </p>
      </div>
    </>
  );
}

/**
 * Storage mode, usage, and backup.
 *
 * In local mode this is the most important panel in the app: it is the only
 * thing standing between the operator and losing their inventory to a cleared
 * browser cache, so it states the risk plainly rather than burying it.
 */
function StorageSection({ userId }: { userId: string | null }) {
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (storageMode === 'local') storageEstimate().then(setUsage).catch(() => {});
  }, []);

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

  async function doExport() {
    setBusy('export');
    setResult(null);
    setProblem(null);
    try {
      const bundle = await exportAll({ includePhotos: true });
      const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cardvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setResult(
        `Exported ${bundle.items.length} item${bundle.items.length === 1 ? '' : 's'} ` +
        `and ${Object.keys(bundle.photos).length} photo` +
        `${Object.keys(bundle.photos).length === 1 ? '' : 's'}.`
      );
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  async function doImport(file: File | undefined) {
    if (!file || !userId) return;
    setBusy('import');
    setResult(null);
    setProblem(null);
    try {
      const parsed = JSON.parse(await file.text()) as BackupBundle;
      assertBundle(parsed);
      const { imported, skipped } = await importAll(parsed, userId);
      setResult(
        `Imported ${imported} record${imported === 1 ? '' : 's'}` +
        `${skipped ? `, skipped ${skipped} already present or invalid` : ''}. Reload to see them.`
      );
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <div className="section-head" style={{ marginBottom: 6 }}>
        <h2>Where your data lives</h2>
        <span className={`badge ${storageMode === 'local' ? 'badge-warn' : 'badge-ok'}`}>
          {storageMode === 'local' ? 'This device only' : 'Supabase cloud'}
        </span>
      </div>

      {storageMode === 'local' ? (
        <>
          <p className="small muted" style={{ marginTop: 4 }}>
            Your inventory and photographs are stored in this browser, on this device.
            No account, no network, works offline.
          </p>
          <div className="note note-warn mt">
            <strong>Three things this means.</strong> Your data does not reach your other
            devices. Clearing this browser's site data erases it permanently. And photo
            storage is capped by the browser, not by you.
            <br /><br />
            Export a backup regularly — it is the only copy you control.
          </div>

          {usage && usage.quota > 0 && (
            <p className="tiny dim mt">
              Using {mb(usage.usage)} of roughly {mb(usage.quota)} the browser has granted
              {' '}({Math.round((usage.usage / usage.quota) * 100)}%).
            </p>
          )}
        </>
      ) : (
        <p className="small muted" style={{ marginTop: 4 }}>
          Your data is in your Supabase project, protected by row-level security and
          reachable from any device you sign in on.
        </p>
      )}

      <div className="row mt">
        <button className="btn btn-sm" onClick={doExport} disabled={busy !== null}>
          {busy === 'export' && <span className="spinner" />} Export backup
        </button>
        <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
          {busy === 'import' && <span className="spinner" />} Import backup
          <input
            type="file" accept="application/json,.json" className="visually-hidden"
            disabled={busy !== null}
            onChange={(e) => { doImport(e.target.files?.[0]); e.target.value = ''; }}
          />
        </label>
      </div>

      {result && <div className="note note-ok mt">{result}</div>}
      {problem && <div className="note note-danger mt">{problem}</div>}

      {storageMode === 'local' && (
        <details className="mt">
          <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
            Moving to Supabase later
          </summary>
          <ol className="small muted" style={{ paddingLeft: 18, lineHeight: 1.7, marginTop: 6 }}>
            <li><strong>Export a backup</strong> here first, and keep the file.</li>
            <li>
              Create a free project at{' '}
              <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">
                supabase.com
              </a>, then run the three files in{' '}
              <span className="mono">supabase/migrations/</span> in its SQL Editor.
            </li>
            <li>
              Copy <span className="mono">.env.example</span> to{' '}
              <span className="mono">.env.local</span>, paste in the Project URL and anon
              key, and restart the dev server.
            </li>
            <li>Create an account, then come back here and <strong>Import</strong> that file.</li>
          </ol>
          <p className="tiny dim">
            Nothing migrates on its own. Uploading your inventory to a new cloud account
            should be a decision you make, not something that happens because a
            configuration file changed.
          </p>
        </details>
      )}
    </div>
  );
}
