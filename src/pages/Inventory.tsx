/**
 * Card Inventory — search, filter and browse physical items.
 *
 * Thumbnails come from the operator's own uploaded photographs. Where no
 * photo exists the catalog image is shown only as a clearly-labelled
 * fallback, never substituted silently for a real photo.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { listInventory, signedUrls, type InventoryItemFull, type InventoryFilters } from '../lib/db';
import { CONDITIONS, type CardCondition, type TcgGame } from '../providers/types';
import { GAMES } from '../providers/registry';
import { formatMoney } from '../lib/money';

export default function Inventory() {
  const [items, setItems] = useState<InventoryItemFull[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [game, setGame] = useState<TcgGame | 'all'>('all');
  const [condition, setCondition] = useState<CardCondition | 'all'>('all');
  const [sort, setSort] = useState<NonNullable<InventoryFilters['sort']>>('newest');

  useEffect(() => {
    let cancelled = false;
    setError(null);

    listInventory({ search, game, condition, sort })
      .then(async (rows) => {
        if (cancelled) return;
        setItems(rows);

        // One signed-URL request for every visible thumbnail rather than one
        // per row; the bucket is private so each image needs signing.
        const paths = rows
          .map((r) => [...r.inventory_images].sort((a, b) => a.sort_order - b.sort_order)[0])
          .filter(Boolean)
          .map((img) => img!.storage_path);
        if (paths.length) {
          const urls = await signedUrls(paths);
          if (!cancelled) setThumbs(urls);
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Could not load inventory.'));

    return () => { cancelled = true; };
  }, [search, game, condition, sort]);

  const totals = useMemo(() => {
    if (!items) return null;
    let cost = 0, value = 0, cards = 0;
    for (const i of items) {
      cost += (i.purchase_cost_cents ?? 0) * i.quantity;
      const v = i.market_value_override_cents ?? i.market_value_cents;
      if (v != null) value += v * i.quantity_available;
      cards += i.quantity;
    }
    return { cost, value, cards };
  }, [items]);

  return (
    <>
      <div className="section-head">
        <h1>Card Inventory</h1>
        <Link className="btn btn-primary btn-sm" to="/scan">+ Add a card</Link>
      </div>

      <div className="card card-tight">
        <input
          type="search" value={search} placeholder="Search name, set, number, SKU or location"
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="row mt" style={{ gap: 7 }}>
          <select value={game} onChange={(e) => setGame(e.target.value as TcgGame | 'all')}
                  style={{ flex: '1 1 130px' }}>
            <option value="all">All games</option>
            {GAMES.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
          <select value={condition} onChange={(e) => setCondition(e.target.value as CardCondition | 'all')}
                  style={{ flex: '1 1 130px' }}>
            <option value="all">Any condition</option>
            {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}
                  style={{ flex: '1 1 130px' }}>
            <option value="newest">Newest first</option>
            <option value="name">Name A–Z</option>
            <option value="value_desc">Highest value</option>
            <option value="cost_desc">Highest cost</option>
            <option value="stale_price">Stalest price</option>
          </select>
        </div>
      </div>

      {totals && items && items.length > 0 && (
        <div className="row small muted mt between">
          <span>
            {items.length} item{items.length === 1 ? '' : 's'} · {totals.cards} card
            {totals.cards === 1 ? '' : 's'}
          </span>
          <span>
            cost {formatMoney(totals.cost)}
            {totals.value > 0 && <> · est. value {formatMoney(totals.value)}</>}
          </span>
        </div>
      )}

      {error && <div className="note note-danger mt">{error}</div>}

      <div className="stack mt" style={{ gap: 7 }}>
        {items === null && [0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 84 }} />
        ))}

        {items?.length === 0 && (
          <div className="empty">
            <div className="big">▤</div>
            <p style={{ fontWeight: 600, color: 'var(--text)' }}>
              {search || game !== 'all' || condition !== 'all'
                ? 'Nothing matches those filters.'
                : 'No cards yet.'}
            </p>
            <p className="small">
              {search || game !== 'all' || condition !== 'all'
                ? 'Try clearing the filters.'
                : 'Scan your first card to get started.'}
            </p>
            <Link className="btn btn-primary btn-sm mt" to="/scan">Scan a card</Link>
          </div>
        )}

        {items?.map((item) => {
          const c = item.card_catalog;
          const first = [...item.inventory_images].sort((a, b) => a.sort_order - b.sort_order)[0];
          const thumb = first ? thumbs[first.storage_path] : undefined;
          const value = item.market_value_override_cents ?? item.market_value_cents;

          return (
            <Link key={item.id} className="item-row" to={`/inventory/${item.id}`}>
              {thumb
                ? <img className="thumb" src={thumb} alt="" loading="lazy" />
                : c?.catalog_image_url
                  ? <img className="thumb" src={c.catalog_image_url} alt="" loading="lazy"
                         style={{ opacity: 0.55 }} title="Catalog image — you have not added a photo" />
                  : <div className="thumb-ph">?</div>}

              <div style={{ minWidth: 0 }}>
                <div className="title">
                  {c?.name ?? 'Needs identification'}
                  {item.quantity > 1 && <span className="muted"> ×{item.quantity}</span>}
                </div>
                <div className="meta">
                  {[c?.set_name, c?.collector_number && `#${c.collector_number}`, c?.finish]
                    .filter(Boolean).join(' · ') || 'No catalog match'}
                </div>
                <div className="row row-tight" style={{ marginTop: 4 }}>
                  {item.kind === 'graded_slab' ? (
                    <span className="badge badge-accent">
                      {item.grading_company} {item.grade}
                    </span>
                  ) : (
                    <span className={`badge${item.condition === 'NEEDS_REVIEW' ? ' badge-warn' : ''}`}>
                      {CONDITIONS.find((x) => x.value === item.condition)?.label ?? item.condition}
                    </span>
                  )}
                  {!c && <span className="badge badge-warn">Needs ID</span>}
                  {item.status !== 'in_stock' && (
                    <span className="badge badge-info">{item.status.replace(/_/g, ' ')}</span>
                  )}
                  {item.storage_location && (
                    <span className="badge">{item.storage_location}</span>
                  )}
                </div>
              </div>

              <div className="right nowrap">
                <div style={{ fontWeight: 650, fontSize: '0.88rem' }}>
                  {value != null ? formatMoney(value) : <span className="dim">—</span>}
                </div>
                <div className="tiny dim">
                  {item.purchase_cost_cents != null
                    ? `cost ${formatMoney(item.purchase_cost_cents)}`
                    : 'cost unknown'}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
