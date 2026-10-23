/**
 * Bulk & Lots — group physical cards and sell them as one unit.
 *
 * The thing that makes lots dangerous is allocation. A card committed to a
 * lot must stop being available for individual sale, or you will sell the
 * same physical card twice. That is enforced by the quantity ledger:
 * allocating increments quantity_allocated, and quantity_available is a
 * generated column that cannot go below zero. So a card already in a lot
 * simply cannot be added to another one.
 *
 * Bulk *groups* (a shoebox of commons priced as a unit) are a different
 * thing and live in inventory as kind "bulk_group" — create those from Scan.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  addItemsToLot, createLot, currentUserId, deleteLot, listInventory, listLots,
  recordLotSale, removeItemFromLot, updateLot,
  SALE_CHANNELS,
  type InventoryItemFull, type LotFull, type SaleChannel,
} from '../lib/db';
import { CONDITIONS, type TcgGame } from '../providers/types';
import { GAMES } from '../providers/registry';
import { centsToInput, formatMoney, parseMoney } from '../lib/money';

export default function Lots() {
  const [lots, setLots] = useState<LotFull[] | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUserId(await currentUserId());
      setLots(await listLots({ status: 'all' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load lots.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const open = lots?.find((l) => l.id === openId) ?? null;

  return (
    <>
      <div className="section-head">
        <h1>Bulk &amp; Lots</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          + New lot
        </button>
      </div>

      {error && <div className="note note-danger">{error}</div>}

      {lots === null && <div className="skeleton" style={{ height: 120 }} />}

      {lots?.length === 0 && (
        <div className="empty">
          <div className="big">▦</div>
          <p style={{ fontWeight: 600, color: 'var(--text)' }}>No lots yet.</p>
          <p className="small">
            A lot bundles specific cards from your inventory to sell as one unit.
            Cards you add stop being available individually, so you cannot
            accidentally sell them twice.
          </p>
          <button className="btn btn-primary btn-sm mt" onClick={() => setCreating(true)}>
            Create your first lot
          </button>
        </div>
      )}

      <div className="stack mt" style={{ gap: 7 }}>
        {lots?.map((lot) => (
          <div key={lot.id} className="card card-tight" style={{ marginTop: 0 }}>
            <div className="row between">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: '0.92rem' }}>{lot.title}</div>
                <div className="tiny muted">
                  {lot.allocatedCount} card{lot.allocatedCount === 1 ? '' : 's'}
                  {' · cost '}{formatMoney(lot.totalCostCents, lot.currency as 'USD')}
                  {lot.costIncomplete && ' (partly unknown)'}
                  {lot.storage_location && ` · ${lot.storage_location}`}
                </div>
                <div className="row row-tight" style={{ marginTop: 4 }}>
                  <span className={`badge ${
                    lot.status === 'sold' ? 'badge-ok'
                      : lot.status === 'listed' ? 'badge-info' : ''
                  }`}>
                    {lot.status.replace(/_/g, ' ')}
                  </span>
                  {lot.game && (
                    <span className="badge">
                      {GAMES.find((g) => g.value === lot.game)?.label ?? lot.game}
                    </span>
                  )}
                </div>
              </div>
              <div className="right nowrap">
                <div style={{ fontWeight: 650 }}>
                  {lot.asking_price_cents != null
                    ? formatMoney(lot.asking_price_cents, lot.currency as 'USD')
                    : <span className="dim small">no price</span>}
                </div>
                <button
                  className="btn btn-sm"
                  style={{ marginTop: 5 }}
                  onClick={() => setOpenId(openId === lot.id ? null : lot.id)}
                >
                  {openId === lot.id ? 'Close' : 'Open'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {open && userId && (
        <LotDetail
          lot={open}
          userId={userId}
          onChanged={load}
          onClose={() => setOpenId(null)}
        />
      )}

      {creating && userId && (
        <CreateLotDialog
          userId={userId}
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await load();
            setOpenId(id);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function CreateLotDialog({
  userId, onClose, onCreated,
}: {
  userId: string; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [game, setGame] = useState<TcgGame | ''>('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New lot</h2>
        <p className="small muted mt">
          Create the lot first, then add cards to it from your inventory.
        </p>

        <label className="field mt">
          <span className="label-text">Title</span>
          <input
            type="text" value={title} autoFocus
            placeholder="e.g. Base Set commons bundle"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <div className="grid grid-2">
          <label className="field">
            <span className="label-text">Game</span>
            <select value={game} onChange={(e) => setGame(e.target.value as TcgGame | '')}>
              <option value="">Mixed / unspecified</option>
              {GAMES.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="label-text">Storage location</span>
            <input
              type="text" value={location} placeholder="e.g. Box 7"
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>
        </div>

        <label className="field">
          <span className="label-text">Description</span>
          <textarea
            value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="What is in this lot?"
          />
        </label>

        {error && <div className="note note-danger mt">{error}</div>}

        <div className="row mt">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || !title.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const lot = await createLot({
                  title,
                  game: game || null,
                  currency: 'USD',
                  storageLocation: location || null,
                  description: description || null,
                }, userId);
                onCreated(lot.id);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not create the lot.');
                setBusy(false);
              }
            }}
          >
            {busy && <span className="spinner" />} Create lot
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function LotDetail({
  lot, userId, onChanged, onClose,
}: {
  lot: LotFull; userId: string; onChanged: () => Promise<void>; onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [selling, setSelling] = useState(false);
  const [asking, setAsking] = useState(centsToInput(lot.asking_price_cents));
  const [minimum, setMinimum] = useState(centsToInput(lot.minimum_price_cents));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sold = lot.status === 'sold';
  const margin = lot.asking_price_cents != null
    ? lot.asking_price_cents - lot.totalCostCents
    : null;

  return (
    <div className="card">
      <div className="section-head" style={{ marginBottom: 6 }}>
        <h2>{lot.title}</h2>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>

      {lot.description && <p className="small muted" style={{ marginTop: 0 }}>{lot.description}</p>}
      {error && <div className="note note-danger mt">{error}</div>}

      {sold && (
        <div className="note note-ok mt">
          This lot has been sold. Its cards are marked sold in inventory.
        </div>
      )}

      {/* Economics ------------------------------------------------------ */}
      <div className="stats mt" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="stat">
          <div className="k">Cards</div>
          <div className="v">{lot.allocatedCount}</div>
          <div className="m">{lot.items.length} line{lot.items.length === 1 ? '' : 's'}</div>
        </div>
        <div className="stat">
          <div className="k">Cost basis</div>
          <div className="v">{formatMoney(lot.totalCostCents, lot.currency as 'USD')}</div>
          <div className="m">{lot.costIncomplete ? 'partly unknown' : 'what you paid'}</div>
        </div>
        <div className="stat">
          <div className="k">If sold at ask</div>
          <div className="v" style={{
            color: margin == null ? undefined : margin >= 0 ? 'var(--ok)' : 'var(--danger)',
          }}>
            {margin != null ? formatMoney(margin, lot.currency as 'USD') : '—'}
          </div>
          <div className="m">before fees</div>
        </div>
      </div>

      {/* Allocated cards ------------------------------------------------ */}
      <div className="section-head mt" style={{ marginBottom: 6 }}>
        <h3>Cards in this lot</h3>
        {!sold && (
          <button className="btn btn-sm" onClick={() => setAdding(true)}>+ Add cards</button>
        )}
      </div>

      {lot.items.length === 0 ? (
        <p className="small dim">
          Nothing allocated yet. Adding a card removes it from individual availability.
        </p>
      ) : (
        <div className="scroll-x">
          <table className="data">
            <thead>
              <tr>
                <th>Card</th><th>Condition</th>
                <th className="num">Qty</th><th className="num">Cost</th><th />
              </tr>
            </thead>
            <tbody>
              {lot.items.map((line) => (
                <tr key={line.id}>
                  <td>
                    {line.card_name ?? 'Unidentified'}
                    {line.set_name && <span className="dim"> · {line.set_name}</span>}
                  </td>
                  <td className="tiny">
                    {line.kind === 'graded_slab'
                      ? `${line.grading_company} ${line.grade}`
                      : CONDITIONS.find((c) => c.value === line.condition)?.label ?? '—'}
                  </td>
                  <td className="num">{line.quantity}</td>
                  <td className="num">
                    {line.unit_cost_cents != null
                      ? formatMoney(line.unit_cost_cents * line.quantity, lot.currency as 'USD')
                      : <span className="dim">?</span>}
                  </td>
                  <td>
                    {!sold && (
                      <button
                        className="btn btn-ghost btn-sm"
                        aria-label="Remove from lot"
                        onClick={async () => {
                          await removeItemFromLot(line.id, userId);
                          await onChanged();
                        }}
                      >×</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pricing -------------------------------------------------------- */}
      {!sold && (
        <>
          <h3 className="mt">Lot price</h3>
          <div className="grid grid-2">
            <label className="field">
              <span className="label-text">Asking price</span>
              <input
                type="text" inputMode="decimal" value={asking} placeholder="0.00"
                onChange={(e) => setAsking(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="label-text">Minimum accepted</span>
              <input
                type="text" inputMode="decimal" value={minimum} placeholder="0.00"
                onChange={(e) => setMinimum(e.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <button
              className="btn btn-sm"
              onClick={async () => {
                setError(null);
                try {
                  await updateLot(lot.id, {
                    asking_price_cents: parseMoney(asking),
                    minimum_price_cents: parseMoney(minimum),
                  });
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2000);
                  await onChanged();
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not save.');
                }
              }}
            >
              Save price
            </button>
            {saved && <span className="badge badge-ok">Saved</span>}
          </div>

          <div className="row mt">
            <button
              className="btn btn-primary btn-sm"
              disabled={lot.items.length === 0}
              onClick={() => setSelling(true)}
            >
              Record lot sale
            </button>
            <button
              className="btn btn-danger btn-sm"
              onClick={async () => {
                if (!confirm(
                  `Delete "${lot.title}"? Its ${lot.allocatedCount} card`
                  + `${lot.allocatedCount === 1 ? '' : 's'} return to available inventory.`
                )) return;
                await deleteLot(lot.id, userId);
                onClose();
                await onChanged();
              }}
            >
              Delete lot
            </button>
          </div>
          {lot.items.length === 0 && (
            <p className="tiny dim mt">Add at least one card before recording a sale.</p>
          )}
        </>
      )}

      {adding && (
        <AddCardsDialog
          lot={lot}
          userId={userId}
          onClose={() => setAdding(false)}
          onAdded={async () => { setAdding(false); await onChanged(); }}
        />
      )}

      {selling && (
        <SellLotDialog
          lot={lot}
          userId={userId}
          onClose={() => setSelling(false)}
          onSold={async () => { setSelling(false); await onChanged(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AddCardsDialog({
  lot, userId, onClose, onAdded,
}: {
  lot: LotFull; userId: string; onClose: () => void; onAdded: () => Promise<void>;
}) {
  const [items, setItems] = useState<InventoryItemFull[] | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    listInventory({ limit: 2000 })
      // Only genuinely available stock can be allocated.
      .then((rows) => setItems(rows.filter((r) => r.quantity_available > 0)))
      .catch(() => setItems([]));
  }, []);

  const inLot = useMemo(
    () => new Set(lot.items.map((l) => l.inventory_item_id)),
    [lot.items]
  );

  const results = useMemo(() => {
    if (!items) return [];
    const needle = query.trim().toLowerCase();
    return items
      .filter((r) => !inLot.has(r.id))
      .filter((r) => {
        if (!needle) return true;
        const c = r.card_catalog;
        return [c?.name, c?.set_name, c?.collector_number, r.sku]
          .filter(Boolean).some((f) => String(f).toLowerCase().includes(needle));
      })
      .slice(0, 80);
  }, [items, query, inLot]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h2>Add cards to &ldquo;{lot.title}&rdquo;</h2>
        <p className="small muted mt">
          Only cards with available stock are shown. Adding one reserves it — it stops
          appearing in Card Show Mode and cannot be added to another lot.
        </p>

        <input
          type="search" value={query} placeholder="Filter by name, set, number or SKU"
          className="mt" onChange={(e) => setQuery(e.target.value)}
        />

        {items === null && <div className="skeleton mt" style={{ height: 120 }} />}

        {items !== null && results.length === 0 && (
          <p className="small dim mt">
            {query ? 'Nothing matches that filter.' : 'No available cards to add.'}
          </p>
        )}

        <div className="stack mt" style={{ gap: 5, maxHeight: '40vh', overflowY: 'auto' }}>
          {results.map((item) => {
            const c = item.card_catalog;
            const on = picked.has(item.id);
            return (
              <button
                key={item.id} type="button" className="candidate"
                aria-pressed={on}
                style={{ gridTemplateColumns: '1fr auto' }}
                onClick={() => toggle(item.id)}
              >
                <div>
                  <div style={{ fontWeight: 620, fontSize: '0.86rem' }}>
                    {c?.name ?? 'Unidentified card'}
                  </div>
                  <div className="tiny muted">
                    {[c?.set_name, c?.collector_number && `#${c.collector_number}`,
                      item.kind === 'graded_slab'
                        ? `${item.grading_company} ${item.grade}`
                        : CONDITIONS.find((x) => x.value === item.condition)?.label,
                      `${item.quantity_available} available`,
                      item.purchase_cost_cents != null
                        ? `paid ${formatMoney(item.purchase_cost_cents)}`
                        : 'cost unknown',
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span className={`badge ${on ? 'badge-accent' : ''}`}>
                  {on ? 'Selected' : 'Add'}
                </span>
              </button>
            );
          })}
        </div>

        {result && <div className="note note-warn mt">{result}</div>}

        <div className="row mt">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || picked.size === 0}
            onClick={async () => {
              setBusy(true);
              setResult(null);
              try {
                const res = await addItemsToLot(
                  lot.id,
                  [...picked].map((id) => ({ inventoryItemId: id, quantity: 1 })),
                  userId
                );
                if (res.skipped.length > 0) {
                  setResult(
                    `${res.added} added. ${res.skipped.length} skipped: ` +
                    res.skipped.map((s) => s.reason).join('; ')
                  );
                  setPicked(new Set());
                  setBusy(false);
                  return;
                }
                await onAdded();
              } catch (e) {
                setResult(e instanceof Error ? e.message : 'Could not add those cards.');
                setBusy(false);
              }
            }}
          >
            {busy && <span className="spinner" />} Add {picked.size || ''} card
            {picked.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SellLotDialog({
  lot, userId, onClose, onSold,
}: {
  lot: LotFull; userId: string; onClose: () => void; onSold: () => Promise<void>;
}) {
  const [channel, setChannel] = useState<SaleChannel>('ebay');
  const [soldAt, setSoldAt] = useState(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  });
  const [price, setPrice] = useState(centsToInput(lot.asking_price_cents));
  const [fee, setFee] = useState('');
  const [shipping, setShipping] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = parseMoney(price);
  const fees = (parseMoney(fee) ?? 0) + (parseMoney(shipping) ?? 0);
  const net = cents != null ? cents - lot.totalCostCents - fees : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Sell the whole lot</h2>
        <p className="small muted mt">
          {lot.allocatedCount} card{lot.allocatedCount === 1 ? '' : 's'} will be marked sold
          in inventory.
        </p>

        <div className="grid grid-2 mt">
          <label className="field">
            <span className="label-text">Sold on</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value as SaleChannel)}>
              {SALE_CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label-text">Date and time</span>
            <input type="datetime-local" value={soldAt}
                   onChange={(e) => setSoldAt(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span className="label-text">Sale price</span>
          <input type="text" inputMode="decimal" value={price} placeholder="0.00"
                 autoFocus onChange={(e) => setPrice(e.target.value)} />
        </label>

        <div className="grid grid-2">
          <label className="field">
            <span className="label-text">Marketplace fee</span>
            <input type="text" inputMode="decimal" value={fee} placeholder="0.00"
                   onChange={(e) => setFee(e.target.value)} />
          </label>
          <label className="field">
            <span className="label-text">Postage you paid</span>
            <input type="text" inputMode="decimal" value={shipping} placeholder="0.00"
                   onChange={(e) => setShipping(e.target.value)} />
          </label>
        </div>

        {cents != null && (
          <div className="card card-tight" style={{ background: 'var(--surface-2)' }}>
            <div className="row between">
              <span className="small muted">Sale price</span>
              <span className="small mono">{formatMoney(cents, lot.currency as 'USD')}</span>
            </div>
            <div className="row between">
              <span className="small muted">
                Cost of cards
                {lot.costIncomplete && (
                  <span className="badge badge-warn" style={{ marginLeft: 5 }}>partly unknown</span>
                )}
              </span>
              <span className="small mono">
                −{formatMoney(lot.totalCostCents, lot.currency as 'USD')}
              </span>
            </div>
            <div className="row between">
              <span className="small muted">Fees and postage</span>
              <span className="small mono">−{formatMoney(fees, lot.currency as 'USD')}</span>
            </div>
            <div className="row between" style={{
              borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6,
            }}>
              <strong className="small">Net profit</strong>
              <strong className="mono" style={{
                color: (net ?? 0) >= 0 ? 'var(--ok)' : 'var(--danger)',
              }}>
                {formatMoney(net, lot.currency as 'USD')}
              </strong>
            </div>
          </div>
        )}

        {error && <div className="note note-danger mt">{error}</div>}

        <div className="row mt">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || cents == null}
            onClick={async () => {
              if (cents == null) return;
              setBusy(true);
              setError(null);
              try {
                await recordLotSale(lot.id, {
                  channel,
                  soldAt: new Date(soldAt).toISOString(),
                  currency: lot.currency,
                  salePriceCents: cents,
                  marketplaceFeeCents: parseMoney(fee) ?? 0,
                  shippingCostCents: parseMoney(shipping) ?? 0,
                }, userId);
                await onSold();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not record that sale.');
                setBusy(false);
              }
            }}
          >
            {busy && <span className="spinner" />} Record lot sale
          </button>
        </div>
      </div>
    </div>
  );
}
