/**
 * Record a sale against one inventory item.
 *
 * The profit preview updates as you type, using the same `saleTotals` the
 * dashboard uses -- so the number you approve here is literally the number
 * that lands in the ledger, not a separate estimate that might disagree.
 *
 * Unknown cost is shown as unknown. A card with no recorded purchase cost
 * produces a profit figure flagged as optimistic rather than quietly treating
 * cost as zero, which would overstate every margin in the business.
 */
import { useMemo, useState } from 'react';

import {
  recordSale, SALE_CHANNELS,
  type InventoryItemFull, type NewSale, type SaleChannel,
} from '../lib/db';
import { centsToInput, formatMoney, parseMoney } from '../lib/money';
import { marginPercent, saleTotals } from '../lib/profit';

/** Local datetime string for an <input type="datetime-local">. */
function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export default function RecordSaleDialog({
  item, userId, onClose, onSaved, defaultChannel = 'ebay',
}: {
  item: InventoryItemFull;
  userId: string;
  onClose: () => void;
  onSaved: (warnings: string[]) => void;
  /** Card Show Mode opens this pre-set to a cash sale at the table. */
  defaultChannel?: SaleChannel;
}) {
  const [channel, setChannel] = useState<SaleChannel>(defaultChannel);
  const [soldAt, setSoldAt] = useState(localNow);
  const [quantity, setQuantity] = useState('1');

  const [price, setPrice] = useState(centsToInput(item.asking_price_cents));
  const [shippingCharged, setShippingCharged] = useState('');
  const [marketplaceFee, setMarketplaceFee] = useState('');
  const [shippingCost, setShippingCost] = useState('');
  const [packaging, setPackaging] = useState('');
  const [otherFee, setOtherFee] = useState('');
  const [note, setNote] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qty = Math.max(1, Number(quantity) || 1);
  const priceCents = parseMoney(price);

  // Preview uses the real aggregation function, not a parallel calculation.
  const preview = useMemo(() => {
    if (priceCents == null) return null;
    const soldIso = new Date(soldAt).toISOString();
    return saleTotals(
      {
        id: '', user_id: '', channel, sold_at: soldIso, buyer_note: null,
        currency: item.currency,
        sale_price_cents: priceCents,
        shipping_charged_cents: parseMoney(shippingCharged) ?? 0,
        marketplace_fee_cents: parseMoney(marketplaceFee) ?? 0,
        shipping_cost_cents: parseMoney(shippingCost) ?? 0,
        packaging_cost_cents: parseMoney(packaging) ?? 0,
        other_fee_cents: parseMoney(otherFee) ?? 0,
        refund_cents: 0,
        needs_review: false, review_reason: null,
        created_at: '', updated_at: '',
      },
      [{
        id: '', user_id: '', sale_id: '', inventory_item_id: item.id, lot_id: null,
        quantity: qty,
        unit_cost_cents: item.purchase_cost_cents,
        unit_price_cents: priceCents,
        created_at: '',
      }]
    );
  }, [
    priceCents, shippingCharged, marketplaceFee, shippingCost, packaging, otherFee,
    qty, channel, soldAt, item,
  ]);

  const feeShare = preview && preview.grossCents > 0
    ? (preview.feesCents / preview.grossCents) * 100
    : null;

  const maxQty = item.kind === 'graded_slab' ? 1 : item.quantity_available;
  const tooMany = qty > maxQty;

  async function save() {
    if (priceCents == null) { setError('Enter the price this sold for.'); return; }
    setBusy(true);
    setError(null);
    try {
      const payload: NewSale = {
        channel,
        soldAt: new Date(soldAt).toISOString(),
        currency: item.currency,
        salePriceCents: priceCents,
        shippingChargedCents: parseMoney(shippingCharged) ?? 0,
        marketplaceFeeCents: parseMoney(marketplaceFee) ?? 0,
        shippingCostCents: parseMoney(shippingCost) ?? 0,
        packagingCostCents: parseMoney(packaging) ?? 0,
        otherFeeCents: parseMoney(otherFee) ?? 0,
        buyerNote: note || null,
        items: [{ inventoryItemId: item.id, quantity: qty, unitPriceCents: priceCents }],
      };
      const { warnings } = await recordSale(payload, userId);
      onSaved(warnings);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that sale.');
      setBusy(false);
    }
  }

  const name = item.card_catalog?.name ?? 'Unidentified card';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Record a sale</h2>
        <p className="small muted mt" style={{ marginBottom: 12 }}>
          {name}
          {item.kind === 'graded_slab' && item.grading_company
            ? ` · ${item.grading_company} ${item.grade}`
            : ''}
          {' · '}{item.quantity_available} available
        </p>

        <div className="grid grid-2">
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
            <input
              type="datetime-local" value={soldAt}
              onChange={(e) => setSoldAt(e.target.value)}
            />
          </label>
        </div>

        <div className="grid grid-2">
          <label className="field">
            <span className="label-text">Sale price</span>
            <input
              type="text" inputMode="decimal" value={price} placeholder="0.00"
              onChange={(e) => setPrice(e.target.value)} autoFocus
            />
            <span className="hint">What the buyer paid for the card itself.</span>
          </label>
          <label className="field">
            <span className="label-text">Quantity</span>
            <input
              type="number" min="1" max={maxQty} value={quantity}
              disabled={item.kind === 'graded_slab'}
              onChange={(e) => setQuantity(e.target.value)}
              aria-invalid={tooMany}
            />
            {tooMany && (
              <span className="hint" style={{ color: 'var(--danger)' }}>
                Only {maxQty} available.
              </span>
            )}
          </label>
        </div>

        <details style={{ marginBottom: 10 }}>
          <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
            Fees, shipping and packaging
          </summary>
          <div className="grid grid-2 mt">
            <label className="field">
              <span className="label-text">Shipping charged to buyer</span>
              <input type="text" inputMode="decimal" value={shippingCharged} placeholder="0.00"
                     onChange={(e) => setShippingCharged(e.target.value)} />
            </label>
            <label className="field">
              <span className="label-text">Marketplace fee</span>
              <input type="text" inputMode="decimal" value={marketplaceFee} placeholder="0.00"
                     onChange={(e) => setMarketplaceFee(e.target.value)} />
            </label>
            <label className="field">
              <span className="label-text">Postage you paid</span>
              <input type="text" inputMode="decimal" value={shippingCost} placeholder="0.00"
                     onChange={(e) => setShippingCost(e.target.value)} />
            </label>
            <label className="field">
              <span className="label-text">Packaging</span>
              <input type="text" inputMode="decimal" value={packaging} placeholder="0.00"
                     onChange={(e) => setPackaging(e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span className="label-text">Other costs</span>
            <input type="text" inputMode="decimal" value={otherFee} placeholder="0.00"
                   onChange={(e) => setOtherFee(e.target.value)} />
          </label>
        </details>

        <label className="field">
          <span className="label-text">Note</span>
          <input
            type="text" value={note} placeholder="Optional"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        {/* Live profit preview -------------------------------------------- */}
        {preview && (
          <div className="card card-tight" style={{ background: 'var(--surface-2)' }}>
            <div className="row between">
              <span className="small muted">Gross</span>
              <span className="small mono">{formatMoney(preview.grossCents, item.currency as 'USD')}</span>
            </div>
            <div className="row between">
              <span className="small muted">
                Cost of goods
                {preview.costIncomplete && <span className="badge badge-warn" style={{ marginLeft: 5 }}>unknown</span>}
              </span>
              <span className="small mono">−{formatMoney(preview.costCents, item.currency as 'USD')}</span>
            </div>
            <div className="row between">
              <span className="small muted">
                Fees and shipping
                {feeShare != null && feeShare > 0 && (
                  <span className="dim"> ({feeShare.toFixed(1)}% of gross)</span>
                )}
              </span>
              <span className="small mono">−{formatMoney(preview.feesCents, item.currency as 'USD')}</span>
            </div>
            <div className="row between" style={{
              borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6,
            }}>
              <strong className="small">Net profit</strong>
              <strong
                className="mono"
                style={{ color: preview.netCents >= 0 ? 'var(--ok)' : 'var(--danger)' }}
              >
                {formatMoney(preview.netCents, item.currency as 'USD')}
                {preview.roiPercent != null && (
                  <span className="tiny dim"> · {preview.roiPercent.toFixed(0)}% ROI</span>
                )}
                {marginPercent(preview.netCents, preview.grossCents) != null && (
                  <span className="tiny dim">
                    {' · '}{marginPercent(preview.netCents, preview.grossCents)!.toFixed(0)}% margin
                  </span>
                )}
              </strong>
            </div>
            {preview.costIncomplete && (
              <p className="tiny dim" style={{ margin: '6px 0 0' }}>
                This card has no recorded purchase cost, so profit is shown as if it were
                free. The real figure is lower.
              </p>
            )}
          </div>
        )}

        {error && <div className="note note-danger mt">{error}</div>}

        <div className="row mt">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || priceCents == null || tooMany}
          >
            {busy && <span className="spinner" />} Record sale
          </button>
        </div>
      </div>
    </div>
  );
}
