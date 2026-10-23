/**
 * Sales & Profit.
 *
 * Every figure here comes from recorded transactions. Estimated market value
 * never enters these numbers -- the separation between "what I think it is
 * worth" and "what someone actually paid" is the whole point of the page.
 *
 * Where a figure cannot be computed honestly (ROI with no cost basis, time to
 * sell with no acquisition dates) it shows a dash and says why, rather than
 * a zero that reads like a real result.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  currentUserId, deleteExpense, inventoryAging, listExpenses, listSales, recordExpense,
  salesSummary, voidSale, EXPENSE_CATEGORIES, SALE_CHANNELS,
  type AgingBucket, type ExpenseRow, type SaleFull, type SalesSummary,
} from '../lib/db';
import { formatMoney, parseMoney } from '../lib/money';
import { marginPercent, saleTotals } from '../lib/profit';

type Range = 'all' | '30' | '90' | '365';

function rangeStart(range: Range): string | undefined {
  if (range === 'all') return undefined;
  const d = new Date();
  d.setDate(d.getDate() - Number(range));
  return d.toISOString();
}

const channelLabel = (v: string) =>
  SALE_CHANNELS.find((c) => c.value === v)?.label ?? v;

export default function Sales() {
  const [range, setRange] = useState<Range>('all');
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [sales, setSales] = useState<SaleFull[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [aging, setAging] = useState<AgingBucket[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExpense, setShowExpense] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const from = rangeStart(range);
      const uid = await currentUserId();
      setUserId(uid);
      const [s, list, ex, age] = await Promise.all([
        salesSummary({ from }),
        listSales({ from }),
        listExpenses({ from: from?.slice(0, 10) }),
        inventoryAging(),
      ]);
      setSummary(s);
      setSales(list);
      setExpenses(ex);
      setAging(age);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load sales.');
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const currency = (summary?.currency ?? 'USD') as 'USD';
  const expenseTotal = expenses.reduce((a, e) => a + e.amount_cents, 0);
  // Business profit = trading profit minus overheads that are not tied to a
  // specific card (supplies, travel, equipment).
  const businessNet = (summary?.netProfitCents ?? 0) - expenseTotal;

  return (
    <>
      <div className="section-head">
        <h1>Sales &amp; Profit</h1>
        <div className="seg">
          {([['all', 'All time'], ['365', '1 year'], ['90', '90 days'], ['30', '30 days']] as const)
            .map(([v, l]) => (
              <button key={v} type="button" aria-pressed={range === v} onClick={() => setRange(v)}>
                {l}
              </button>
            ))}
        </div>
      </div>

      {error && <div className="note note-danger">{error}</div>}

      {!summary ? (
        <div className="stats">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 72 }} />)}
        </div>
      ) : summary.saleCount === 0 ? (
        <div className="empty">
          <div className="big">$</div>
          <p style={{ fontWeight: 600, color: 'var(--text)' }}>No sales recorded yet.</p>
          <p className="small">
            Open any inventory item and choose <strong>Record a sale</strong>. Profit,
            ROI and margin are computed from what you actually enter.
          </p>
          <Link className="btn btn-primary btn-sm mt" to="/inventory">Go to inventory</Link>
        </div>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <div className="k">Gross revenue</div>
              <div className="v">{formatMoney(summary.grossRevenueCents, currency)}</div>
              <div className="m">{summary.saleCount} sale{summary.saleCount === 1 ? '' : 's'}</div>
            </div>
            <div className="stat">
              <div className="k">Net profit</div>
              <div className="v" style={{
                color: summary.netProfitCents >= 0 ? 'var(--ok)' : 'var(--danger)',
              }}>
                {formatMoney(summary.netProfitCents, currency)}
              </div>
              <div className="m">
                {marginPercent(summary.netProfitCents, summary.grossRevenueCents) != null
                  ? `${marginPercent(summary.netProfitCents, summary.grossRevenueCents)!.toFixed(1)}% margin`
                  : '—'}
              </div>
            </div>
            <div className="stat">
              <div className="k">Return on investment</div>
              <div className="v">
                {summary.roiPercent != null ? `${summary.roiPercent.toFixed(0)}%` : '—'}
              </div>
              <div className="m">
                {summary.roiPercent != null
                  ? `on ${formatMoney(summary.totalCostCents, currency)} of stock`
                  : 'no cost basis recorded'}
              </div>
            </div>
            <div className="stat">
              <div className="k">Average sale</div>
              <div className="v">{formatMoney(summary.averageSalePriceCents, currency)}</div>
              <div className="m">
                {summary.averageDaysToSell != null
                  ? `${Math.round(summary.averageDaysToSell)} day` +
                    `${Math.round(summary.averageDaysToSell) === 1 ? '' : 's'} to sell`
                  : 'time to sell unknown'}
              </div>
            </div>
          </div>

          {summary.needsReviewCount > 0 && (
            <div className="note note-warn mt">
              <strong>{summary.needsReviewCount} sale
              {summary.needsReviewCount === 1 ? '' : 's'} flagged for review.</strong>{' '}
              Another sale of the same card was recorded within minutes. Check below that
              it is not the same transaction entered twice.
            </div>
          )}

          <div className="card mt">
            <h2>Where the money went</h2>
            <div className="scroll-x">
              <table className="data mt">
                <tbody>
                  <tr>
                    <th>Gross revenue</th>
                    <td className="num">{formatMoney(summary.grossRevenueCents, currency)}</td>
                  </tr>
                  <tr>
                    <th>Cost of cards sold</th>
                    <td className="num">−{formatMoney(summary.totalCostCents, currency)}</td>
                  </tr>
                  <tr>
                    <th>Fees, postage, packaging</th>
                    <td className="num">−{formatMoney(summary.totalFeesCents, currency)}</td>
                  </tr>
                  <tr>
                    <th>Trading profit</th>
                    <td className="num"><strong>{formatMoney(summary.netProfitCents, currency)}</strong></td>
                  </tr>
                  <tr>
                    <th>Business expenses</th>
                    <td className="num">−{formatMoney(expenseTotal, currency)}</td>
                  </tr>
                  <tr>
                    <th>Net after expenses</th>
                    <td className="num">
                      <strong style={{ color: businessNet >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
                        {formatMoney(businessNet, currency)}
                      </strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {summary.byMonth.length > 1 && (
            <div className="card">
              <h2>By month</h2>
              <div className="scroll-x">
                <table className="data mt">
                  <thead>
                    <tr><th>Month</th><th className="num">Sales</th>
                      <th className="num">Revenue</th><th className="num">Net</th></tr>
                  </thead>
                  <tbody>
                    {summary.byMonth.map((m) => (
                      <tr key={m.month}>
                        <td>{m.month}</td>
                        <td className="num">{m.count}</td>
                        <td className="num">{formatMoney(m.revenueCents, currency)}</td>
                        <td className="num" style={{
                          color: m.netCents >= 0 ? 'var(--ok)' : 'var(--danger)',
                        }}>
                          {formatMoney(m.netCents, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="grid grid-2 mt">
            {summary.byChannel.length > 0 && (
              <div className="card" style={{ marginTop: 0 }}>
                <h2>Best marketplace</h2>
                <div className="scroll-x">
                  <table className="data mt">
                    <thead>
                      <tr><th>Channel</th><th className="num">Sales</th><th className="num">Net</th></tr>
                    </thead>
                    <tbody>
                      {summary.byChannel.map((c) => (
                        <tr key={c.channel}>
                          <td>{channelLabel(c.channel)}</td>
                          <td className="num">{c.count}</td>
                          <td className="num">{formatMoney(c.netCents, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {summary.byGame.length > 0 && (
              <div className="card" style={{ marginTop: 0 }}>
                <h2>Best category</h2>
                <div className="scroll-x">
                  <table className="data mt">
                    <thead>
                      <tr><th>Game</th><th className="num">Sales</th><th className="num">Net</th></tr>
                    </thead>
                    <tbody>
                      {summary.byGame.map((g) => (
                        <tr key={g.game}>
                          <td>{g.game}</td>
                          <td className="num">{g.count}</td>
                          <td className="num">{formatMoney(g.netCents, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="tiny dim" style={{ marginTop: 6, marginBottom: 0 }}>
                  Only single-card sales are attributed to a game. Splitting a multi-card
                  sale would mean guessing how to allocate the fees.
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {/* Aging ---------------------------------------------------------- */}
      {aging.some((b) => b.itemCount > 0) && (
        <div className="card">
          <h2>Unsold inventory aging</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            How long stock you still hold has been sitting, by what you paid for it.
          </p>
          <div className="scroll-x">
            <table className="data mt">
              <thead>
                <tr><th>Age</th><th className="num">Items</th><th className="num">Cost tied up</th></tr>
              </thead>
              <tbody>
                {aging.map((b) => (
                  <tr key={b.label}>
                    <td>{b.label}</td>
                    <td className="num">{b.itemCount}</td>
                    <td className="num">{formatMoney(b.costCents, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Sales list ------------------------------------------------------ */}
      {sales.length > 0 && (
        <div className="card">
          <h2>Recorded sales</h2>
          <div className="stack mt" style={{ gap: 7 }}>
            {sales.map((sale) => {
              const t = saleTotals(sale, sale.items);
              return (
                <div key={sale.id} className="card card-tight" style={{ marginTop: 0 }}>
                  <div className="row between">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 620, fontSize: '0.88rem' }}>
                        {sale.items.map((i) => i.card_name ?? 'Unidentified').join(', ') || '—'}
                      </div>
                      <div className="tiny muted">
                        {new Date(sale.sold_at).toLocaleDateString()}
                        {' · '}{channelLabel(sale.channel)}
                        {sale.items[0]?.grading_company
                          && ` · ${sale.items[0].grading_company} ${sale.items[0].grade}`}
                      </div>
                    </div>
                    <div className="right nowrap">
                      <div style={{ fontWeight: 650 }}>
                        {formatMoney(t.grossCents, currency)}
                      </div>
                      <div className="tiny" style={{
                        color: t.netCents >= 0 ? 'var(--ok)' : 'var(--danger)',
                      }}>
                        {formatMoney(t.netCents, currency)} net
                      </div>
                    </div>
                  </div>

                  {sale.needs_review && (
                    <div className="note note-warn" style={{ marginTop: 7 }}>
                      {sale.review_reason}
                    </div>
                  )}

                  <div className="row" style={{ marginTop: 7 }}>
                    {t.costIncomplete && (
                      <span className="badge badge-warn">cost unknown</span>
                    )}
                    <div className="spacer" style={{ flex: 1 }} />
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={async () => {
                        if (!userId) return;
                        if (!confirm(
                          'Void this sale and return the stock to inventory? ' +
                          'The movement history is kept.'
                        )) return;
                        await voidSale(sale.id, userId);
                        load();
                      }}
                    >
                      Void
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Expenses -------------------------------------------------------- */}
      <div className="card">
        <div className="section-head" style={{ marginBottom: 6 }}>
          <h2>Business expenses</h2>
          <button className="btn btn-sm" onClick={() => setShowExpense(true)}>+ Add</button>
        </div>
        <p className="small muted" style={{ marginTop: 0 }}>
          Costs not tied to a specific card — sleeves, mailers, table fees, travel.
        </p>

        {expenses.length === 0 ? (
          <p className="small dim">None recorded in this period.</p>
        ) : (
          <div className="scroll-x">
            <table className="data mt">
              <thead>
                <tr><th>Date</th><th>Category</th><th>Description</th>
                  <th className="num">Amount</th><th /></tr>
              </thead>
              <tbody>
                {expenses.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{e.incurred_on}</td>
                    <td>{e.category}</td>
                    <td>{e.description ?? '—'}</td>
                    <td className="num">{formatMoney(e.amount_cents, currency)}</td>
                    <td>
                      <button
                        className="btn btn-ghost btn-sm"
                        aria-label="Delete expense"
                        onClick={async () => { await deleteExpense(e.id); load(); }}
                      >×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showExpense && userId && (
        <ExpenseDialog
          userId={userId}
          currency={currency}
          onClose={() => setShowExpense(false)}
          onSaved={() => { setShowExpense(false); load(); }}
        />
      )}
    </>
  );
}

function ExpenseDialog({
  userId, currency, onClose, onSaved,
}: {
  userId: string; currency: string; onClose: () => void; onSaved: () => void;
}) {
  const [incurredOn, setIncurredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState<string>('supplies');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = parseMoney(amount);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add an expense</h2>

        <div className="grid grid-2 mt">
          <label className="field">
            <span className="label-text">Date</span>
            <input type="date" value={incurredOn} onChange={(e) => setIncurredOn(e.target.value)} />
          </label>
          <label className="field">
            <span className="label-text">Amount</span>
            <input
              type="text" inputMode="decimal" value={amount} placeholder="0.00"
              onChange={(e) => setAmount(e.target.value)} autoFocus
            />
          </label>
        </div>

        <label className="field">
          <span className="label-text">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>

        <label className="field">
          <span className="label-text">Description</span>
          <input
            type="text" value={description} placeholder="e.g. 500 penny sleeves"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

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
                await recordExpense({
                  incurredOn, category, description: description || null,
                  currency, amountCents: cents,
                }, userId);
                onSaved();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not save that expense.');
                setBusy(false);
              }
            }}
          >
            {busy && <span className="spinner" />} Save expense
          </button>
        </div>
      </div>
    </div>
  );
}
