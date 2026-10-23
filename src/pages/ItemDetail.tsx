/**
 * Inventory item detail, including the per-item Price Research panel.
 *
 * The pricing section keeps five values rigorously separate, as specified:
 *   1. raw provider observations (append-only history)
 *   2. the calculated comp or estimate
 *   3. the operator's manual market-value override
 *   4. the asking price
 *   5. the minimum acceptable price
 * Refreshing (1) never touches (3), (4) or (5).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  currentUserId, deleteImage, externalIdFor, getInventoryItem, getPriceObservations,
  getPricingSettings, listImages, listMovements, recordPriceObservations,
  removeInventoryItem, signedUrls, updateInventoryItem,
  type InventoryItemFull, type InventoryImageRow, type InventoryMovementRow,
  type PricingSettingsRow,
} from '../lib/db';
import RecordSaleDialog from '../components/RecordSaleDialog';
import { activePricingProvidersFor, pricingProvidersFor } from '../providers/registry';
import {
  CLAIM_DESCRIPTIONS, CLAIM_LABELS, CONDITIONS,
  type ConfidenceLevel, type PriceClaim,
} from '../providers/types';
import { centsToInput, formatMoney, parseMoney } from '../lib/money';
import {
  computeComp, summariseEstimates, type CompResult, type CompTarget, type EstimateResult,
} from '../lib/valuation';

const CONFIDENCE_BADGE: Record<ConfidenceLevel, string> = {
  high: 'badge-ok',
  medium: 'badge-info',
  low: 'badge-warn',
  unavailable: 'badge-danger',
};

export default function ItemDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [userId, setUserId] = useState<string | null>(null);
  const [item, setItem] = useState<InventoryItemFull | null>(null);
  const [images, setImages] = useState<InventoryImageRow[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<PricingSettingsRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [claims, setClaims] = useState<PriceClaim[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotes, setRefreshNotes] = useState<string[]>([]);
  const [comp, setComp] = useState<CompResult | null>(null);
  const [estimate, setEstimate] = useState<EstimateResult | null>(null);

  const [override, setOverride] = useState('');
  const [asking, setAsking] = useState('');
  const [minimum, setMinimum] = useState('');
  const [savingPrices, setSavingPrices] = useState(false);
  const [priceSaved, setPriceSaved] = useState(false);

  const [showManual, setShowManual] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showSale, setShowSale] = useState(false);
  const [saleWarnings, setSaleWarnings] = useState<string[]>([]);
  const [movements, setMovements] = useState<InventoryMovementRow[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const uid = await currentUserId();
      setUserId(uid);
      const [row, imgs, st] = await Promise.all([
        getInventoryItem(id), listImages(id), getPricingSettings(uid),
      ]);
      if (!row) { setError('That item does not exist.'); return; }
      setItem(row);
      setImages(imgs);
      setSettings(st);
      setOverride(centsToInput(row.market_value_override_cents));
      setAsking(centsToInput(row.asking_price_cents));
      setMinimum(centsToInput(row.minimum_price_cents));
      if (imgs.length) setUrls(await signedUrls(imgs.map((i) => i.storage_path)));
      setClaims(await getPriceObservations({ inventoryItemId: id, catalogCardId: row.catalog_card_id }));
      setMovements(await listMovements(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this item.');
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Recompute the valuation whenever the inputs change. Both methods always
  // run: the comp is authoritative when real sales exist, and the estimate is
  // shown alongside so the operator can see the difference.
  useEffect(() => {
    if (!item) return;
    const target: CompTarget = {
      currency: item.currency,
      condition: item.kind === 'graded_slab' ? null : item.condition,
      gradingCompany: item.grading_company,
      grade: item.grade,
      finish: item.card_catalog?.finish ?? null,
      variant: item.card_catalog?.variant ?? null,
    };
    setComp(computeComp(claims, target, {
      minSalesForComp: settings?.min_sales_for_comp ?? 3,
      maxSalesForComp: settings?.max_sales_for_comp ?? 4,
      maxSaleAgeDays: 180,
      outlierThreshold: 0.5,
    }));
    setEstimate(summariseEstimates(claims, target, {
      staleAfterDays: settings?.stale_after_days ?? 14,
      conditionAdjustments: settings?.condition_adjustments,
      applyConditionAdjustments: settings?.apply_condition_adjustments,
    }));
  }, [claims, item, settings]);

  async function refreshPrices() {
    if (!item || !userId) return;
    setRefreshing(true);
    setRefreshNotes([]);
    const notes: string[] = [];

    try {
      const game = item.card_catalog?.game ?? 'other';
      const providers = activePricingProvidersFor(game);

      if (providers.length === 0) {
        notes.push(`No configured price provider covers ${game}. Add a comp manually below.`);
      }

      for (const p of providers) {
        const externalId = item.catalog_card_id
          ? await externalIdFor(item.catalog_card_id, p.id)
          : null;

        const res = await p.fetchPrices({
          game,
          externalId: externalId ?? undefined,
          name: item.card_catalog?.name ?? '',
          setCode: item.card_catalog?.set_code ?? undefined,
          collectorNumber: item.card_catalog?.collector_number ?? undefined,
          language: item.card_catalog?.language,
          finish: item.card_catalog?.finish ?? undefined,
          condition: item.condition,
          gradingCompany: item.grading_company ?? undefined,
          grade: item.grade ?? undefined,
        });

        if (res.status === 'ok' && res.claims.length) {
          await recordPriceObservations(res.claims, {
            userId,
            catalogCardId: item.catalog_card_id,
            inventoryItemId: item.id,
          });
        } else if (res.message) {
          notes.push(`${p.label}: ${res.message}`);
        }
      }

      await updateInventoryItem(item.id, { last_price_refresh_at: new Date().toISOString() });
      setClaims(await getPriceObservations({
        inventoryItemId: item.id, catalogCardId: item.catalog_card_id,
      }));
      setRefreshNotes(notes);
    } catch (e) {
      setRefreshNotes([e instanceof Error ? e.message : 'Price refresh failed.']);
    } finally {
      setRefreshing(false);
    }
  }

  async function savePrices() {
    if (!item) return;
    setSavingPrices(true);
    setPriceSaved(false);
    try {
      const patch = {
        market_value_override_cents: parseMoney(override),
        asking_price_cents: parseMoney(asking),
        minimum_price_cents: parseMoney(minimum),
        // The computed valuation is stored separately from the override so
        // the two never overwrite one another.
        market_value_cents: comp?.estimateCents ?? estimate?.estimateCents ?? null,
        market_value_confidence: comp?.estimateCents != null
          ? comp.confidence
          : estimate?.confidence ?? null,
        market_value_method: comp?.estimateCents != null ? comp.method : estimate?.method ?? null,
      };
      const updated = await updateInventoryItem(item.id, patch);
      setItem({ ...item, ...updated });
      setPriceSaved(true);
      setTimeout(() => setPriceSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save prices.');
    } finally {
      setSavingPrices(false);
    }
  }

  if (error) {
    return (
      <>
        <div className="note note-danger">{error}</div>
        <Link className="btn mt" to="/inventory">Back to inventory</Link>
      </>
    );
  }
  if (!item) return <div className="skeleton" style={{ height: 240 }} />;

  const c = item.card_catalog;
  const providers = pricingProvidersFor(c?.game ?? 'other');
  const unconfigured = providers.filter((p) => !p.isConfigured());
  const effectiveValue = item.market_value_override_cents
    ?? comp?.estimateCents ?? estimate?.estimateCents ?? null;

  return (
    <>
      <div className="section-head">
        <div>
          <h1>{c?.name ?? 'Needs identification'}</h1>
          <div className="small muted">
            {[c?.set_name, c?.collector_number && `#${c.collector_number}`,
              c?.finish, c?.language?.toUpperCase()].filter(Boolean).join(' · ') || 'No catalog match'}
          </div>
        </div>
        <Link className="btn btn-sm" to="/inventory">Back</Link>
      </div>

      {/* Photos --------------------------------------------------------- */}
      <div className="card">
        <h2>Your photographs</h2>
        {images.length === 0 ? (
          <p className="small muted mt">No photographs were saved for this item.</p>
        ) : (
          <div className="photo-slots mt">
            {images.map((img) => (
              <div key={img.id} className="photo-slot filled">
                <img src={urls[img.storage_path]} alt={`${img.face} of the card`} />
                <button
                  type="button" className="remove" aria-label="Delete this photo"
                  onClick={async () => {
                    if (!confirm('Delete this photograph? This cannot be undone.')) return;
                    await deleteImage(img);
                    setImages((p) => p.filter((x) => x.id !== img.id));
                  }}
                >×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Facts ---------------------------------------------------------- */}
      <div className="card">
        <h2>Item</h2>
        <div className="scroll-x">
          <table className="data mt">
            <tbody>
              <tr><th>Type</th><td>{item.kind.replace(/_/g, ' ')}</td></tr>
              {item.kind === 'graded_slab' ? (
                <>
                  <tr><th>Grade</th><td>{item.grading_company} {item.grade}</td></tr>
                  <tr><th>Cert</th><td className="mono">{item.cert_number ?? '—'}</td></tr>
                  <tr>
                    <th>Verified</th>
                    <td>
                      {item.grade_verified
                        ? <span className="badge badge-ok">Verified</span>
                        : <span className="badge badge-warn">Not verified with the grader</span>}
                    </td>
                  </tr>
                </>
              ) : (
                <tr>
                  <th>Condition</th>
                  <td>
                    {CONDITIONS.find((x) => x.value === item.condition)?.label}
                    {Object.entries(item.defects ?? {}).filter(([, v]) => v).length > 0 && (
                      <div className="tiny muted">
                        {Object.entries(item.defects).filter(([, v]) => v)
                          .map(([k]) => k.replace(/_/g, ' ')).join(', ')}
                      </div>
                    )}
                  </td>
                </tr>
              )}
              <tr>
                <th>Quantity</th>
                <td>{item.quantity_available} available of {item.quantity}</td>
              </tr>
              <tr><th>Cost</th><td>{formatMoney(item.purchase_cost_cents)}</td></tr>
              <tr><th>Location</th><td>{item.storage_location ?? '—'}</td></tr>
              <tr><th>SKU</th><td className="mono">{item.sku ?? '—'}</td></tr>
              {item.condition_notes && <tr><th>Notes</th><td>{item.condition_notes}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* Price research ------------------------------------------------- */}
      <div className="card">
        <div className="section-head" style={{ marginBottom: 6 }}>
          <h2>Price research</h2>
          <button className="btn btn-sm" onClick={refreshPrices} disabled={refreshing}>
            {refreshing && <span className="spinner" />}
            {refreshing ? 'Refreshing…' : 'Refresh prices'}
          </button>
        </div>

        {item.last_price_refresh_at && (
          <p className="tiny dim">
            Last refreshed {new Date(item.last_price_refresh_at).toLocaleString()}
          </p>
        )}

        {refreshNotes.map((n) => (
          <div key={n} className="note note-warn mt">{n}</div>
        ))}

        {/* The headline valuation. */}
        <div className="valuation mt">
          <div className="big">
            {effectiveValue != null
              ? formatMoney(effectiveValue, item.currency as 'USD')
              : 'No reliable price available'}
          </div>
          <div className="method">
            {item.market_value_override_cents != null
              ? 'Your manual override'
              : comp?.estimateCents != null
                ? comp.method
                : estimate?.method ?? 'Nothing to base a value on yet'}
            {' '}
            <span className={`badge ${CONFIDENCE_BADGE[
              (item.market_value_override_cents != null
                ? 'medium'
                : comp?.estimateCents != null ? comp.confidence : estimate?.confidence) ?? 'unavailable'
            ]}`}>
              {item.market_value_override_cents != null
                ? 'manual'
                : (comp?.estimateCents != null ? comp.confidence : estimate?.confidence) ?? 'unavailable'}
            </span>
          </div>

          {/* Show the arithmetic when the figure is derived from the
              operator's own adjustment, so it never looks like market data. */}
          {item.market_value_override_cents == null
            && comp?.estimateCents == null
            && estimate?.adjustment && (
            <div className="tiny dim" style={{ marginTop: 3 }}>
              {formatMoney(estimate.adjustment.baseCents, item.currency as 'USD')} Near Mint
              {' × '}{estimate.adjustment.factorPercent}%
              {' = '}{formatMoney(estimate.estimateCents, item.currency as 'USD')}
              {' · '}your {estimate.adjustment.condition} setting, not provider data
            </div>
          )}
        </div>

        {/* Comp detail when real sales exist. */}
        {comp && comp.salesUsed.length > 0 && (
          <div className="mt">
            <h3>Comparable sales used ({comp.salesUsed.length})</h3>
            <div className="scroll-x">
              <table className="data">
                <thead>
                  <tr><th>Price</th><th>Sold</th><th>Match</th><th>Source</th></tr>
                </thead>
                <tbody>
                  {comp.salesUsed.map((s, i) => (
                    <tr key={i}>
                      <td className="num">{formatMoney(s.priceCents, s.currency as 'USD')}</td>
                      <td>{s.observedAt ? new Date(s.observedAt).toLocaleDateString() : '—'}</td>
                      <td className="tiny">
                        {[s.gradingCompany && `${s.gradingCompany} ${s.grade}`, s.condition, s.finish]
                          .filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="tiny">
                        {s.sourceUrl
                          ? <a href={s.sourceUrl} target="_blank" rel="noreferrer">{s.provider}</a>
                          : s.provider}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row small muted mt">
              <span>median {formatMoney(comp.medianCents, comp.currency as 'USD')}</span>
              <span>
                range {formatMoney(comp.lowCents, comp.currency as 'USD')}–
                {formatMoney(comp.highCents, comp.currency as 'USD')}
              </span>
            </div>
          </div>
        )}

        {comp && comp.rejected.length > 0 && (
          <details className="mt">
            <summary className="small muted" style={{ cursor: 'pointer' }}>
              {comp.rejected.length} sale{comp.rejected.length === 1 ? '' : 's'} excluded — why?
            </summary>
            <ul className="tiny muted" style={{ paddingLeft: 18, marginTop: 6 }}>
              {comp.rejected.map((r, i) => (
                <li key={i}>
                  {formatMoney(r.claim.priceCents, r.claim.currency as 'USD')} — {r.reason}
                </li>
              ))}
            </ul>
          </details>
        )}

        {(comp?.limitations.length || estimate?.limitations.length) ? (
          <div className="mt">
            {[...(comp?.estimateCents != null ? comp.limitations : estimate?.limitations ?? [])]
              .map((l) => <div key={l} className="note note-warn">{l}</div>)}
          </div>
        ) : null}

        {/* Every observation we hold, with its claim type spelled out. */}
        {claims.length > 0 && (
          <details className="mt">
            <summary className="small muted" style={{ cursor: 'pointer' }}>
              All {claims.length} recorded price observation{claims.length === 1 ? '' : 's'}
            </summary>
            <div className="mt">
              {claims.slice(0, 25).map((cl, i) => (
                <div key={i} className="claim">
                  <div className="amt">{formatMoney(cl.priceCents, cl.currency as 'USD')}</div>
                  <div className="who">
                    <span className="badge">{CLAIM_LABELS[cl.claimType]}</span>{' '}
                    {cl.provider}
                    {cl.observedAt && ` · sold ${new Date(cl.observedAt).toLocaleDateString()}`}
                  </div>
                  <div className="why">
                    {cl.notes ?? CLAIM_DESCRIPTIONS[cl.claimType]}
                    {' '}Retrieved {new Date(cl.retrievedAt).toLocaleDateString()}.
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="row mt">
          <button className="btn btn-sm" onClick={() => setShowManual(true)}>
            + Add a comp manually
          </button>
        </div>

        {unconfigured.length > 0 && (
          <details className="mt">
            <summary className="tiny dim" style={{ cursor: 'pointer' }}>
              {unconfigured.length} price source{unconfigured.length === 1 ? ' is' : 's are'} not connected
            </summary>
            <div className="mt">
              {unconfigured.map((p) => (
                <div key={p.id} className="note note-info" style={{ marginBottom: 6 }}>
                  <strong>{p.label}</strong> — {p.configurationNote}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* Your prices ---------------------------------------------------- */}
      <div className="card">
        <h2>Your prices</h2>
        <p className="small muted" style={{ marginTop: 4 }}>
          These are yours. Refreshing market data never changes them.
        </p>

        <div className="grid grid-3 mt">
          <label className="field">
            <span className="label-text">Market value override</span>
            <input type="text" inputMode="decimal" value={override} placeholder="auto"
                   onChange={(e) => setOverride(e.target.value)} />
            <span className="hint">Leave blank to use the calculated value.</span>
          </label>
          <label className="field">
            <span className="label-text">Asking price</span>
            <input type="text" inputMode="decimal" value={asking} placeholder="0.00"
                   onChange={(e) => setAsking(e.target.value)} />
          </label>
          <label className="field">
            <span className="label-text">Minimum accepted</span>
            <input type="text" inputMode="decimal" value={minimum} placeholder="0.00"
                   onChange={(e) => setMinimum(e.target.value)} />
            <span className="hint">Must not exceed the asking price.</span>
          </label>
        </div>

        <div className="row">
          <button className="btn btn-primary btn-sm" onClick={savePrices} disabled={savingPrices}>
            {savingPrices && <span className="spinner" />} Save prices
          </button>
          {priceSaved && <span className="badge badge-ok">Saved</span>}
        </div>
      </div>

      {/* Sell ----------------------------------------------------------- */}
      <div className="card">
        <div className="section-head" style={{ marginBottom: 6 }}>
          <h2>Sell</h2>
          {item.quantity_available > 0 ? (
            <button className="btn btn-primary btn-sm" onClick={() => setShowSale(true)}>
              Record a sale
            </button>
          ) : (
            <span className="badge badge-info">
              {item.status === 'sold' ? 'Sold' : 'None available'}
            </span>
          )}
        </div>

        {saleWarnings.length > 0 && (
          <div className="mt">
            {saleWarnings.map((w) => (
              <div key={w} className="note note-warn">{w}</div>
            ))}
          </div>
        )}

        {movements.length > 0 && (
          <details className="mt">
            <summary className="small muted" style={{ cursor: 'pointer' }}>
              Movement history ({movements.length})
            </summary>
            <div className="scroll-x">
              <table className="data mt">
                <thead>
                  <tr><th>When</th><th>What</th><th className="num">Change</th><th>Note</th></tr>
                </thead>
                <tbody>
                  {movements.map((m) => (
                    <tr key={m.id}>
                      <td className="nowrap">{new Date(m.created_at).toLocaleDateString()}</td>
                      <td>{m.reason.replace(/_/g, ' ')}</td>
                      <td className="num">{m.quantity_delta > 0 ? '+' : ''}{m.quantity_delta}</td>
                      <td className="tiny">{m.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="tiny dim" style={{ marginTop: 6, marginBottom: 0 }}>
              Append-only. Voiding a sale adds a reversal rather than deleting history.
            </p>
          </details>
        )}
      </div>

      <div className="card">
        <div className="row between">
          <div>
            <h3>Remove this item</h3>
            <p className="tiny muted" style={{ margin: 0 }}>
              Marks it removed and keeps its history. Photos are retained.
            </p>
          </div>
          <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>
            Remove
          </button>
        </div>
      </div>

      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Remove this item?</h2>
            <p className="small muted mt">
              {c?.name ?? 'This item'} will be marked removed. Its sales and pricing history
              stay intact, and you can still find it by filtering for removed items.
            </p>
            <div className="row mt">
              <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  await removeInventoryItem(item.id);
                  navigate('/inventory');
                }}
              >
                Remove item
              </button>
            </div>
          </div>
        </div>
      )}

      {showSale && userId && (
        <RecordSaleDialog
          item={item}
          userId={userId}
          onClose={() => setShowSale(false)}
          onSaved={(warnings) => {
            setShowSale(false);
            setSaleWarnings(warnings);
            load();
          }}
        />
      )}

      {showManual && userId && (
        <ManualCompDialog
          item={item}
          userId={userId}
          onClose={() => setShowManual(false)}
          onSaved={async () => {
            setShowManual(false);
            setClaims(await getPriceObservations({
              inventoryItemId: item.id, catalogCardId: item.catalog_card_id,
            }));
          }}
        />
      )}
    </>
  );
}

/**
 * Manual comp entry.
 *
 * This is the compliant workflow for Card Ladder, ALT and eBay sold listings,
 * none of which can be read programmatically. The operator looks the sale up
 * themselves and records it; it is stored as a real dated sold observation and
 * becomes eligible for the comp average.
 */
function ManualCompDialog({
  item, userId, onClose, onSaved,
}: {
  item: InventoryItemFull;
  userId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [price, setPrice] = useState('');
  const [soldOn, setSoldOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [sourceName, setSourceName] = useState('eBay');
  const [url, setUrl] = useState('');
  const [gradingCompany, setGradingCompany] = useState(item.grading_company ?? '');
  const [grade, setGrade] = useState(item.grade != null ? String(item.grade) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cents = parseMoney(price);

  async function save() {
    if (cents == null) { setErr('Enter the price this card actually sold for.'); return; }
    setBusy(true);
    setErr(null);
    try {
      await recordPriceObservations(
        [{
          provider: sourceName || 'manual',
          claimType: 'sold_observation',
          priceCents: cents,
          currency: item.currency,
          condition: item.kind === 'graded_slab' ? null : item.condition,
          gradingCompany: gradingCompany || null,
          grade: grade ? Number(grade) : null,
          finish: item.card_catalog?.finish ?? null,
          observedAt: new Date(soldOn).toISOString(),
          retrievedAt: new Date().toISOString(),
          sourceUrl: url || null,
          // A stable id prevents the same sale being entered twice.
          externalId: `manual:${sourceName}:${soldOn}:${cents}`,
          status: 'ok',
          notes: 'Recorded manually by the operator from a completed sale.',
        }],
        { userId, catalogCardId: item.catalog_card_id, inventoryItemId: item.id }
      );
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save that comp.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add a completed sale</h2>
        <p className="small muted mt">
          Record a sale you have verified yourself. Only genuine completed sales belong
          here — an asking price entered as a sale would corrupt every comp this card
          produces from now on.
        </p>

        <div className="grid grid-2 mt">
          <label className="field">
            <span className="label-text">Sold price</span>
            <input type="text" inputMode="decimal" value={price} placeholder="0.00"
                   onChange={(e) => setPrice(e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span className="label-text">Sale date</span>
            <input type="date" value={soldOn} onChange={(e) => setSoldOn(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span className="label-text">Source</span>
          <select value={sourceName} onChange={(e) => setSourceName(e.target.value)}>
            <option>eBay</option>
            <option>Card Ladder</option>
            <option>ALT</option>
            <option>TCGplayer</option>
            <option>PWCC</option>
            <option>Goldin</option>
            <option>In person</option>
            <option value="manual">Other</option>
          </select>
        </label>

        <label className="field">
          <span className="label-text">Link to the sale (optional)</span>
          <input type="text" value={url} placeholder="https://…"
                 onChange={(e) => setUrl(e.target.value)} />
        </label>

        {item.kind === 'graded_slab' && (
          <div className="grid grid-2">
            <label className="field">
              <span className="label-text">Grading company</span>
              <input type="text" value={gradingCompany}
                     onChange={(e) => setGradingCompany(e.target.value)} />
            </label>
            <label className="field">
              <span className="label-text">Grade</span>
              <input type="number" step="0.5" value={grade}
                     onChange={(e) => setGrade(e.target.value)} />
            </label>
          </div>
        )}

        {item.kind === 'graded_slab' && (
          <div className="note note-info">
            Only sales of the same company and grade will be averaged into this card's comp.
            A PSA 9 sale will be recorded but excluded, with the reason shown.
          </div>
        )}

        {err && <div className="note note-danger mt">{err}</div>}

        <div className="row mt">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || cents == null}>
            {busy && <span className="spinner" />} Save sale
          </button>
        </div>
      </div>
    </div>
  );
}
