/**
 * Create Listings — generate marketplace copy from a confirmed inventory item.
 *
 * The generator is deterministic, not AI. Every word comes from a fact
 * already saved against the card, which is why it cannot invent a set,
 * rarity, grade or authenticity claim. See lib/listing.ts.
 *
 * Everything it produces is editable before saving, and saving writes a
 * draft — never a live listing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  currentUserId, listInventory, listListings, saveListing,
  type InventoryItemFull, type ListingFull,
} from '../lib/db';
import {
  MARKETPLACES, TEMPLATE_LABELS, generateListing, marketplaceSpec, templateFor,
  type GeneratedListing, type Marketplace,
} from '../lib/listing';
import { CONDITIONS } from '../providers/types';
import { centsToInput, formatMoney, parseMoney } from '../lib/money';

export default function CreateListings() {
  const [items, setItems] = useState<InventoryItemFull[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<InventoryItemFull | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [existing, setExisting] = useState<ListingFull[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUserId(await currentUserId());
      const rows = await listInventory({ limit: 2000 });
      setItems(rows.filter((r) => r.quantity_available > 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load inventory.');
      setItems([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected) { setExisting([]); return; }
    listListings({ inventoryItemId: selected.id }).then(setExisting).catch(() => setExisting([]));
  }, [selected]);

  const results = useMemo(() => {
    if (!items) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return items.slice(0, 20);
    return items.filter((r) => {
      const c = r.card_catalog;
      return [c?.name, c?.set_name, c?.collector_number, r.sku]
        .filter(Boolean).some((f) => String(f).toLowerCase().includes(needle));
    }).slice(0, 40);
  }, [items, query]);

  return (
    <>
      <div className="section-head">
        <h1>Create Listings</h1>
        <Link className="small" to="/crossposting">All listings →</Link>
      </div>

      {error && <div className="note note-danger">{error}</div>}

      <div className="card">
        <h2>1. Pick a card</h2>
        <input
          type="search" className="mt" value={query}
          placeholder="Search your inventory by name, set, number or SKU"
          onChange={(e) => setQuery(e.target.value)}
        />

        {items === null && <div className="skeleton mt" style={{ height: 90 }} />}

        {items !== null && items.length === 0 && (
          <div className="note note-info mt">
            Nothing available to list. Scan some cards first.
          </div>
        )}

        <div className="stack mt" style={{ gap: 5, maxHeight: 280, overflowY: 'auto' }}>
          {results.map((item) => {
            const c = item.card_catalog;
            const on = selected?.id === item.id;
            return (
              <button
                key={item.id} type="button" className="candidate"
                aria-pressed={on}
                style={{ gridTemplateColumns: '1fr auto' }}
                onClick={() => setSelected(on ? null : item)}
              >
                <div>
                  <div style={{ fontWeight: 620, fontSize: '0.87rem' }}>
                    {c?.name ?? 'Unidentified card'}
                  </div>
                  <div className="tiny muted">
                    {[c?.set_name, c?.collector_number && `#${c.collector_number}`,
                      item.kind === 'graded_slab'
                        ? `${item.grading_company} ${item.grade}`
                        : CONDITIONS.find((x) => x.value === item.condition)?.label,
                      item.asking_price_cents != null
                        ? `asking ${formatMoney(item.asking_price_cents)}`
                        : 'no asking price',
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span className={`badge ${on ? 'badge-accent' : ''}`}>
                  {on ? 'Selected' : 'Select'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {selected && userId && (
        <ListingBuilder
          key={selected.id}
          item={selected}
          userId={userId}
          existing={existing}
          onSaved={() => listListings({ inventoryItemId: selected.id }).then(setExisting)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function ListingBuilder({
  item, userId, existing, onSaved,
}: {
  item: InventoryItemFull;
  userId: string;
  existing: ListingFull[];
  onSaved: () => void;
}) {
  const [chosen, setChosen] = useState<Set<Marketplace>>(new Set(['ebay']));
  const [drafts, setDrafts] = useState<Record<string, GeneratedListing>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const template = templateFor(item);
  const unpriced = item.asking_price_cents == null;

  const generate = useCallback(() => {
    const next: Record<string, GeneratedListing> = {};
    const nextPrices: Record<string, string> = {};
    for (const m of chosen) {
      next[m] = generateListing(item, m);
      const prior = existing.find((e) => e.marketplace === m);
      nextPrices[m] = centsToInput(prior?.price_cents ?? item.asking_price_cents);
    }
    setDrafts(next);
    setPrices(nextPrices);
    setSaved(null);
  }, [chosen, item, existing]);

  // Generate on first render and whenever the marketplace selection changes.
  useEffect(() => { generate(); }, [generate]);

  function toggle(m: Marketplace) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  }

  function patch(m: Marketplace, field: keyof GeneratedListing, value: string) {
    setDrafts((prev) => ({ ...prev, [m]: { ...prev[m], [field]: value } }));
  }

  async function saveAll() {
    setSaving(true);
    setError(null);
    try {
      for (const m of chosen) {
        const d = drafts[m];
        if (!d) continue;
        await saveListing({
          inventoryItemId: item.id,
          marketplace: m,
          title: d.title,
          description: d.description,
          category: d.category,
          conditionText: d.conditionText,
          keywords: d.keywords,
          shippingNotes: d.shippingNotes,
          currency: item.currency,
          priceCents: parseMoney(prices[m] ?? ''),
          status: 'ready_to_publish',
        }, userId);
      }
      setSaved(`Saved ${chosen.size} draft${chosen.size === 1 ? '' : 's'}.`);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save those drafts.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="card">
        <div className="section-head" style={{ marginBottom: 6 }}>
          <h2>2. Choose marketplaces</h2>
          <span className="badge badge-info">{TEMPLATE_LABELS[template]} template</span>
        </div>

        <div className="seg mt">
          {MARKETPLACES.map((m) => (
            <button
              key={m.id} type="button"
              aria-pressed={chosen.has(m.id)}
              onClick={() => toggle(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {unpriced && (
          <div className="note note-warn mt">
            This card has no asking price set. You can type one per marketplace below,
            or set it on the <Link to={`/inventory/${item.id}`}>item page</Link> first.
          </div>
        )}

        <div className="row mt">
          <button className="btn btn-sm" onClick={generate}>Regenerate</button>
          <span className="tiny dim">
            Regenerating replaces the text below. Your saved drafts are untouched until
            you save again.
          </span>
        </div>
      </div>

      {[...chosen].map((m) => {
        const d = drafts[m];
        if (!d) return null;
        const spec = marketplaceSpec(m);
        const prior = existing.find((e) => e.marketplace === m);

        return (
          <div className="card" key={m}>
            <div className="section-head" style={{ marginBottom: 6 }}>
              <h2>{spec.label}</h2>
              {prior && (
                <span className="badge badge-info">
                  draft saved {new Date(prior.updated_at).toLocaleDateString()}
                </span>
              )}
            </div>

            <label className="field mt">
              <span className="label-text">
                Title{' '}
                <span className={d.title.length > spec.titleLimit ? 'badge badge-danger' : 'dim'}>
                  {d.title.length}/{spec.titleLimit}
                </span>
              </span>
              <input
                type="text" value={d.title}
                onChange={(e) => patch(m, 'title', e.target.value)}
              />
              {d.titleTruncated && (
                <span className="hint">
                  Shortened to fit {spec.label}&rsquo;s limit. Check nothing important
                  was cut.
                </span>
              )}
            </label>

            <div className="grid grid-2">
              <label className="field">
                <span className="label-text">Price</span>
                <input
                  type="text" inputMode="decimal" value={prices[m] ?? ''} placeholder="0.00"
                  onChange={(e) => setPrices((p) => ({ ...p, [m]: e.target.value }))}
                />
                <span className="hint">You can price differently per marketplace.</span>
              </label>
              <label className="field">
                <span className="label-text">Category</span>
                <input
                  type="text" value={d.category}
                  onChange={(e) => patch(m, 'category', e.target.value)}
                />
              </label>
            </div>

            <label className="field">
              <span className="label-text">
                Description{' '}
                <span className="dim">{d.description.length}/{spec.descriptionLimit}</span>
              </span>
              <textarea
                value={d.description} style={{ minHeight: 170 }}
                onChange={(e) => patch(m, 'description', e.target.value)}
              />
            </label>

            <label className="field">
              <span className="label-text">Shipping notes</span>
              <input
                type="text" value={d.shippingNotes}
                onChange={(e) => patch(m, 'shippingNotes', e.target.value)}
              />
            </label>

            <details>
              <summary className="small muted" style={{ cursor: 'pointer' }}>
                {d.keywords.length} search keywords
              </summary>
              <div className="row row-tight mt">
                {d.keywords.map((k) => <span key={k} className="badge">{k}</span>)}
              </div>
            </details>

            <div className="note note-info mt">{spec.note}</div>
          </div>
        );
      })}

      {chosen.size > 0 && (
        <>
          {error && <div className="note note-danger mt">{error}</div>}
          {saved && <div className="note note-ok mt">{saved} <Link to="/crossposting">View them</Link></div>}
          <div className="sticky-actions mt">
            <button className="btn btn-primary" onClick={saveAll} disabled={saving}>
              {saving && <span className="spinner" />}
              Save {chosen.size} draft{chosen.size === 1 ? '' : 's'}
            </button>
          </div>
          <p className="tiny dim mt">
            Saving stores a draft. Nothing is posted anywhere — go to Cross-Posting to
            copy the text into each marketplace.
          </p>
        </>
      )}
    </>
  );
}
