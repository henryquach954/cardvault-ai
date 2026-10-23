/**
 * Price Research — look up any card's market price without owning it.
 *
 * Built for the moment someone offers you a card at a show and you need to
 * know what it is worth before you hand over cash.
 *
 * Deliberately READ-ONLY. A lookup writes nothing: no catalog row, no price
 * observation, no inventory. Checking a price you decide not to buy should
 * not leave residue in your records. If you do buy it, "Add to inventory"
 * carries the confirmed printing straight into the scan workflow, and that is
 * where data starts being saved.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import CardSearch, { describeCandidate } from '../components/CardSearch';
import { activePricingProvidersFor, pricingProvidersFor } from '../providers/registry';
import {
  CLAIM_DESCRIPTIONS, CLAIM_LABELS, CONDITIONS,
  type CardCandidate, type CardCondition, type ConfidenceLevel,
  type PriceClaim, type TcgGame,
} from '../providers/types';
import { currentUserId, getPricingSettings, listInventory } from '../lib/db';
import { refreshItemPrices, staleItems, type RefreshOutcome } from '../lib/refresh';
import type { InventoryItemFull, PricingSettingsRow } from '../lib/db';
import { formatMoney } from '../lib/money';
import { summariseEstimates, type CompTarget, type EstimateResult } from '../lib/valuation';

const CONFIDENCE_BADGE: Record<ConfidenceLevel, string> = {
  high: 'badge-ok',
  medium: 'badge-info',
  low: 'badge-warn',
  unavailable: 'badge-danger',
};

const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'TAG', 'ACE', 'Other'];

export default function PriceResearch() {
  const navigate = useNavigate();

  const [game, setGame] = useState<TcgGame>('pokemon');
  const [card, setCard] = useState<CardCandidate | null>(null);

  const [condition, setCondition] = useState<CardCondition>('NM');
  const [graded, setGraded] = useState(false);
  const [gradingCompany, setGradingCompany] = useState('PSA');
  const [grade, setGrade] = useState('10');

  const [settings, setSettings] = useState<PricingSettingsRow | null>(null);
  const [claims, setClaims] = useState<PriceClaim[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [owned, setOwned] = useState<InventoryItemFull[]>([]);

  useEffect(() => {
    currentUserId()
      .then(getPricingSettings)
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  /** Fetch live prices for the confirmed printing. Writes nothing. */
  const lookup = useCallback(async (c: CardCandidate) => {
    setLoading(true);
    setClaims(null);
    setNotes([]);
    const found: PriceClaim[] = [];
    const messages: string[] = [];

    try {
      const providers = activePricingProvidersFor(c.game);
      if (providers.length === 0) {
        messages.push(`No connected price source covers ${c.game}.`);
      }

      for (const p of providers) {
        const res = await p.fetchPrices({
          game: c.game,
          externalId: c.externalId,
          name: c.name,
          setCode: c.setCode,
          collectorNumber: c.collectorNumber,
          language: c.language,
          finish: c.finish,
        });
        if (res.status === 'ok') found.push(...res.claims);
        else if (res.message) messages.push(`${p.label}: ${res.message}`);
      }
      setClaims(found);
      setNotes(messages);
    } catch (e) {
      setNotes([e instanceof Error ? e.message : 'Price lookup failed.']);
      setClaims([]);
    } finally {
      setLoading(false);
    }
  }, []);

  /** Do I already own this? Useful before buying another copy. */
  const checkOwned = useCallback(async (c: CardCandidate) => {
    try {
      const rows = await listInventory({ search: c.name, limit: 500 });
      setOwned(
        rows.filter((r) => {
          const cat = r.card_catalog;
          if (!cat) return false;
          const same = (a?: string | null, b?: string | null) =>
            (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
          return same(cat.name, c.name)
            && same(cat.set_code, c.setCode)
            && same(cat.collector_number, c.collectorNumber);
        })
      );
    } catch {
      setOwned([]);
    }
  }, []);

  function onSelect(c: CardCandidate | null) {
    setCard(c);
    setClaims(null);
    setNotes([]);
    setOwned([]);
    if (c) {
      lookup(c);
      checkOwned(c);
    }
  }

  // The valuation target reflects the condition the operator is considering,
  // so the condition adjustment applies exactly as it would in inventory.
  const target: CompTarget = {
    currency: settings?.default_currency ?? 'USD',
    condition: graded ? null : condition,
    gradingCompany: graded ? gradingCompany : null,
    grade: graded ? Number(grade) : null,
    finish: card?.finish ?? null,
    variant: card?.variant ?? null,
  };

  let estimate: EstimateResult | null = null;
  if (claims) {
    estimate = summariseEstimates(claims, target, {
      staleAfterDays: settings?.stale_after_days ?? 14,
      conditionAdjustments: settings?.condition_adjustments,
      applyConditionAdjustments: settings?.apply_condition_adjustments,
    });
  }

  const currency = (target.currency ?? 'USD') as 'USD';
  const unconfigured = pricingProvidersFor(game).filter((p) => !p.isConfigured());

  return (
    <>
      <div className="section-head">
        <h1>Price Research</h1>
        <span className="sub">Look up any card — you do not have to own it</span>
      </div>

      <div className="card">
        <h2>Find a card</h2>
        <CardSearch
          game={game}
          onGameChange={setGame}
          selected={card}
          onSelect={onSelect}
          noProviderHint={
            <div className="note note-warn">
              No free catalog covers this game, so there is nothing to look up
              automatically. Check the card on a marketplace yourself and record
              what you find against an inventory item.
            </div>
          }
        />
      </div>

      {card && (
        <>
          {/* What exactly are we pricing? ------------------------------- */}
          <div className="card">
            <h2>Condition</h2>
            <p className="small muted" style={{ marginTop: 4 }}>
              Price depends on condition, so say which one you are considering.
            </p>

            <div className="seg mt mb">
              <button type="button" aria-pressed={!graded} onClick={() => setGraded(false)}>
                Raw card
              </button>
              <button type="button" aria-pressed={graded} onClick={() => setGraded(true)}>
                Graded slab
              </button>
            </div>

            {graded ? (
              <>
                <div className="grid grid-2">
                  <label className="field">
                    <span className="label-text">Grading company</span>
                    <select value={gradingCompany} onChange={(e) => setGradingCompany(e.target.value)}>
                      {GRADERS.map((g) => <option key={g}>{g}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span className="label-text">Grade</span>
                    <input
                      type="number" step="0.5" min="0" max="10" value={grade}
                      onChange={(e) => setGrade(e.target.value)}
                    />
                  </label>
                </div>
                <div className="note note-warn">
                  <strong>No connected source prices graded slabs.</strong> Card Ladder, ALT
                  and eBay sold listings are all closed to automated access, so the figures
                  below are <em>raw-card</em> prices and do not value a {gradingCompany}{' '}
                  {grade}. Look the slab up yourself and record the sales you find against
                  an inventory item.
                </div>
              </>
            ) : (
              <label className="field">
                <span className="label-text">Condition</span>
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value as CardCondition)}
                >
                  {CONDITIONS.filter((c) => c.value !== 'NEEDS_REVIEW').map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <span className="hint">
                  {CONDITIONS.find((c) => c.value === condition)?.hint}
                </span>
              </label>
            )}
          </div>

          {/* The answer -------------------------------------------------- */}
          <div className="card">
            <div className="section-head" style={{ marginBottom: 6 }}>
              <h2>{card.name}</h2>
              <button className="btn btn-sm" onClick={() => lookup(card)} disabled={loading}>
                {loading && <span className="spinner" />} Refresh
              </button>
            </div>
            <p className="small muted" style={{ marginTop: 0 }}>{describeCandidate(card)}</p>

            {loading && !claims && <div className="skeleton mt" style={{ height: 80 }} />}

            {estimate && (
              <div className="valuation mt">
                <div className="big">
                  {estimate.estimateCents != null
                    ? formatMoney(estimate.estimateCents, currency)
                    : 'No reliable price available'}
                </div>
                <div className="method">
                  {estimate.method}{' '}
                  <span className={`badge ${CONFIDENCE_BADGE[estimate.confidence]}`}>
                    {estimate.confidence}
                  </span>
                </div>
                {estimate.adjustment && (
                  <div className="tiny dim" style={{ marginTop: 3 }}>
                    {formatMoney(estimate.adjustment.baseCents, currency)} Near Mint
                    {' × '}{estimate.adjustment.factorPercent}%
                    {' = '}{formatMoney(estimate.estimateCents, currency)}
                    {' · '}your {estimate.adjustment.condition} setting, not provider data
                  </div>
                )}
              </div>
            )}

            {estimate?.limitations.map((l) => (
              <div key={l} className="note note-warn mt">{l}</div>
            ))}
            {notes.map((n) => (
              <div key={n} className="note note-info mt">{n}</div>
            ))}

            {claims && claims.length > 0 && (
              <details className="mt" open>
                <summary className="small muted" style={{ cursor: 'pointer' }}>
                  All {claims.length} figure{claims.length === 1 ? '' : 's'} returned
                </summary>
                <div className="mt">
                  {claims.map((c, i) => (
                    <div key={i} className="claim">
                      <div className="amt">{formatMoney(c.priceCents, c.currency as 'USD')}</div>
                      <div className="who">
                        <span className="badge">{CLAIM_LABELS[c.claimType]}</span> {c.provider}
                      </div>
                      <div className="why">{c.notes ?? CLAIM_DESCRIPTIONS[c.claimType]}</div>
                    </div>
                  ))}
                </div>
              </details>
            )}

            <div className="row mt">
              <button
                className="btn btn-primary btn-sm"
                onClick={() =>
                  navigate('/scan', {
                    state: {
                      candidate: card,
                      condition: graded ? 'NM' : condition,
                      kind: graded ? 'graded_slab' : 'raw_single',
                      gradingCompany: graded ? gradingCompany : null,
                      grade: graded ? grade : null,
                    },
                  })
                }
              >
                Add to inventory
              </button>
              {card.externalUrl && (
                <a
                  className="btn btn-sm" href={card.externalUrl}
                  target="_blank" rel="noreferrer"
                >
                  Check the catalog
                </a>
              )}
            </div>

            <p className="tiny dim mt" style={{ marginBottom: 0 }}>
              Nothing on this screen is saved. A lookup you decide not to act on leaves no
              trace in your records.
            </p>
          </div>

          {/* Do I already own this? ------------------------------------- */}
          {owned.length > 0 && (
            <div className="card">
              <h2>You already own this</h2>
              <p className="small muted" style={{ marginTop: 4 }}>
                {owned.length} matching item{owned.length === 1 ? '' : 's'} in your inventory.
              </p>
              <div className="scroll-x">
                <table className="data mt">
                  <thead>
                    <tr>
                      <th>Condition</th><th className="num">Available</th>
                      <th className="num">You paid</th><th>Location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {owned.map((o) => (
                      <tr key={o.id}>
                        <td>
                          {o.kind === 'graded_slab'
                            ? `${o.grading_company} ${o.grade}`
                            : CONDITIONS.find((c) => c.value === o.condition)?.label}
                        </td>
                        <td className="num">{o.quantity_available}</td>
                        <td className="num">{formatMoney(o.purchase_cost_cents, currency)}</td>
                        <td>{o.storage_location ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <BatchRefresh settings={settings} />

      {unconfigured.length > 0 && (
        <div className="card">
          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>
              {unconfigured.length} price source
              {unconfigured.length === 1 ? ' is' : 's are'} not connected
            </summary>
            <div className="mt">
              {unconfigured.map((p) => (
                <div key={p.id} className="note note-info" style={{ marginBottom: 6 }}>
                  <strong>{p.label}</strong> — {p.configurationNote}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </>
  );
}

/**
 * Batch price refresh across inventory.
 *
 * Runs sequentially rather than in parallel. These are free, unauthenticated
 * APIs run by volunteers; firing two hundred concurrent requests at them
 * would be rude and would get the app rate-limited, which helps nobody. A
 * small delay between items keeps us inside Scryfall's published guidance.
 */
function BatchRefresh({ settings }: { settings: PricingSettingsRow | null }) {
  const [items, setItems] = useState<InventoryItemFull[] | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<RefreshOutcome[]>([]);
  const cancelRef = useRef(false);

  const staleAfter = settings?.stale_after_days ?? 14;

  const load = useCallback(async () => {
    try {
      setItems(await listInventory({ limit: 2000 }));
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const stale = items ? staleItems(items, staleAfter) : [];

  async function run(batch: InventoryItemFull[]) {
    const userId = await currentUserId();
    cancelRef.current = false;
    setRunning(true);
    setResults([]);
    setDone(0);
    setTotal(batch.length);

    const out: RefreshOutcome[] = [];
    for (const item of batch) {
      if (cancelRef.current) break;
      out.push(await refreshItemPrices(item, userId, settings));
      setDone(out.length);
      setResults([...out]);
      // Be a good citizen of free APIs.
      await new Promise((r) => setTimeout(r, 150));
    }

    setRunning(false);
    load();
  }

  if (!items) return null;

  const priced = results.filter((r) => r.status === 'priced').length;
  const noPrice = results.filter((r) => r.status === 'no_price').length;
  const errored = results.filter((r) => r.status === 'error').length;

  return (
    <div className="card">
      <div className="section-head" style={{ marginBottom: 6 }}>
        <h2>Refresh prices in bulk</h2>
        <span className="sub">
          {items.length} item{items.length === 1 ? '' : 's'} · {stale.length} stale
        </span>
      </div>

      {items.length === 0 ? (
        <p className="small muted" style={{ marginTop: 0 }}>
          Nothing in inventory to refresh yet.
        </p>
      ) : (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            A price counts as stale after {staleAfter} days, or if it has never been
            fetched. Change that in Settings.
          </p>

          <div className="row mt">
            <button
              className="btn btn-primary btn-sm"
              disabled={running || stale.length === 0}
              onClick={() => run(stale)}
            >
              {running && <span className="spinner" />}
              Refresh {stale.length} stale
            </button>
            <button
              className="btn btn-sm"
              disabled={running}
              onClick={() => run(items)}
            >
              Refresh all {items.length}
            </button>
            {running && (
              <button
                className="btn btn-danger btn-sm"
                onClick={() => { cancelRef.current = true; }}
              >
                Stop
              </button>
            )}
          </div>

          {total > 0 && (
            <>
              <div className="row small muted mt">
                <span>{done} of {total} done</span>
                {!running && (
                  <span>
                    · {priced} priced
                    {noPrice > 0 && `, ${noPrice} with no price`}
                    {errored > 0 && `, ${errored} failed`}
                  </span>
                )}
              </div>
              <div
                style={{
                  height: 5, borderRadius: 3, background: 'var(--surface-3)',
                  overflow: 'hidden', marginTop: 6,
                }}
              >
                <div
                  style={{
                    width: `${total ? (done / total) * 100 : 0}%`, height: '100%',
                    background: 'var(--accent)', transition: 'width 0.2s',
                  }}
                />
              </div>
            </>
          )}

          {results.length > 0 && !running && (
            <details className="mt" open={noPrice + errored > 0}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>
                Results
              </summary>
              <div className="scroll-x">
                <table className="data mt">
                  <thead>
                    <tr><th>Card</th><th className="num">Value</th><th>Outcome</th></tr>
                  </thead>
                  <tbody>
                    {results.map((r) => (
                      <tr key={r.itemId}>
                        <td>{r.label}</td>
                        <td className="num">
                          {r.valueCents != null ? formatMoney(r.valueCents) : '—'}
                        </td>
                        <td className="tiny">
                          {r.status === 'priced' ? (
                            <span className={`badge ${
                              CONFIDENCE_BADGE[(r.confidence ?? 'low') as ConfidenceLevel]
                            }`}>
                              {r.confidence}
                            </span>
                          ) : (
                            <span className="muted">
                              {r.messages[0] ?? 'No price available'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          <p className="tiny dim mt" style={{ marginBottom: 0 }}>
            This updates each card&rsquo;s calculated market value. It never changes your
            manual override, asking price or minimum.
          </p>
        </>
      )}
    </div>
  );
}
