/**
 * Card Show Mode — fast lookup while standing behind a table.
 *
 * Optimised for one-handed phone use under time pressure, which drives every
 * decision here: a single always-focused search box, large tap targets, the
 * three numbers that matter (asking price, what you paid, where it is) on one
 * line, and a sale recordable in two taps.
 *
 * Deliberately different from the Inventory screen: that one is for browsing
 * and editing, this one is for answering "how much?" in under five seconds
 * while someone waits.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import RecordSaleDialog from '../components/RecordSaleDialog';
import {
  currentUserId, listInventory, listSales, signedUrls,
  type InventoryItemFull, type SaleFull,
} from '../lib/db';
import { CONDITIONS, type TcgGame } from '../providers/types';
import { GAMES } from '../providers/registry';
import { formatMoney } from '../lib/money';
import { saleTotals } from '../lib/profit';

/** Today's date at midnight, as an ISO string. */
function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function CardShow() {
  const [query, setQuery] = useState('');
  const [game, setGame] = useState<TcgGame | 'all'>('all');
  const [items, setItems] = useState<InventoryItemFull[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selling, setSelling] = useState<InventoryItemFull | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [todaySales, setTodaySales] = useState<SaleFull[]>([]);

  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const uid = await currentUserId();
      setUserId(uid);
      const [rows, sales] = await Promise.all([
        listInventory({ limit: 2000 }),
        listSales({ from: startOfToday() }),
      ]);
      // Only stock that can actually be sold appears at a show.
      setItems(rows.filter((r) => r.quantity_available > 0));
      setTodaySales(sales.filter((s) => s.channel === 'card_show'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load inventory.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { searchRef.current?.focus(); }, []);

  // Filtering happens in memory: a personal inventory is small, and a round
  // trip per keystroke is exactly the latency this screen cannot afford.
  const results = useMemo(() => {
    if (!items) return [];
    const needle = query.trim().toLowerCase();
    let rows = items;

    if (game !== 'all') rows = rows.filter((r) => r.card_catalog?.game === game);
    if (needle) {
      rows = rows.filter((r) => {
        const c = r.card_catalog;
        return [
          c?.name, c?.set_name, c?.set_code, c?.collector_number,
          r.sku, r.cert_number, r.storage_location,
        ].filter(Boolean).some((f) => String(f).toLowerCase().includes(needle));
      });
    }
    // Highest asking price first: the expensive cards are the ones you are
    // most often asked about, and the ones you least want to misprice.
    return rows
      .slice()
      .sort((a, b) => (b.asking_price_cents ?? 0) - (a.asking_price_cents ?? 0))
      .slice(0, 60);
  }, [items, query, game]);

  // Sign thumbnails only for what is on screen.
  useEffect(() => {
    const paths = results
      .map((r) => [...r.inventory_images].sort((x, y) => x.sort_order - y.sort_order)[0])
      .filter(Boolean)
      .map((img) => img!.storage_path)
      .filter((p) => !(p in thumbs));
    if (paths.length === 0) return;
    let cancelled = false;
    signedUrls(paths)
      .then((urls) => { if (!cancelled) setThumbs((prev) => ({ ...prev, ...urls })); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [results, thumbs]);

  const todayTotals = useMemo(() => {
    let gross = 0, net = 0, cards = 0;
    for (const s of todaySales) {
      const t = saleTotals(s, s.items);
      gross += t.grossCents;
      net += t.netCents;
      for (const l of s.items) cards += l.quantity;
    }
    return { gross, net, cards, count: todaySales.length };
  }, [todaySales]);

  return (
    <>
      <div className="section-head">
        <h1>Card Show Mode</h1>
        <span className="sub">{items?.length ?? 0} available</span>
      </div>

      {/* Today's takings — the number you want at a glance between customers */}
      <div className="stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="stat">
          <div className="k">Today</div>
          <div className="v">{formatMoney(todayTotals.gross)}</div>
          <div className="m">{todayTotals.count} sale{todayTotals.count === 1 ? '' : 's'}</div>
        </div>
        <div className="stat">
          <div className="k">Profit</div>
          <div className="v" style={{
            color: todayTotals.net >= 0 ? 'var(--ok)' : 'var(--danger)',
          }}>
            {formatMoney(todayTotals.net)}
          </div>
          <div className="m">after cost</div>
        </div>
        <div className="stat">
          <div className="k">Cards</div>
          <div className="v">{todayTotals.cards}</div>
          <div className="m">sold today</div>
        </div>
      </div>

      {flash && <div className="note note-ok mt">{flash}</div>}
      {error && <div className="note note-danger mt">{error}</div>}

      {/* Search ---------------------------------------------------------- */}
      <div className="card card-tight mt" style={{ position: 'sticky', top: 'var(--nav-h)', zIndex: 10 }}>
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Name, set, number, SKU or cert"
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          style={{ fontSize: 17 }}
        />
        <div className="seg mt">
          <button type="button" aria-pressed={game === 'all'} onClick={() => setGame('all')}>
            All
          </button>
          {GAMES.filter((g) => items?.some((i) => i.card_catalog?.game === g.value))
            .map((g) => (
              <button
                key={g.value} type="button"
                aria-pressed={game === g.value}
                onClick={() => setGame(g.value)}
              >
                {g.label}
              </button>
            ))}
        </div>
      </div>

      {/* Results --------------------------------------------------------- */}
      <div className="stack mt" style={{ gap: 7 }}>
        {items === null && [0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 76 }} />
        ))}

        {items !== null && results.length === 0 && (
          <div className="empty">
            <p style={{ fontWeight: 600, color: 'var(--text)' }}>
              {query ? 'Nothing matches that.' : 'No stock available to sell.'}
            </p>
            <p className="small">
              {query
                ? 'Try the collector number or SKU instead.'
                : 'Cards already sold or fully allocated are hidden here.'}
            </p>
          </div>
        )}

        {results.map((item) => {
          const c = item.card_catalog;
          const first = [...item.inventory_images]
            .sort((a, b) => a.sort_order - b.sort_order)[0];
          const thumb = first ? thumbs[first.storage_path] : undefined;
          const ask = item.asking_price_cents;
          const value = item.market_value_override_cents ?? item.market_value_cents;

          return (
            <div key={item.id} className="item-row" style={{ cursor: 'default' }}>
              {thumb
                ? <img className="thumb" src={thumb} alt="" loading="lazy" />
                : c?.catalog_image_url
                  ? <img className="thumb" src={c.catalog_image_url} alt="" loading="lazy"
                         style={{ opacity: 0.55 }} />
                  : <div className="thumb-ph">?</div>}

              <div style={{ minWidth: 0 }}>
                <div className="title">
                  {c?.name ?? 'Unidentified card'}
                  {item.quantity_available > 1 && (
                    <span className="muted"> ×{item.quantity_available}</span>
                  )}
                </div>
                <div className="meta">
                  {[c?.set_name, c?.collector_number && `#${c.collector_number}`, c?.finish]
                    .filter(Boolean).join(' · ') || '—'}
                </div>
                <div className="row row-tight" style={{ marginTop: 4 }}>
                  {item.kind === 'graded_slab' ? (
                    <span className="badge badge-accent">
                      {item.grading_company} {item.grade}
                    </span>
                  ) : (
                    <span className="badge">
                      {CONDITIONS.find((x) => x.value === item.condition)?.label}
                    </span>
                  )}
                  {item.storage_location && (
                    <span className="badge badge-info">{item.storage_location}</span>
                  )}
                </div>
              </div>

              <div className="right nowrap">
                <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>
                  {ask != null
                    ? formatMoney(ask, item.currency as 'USD')
                    : <span className="dim" style={{ fontSize: '0.85rem' }}>no price</span>}
                </div>
                <div className="tiny dim">
                  {item.purchase_cost_cents != null
                    ? `paid ${formatMoney(item.purchase_cost_cents, item.currency as 'USD')}`
                    : 'cost unknown'}
                  {value != null && ask == null && (
                    <> · est {formatMoney(value, item.currency as 'USD')}</>
                  )}
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ marginTop: 5 }}
                  onClick={() => setSelling(item)}
                >
                  Sell
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {results.length > 0 && (
        <p className="tiny dim mt">
          Showing the {results.length} highest-priced match
          {results.length === 1 ? '' : 'es'}. Minimum acceptable prices are on each
          item&rsquo;s page — this screen shows what you are asking.
        </p>
      )}

      {selling && userId && (
        <RecordSaleDialog
          item={selling}
          userId={userId}
          defaultChannel="card_show"
          onClose={() => setSelling(null)}
          onSaved={() => {
            const name = selling.card_catalog?.name ?? 'Card';
            setSelling(null);
            setFlash(`${name} sold. Inventory updated.`);
            setTimeout(() => setFlash(null), 4000);
            load();
            searchRef.current?.focus();
            setQuery('');
          }}
        />
      )}
    </>
  );
}
